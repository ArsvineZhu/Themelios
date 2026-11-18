import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { AppError, commitPointSchema } from "@themelios/core";
import { instantSchema } from "@themelios/core/time";
import { z } from "zod";
import { copyConfiguration, existing, removeStaging } from "./backup-files.js";
import { Cas } from "./cas.js";
import { Database } from "./database.js";
import { fileErrorCode, storageError } from "./errors.js";
import { stageFile, syncParent, writeChunk } from "./files.js";
import {
  readInventory,
  verifyDatabase,
  verifyObject,
  type BackupInfo,
} from "./maintenance.js";

const installationFile = "installation-config.toml";
const instanceFile = "instance.json";
const manifestFile = "backup.json";
const databaseFile = join("state", "main.sqlite");

const instanceSchema = z.looseObject({
  id: z.string().min(1),
  applicationId: z.string().min(1),
  formatId: z.string().min(1),
});
const installationConfigSchema = z.discriminatedUnion("present", [
  z.strictObject({ present: z.literal(false) }),
  z.strictObject({
    present: z.literal(true),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);
const manifestSchema = z.strictObject({
  format: z.literal("themelios.backup/1"),
  applicationId: z.string().min(1),
  instanceId: z.string().min(1),
  formatId: z.string().min(1),
  cut: commitPointSchema,
  createdAt: instantSchema,
  artifacts: z.int().nonnegative(),
  blobs: z.int().nonnegative(),
  bytes: z.int().nonnegative(),
  installationConfig: installationConfigSchema,
});

export type BackupManifest = z.infer<typeof manifestSchema>;

export interface BackupOptions {
  database: Database;
  cas: Cas;
  destination: string;
  applicationId: string;
  instanceId: string;
  formatId: string;
  instanceRoot: string;
  installationConfigPath?: string;
  paths?: string[];
}

export interface RestoreOptions {
  backup: string;
  destination: string;
  applicationId: string;
  formatId: string;
  installationConfigPath?: string;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readRegular(path: string): Promise<Buffer | undefined> {
  const info = await existing(path);
  if (!info) return undefined;
  if (!info.isFile())
    throw storageError("storage.backup_invalid", {
      path,
      reason: "expected a regular file",
    });
  return readFile(path);
}

async function readRecord<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const data = await readRegular(path);
  if (data === undefined)
    throw storageError("storage.backup_invalid", {
      path,
      reason: "required metadata file is missing",
    });
  try {
    return schema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)),
    );
  } catch (error) {
    throw storageError(
      "storage.backup_invalid",
      { path, reason: String(error) },
      error,
    );
  }
}

function checkIdentity(
  actual: { id: string; applicationId: string; formatId: string },
  expected: { instanceId: string; applicationId: string; formatId: string },
): void {
  if (actual.applicationId !== expected.applicationId) {
    throw storageError("runtime.application_mismatch", {
      expected: expected.applicationId,
      actual: actual.applicationId,
    });
  }
  if (actual.formatId !== expected.formatId) {
    throw storageError("storage.format_mismatch", {
      expected: expected.formatId,
      actual: actual.formatId,
    });
  }
  if (actual.id !== expected.instanceId) {
    throw storageError("storage.backup_invalid", {
      expected: expected.instanceId,
      actual: actual.id,
      reason: "instance identity mismatch",
    });
  }
}

async function requireNew(
  destination: string,
  operation: string,
): Promise<void> {
  if (await existing(destination))
    throw storageError("storage.already_exists", {
      operation,
      path: destination,
    });
}

function separateTrees(
  source: string,
  destination: string,
  operation: string,
): void {
  const path = relative(resolve(source), destination);
  if (
    !path ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  ) {
    throw storageError("storage.backup_invalid", {
      operation,
      path: destination,
      reason: "destination overlaps the source directory",
    });
  }
}

async function workspace(
  destination: string,
  operation: string,
): Promise<string> {
  await requireNew(destination, operation);
  await mkdir(dirname(destination), { recursive: true });
  const staging = join(
    dirname(destination),
    `.${basename(destination)}-${randomUUID()}.partial`,
  );
  await mkdir(staging, { mode: 0o700 });
  return staging;
}

async function publish(
  staging: string,
  destination: string,
  operation: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    await requireNew(destination, operation);
    try {
      await rename(staging, destination);
      return;
    } catch (error) {
      await requireNew(destination, operation);
      // Windows can briefly deny renaming a just-written tree even after our handles are closed.
      if (
        process.platform !== "win32" ||
        fileErrorCode(error) !== "EPERM" ||
        attempt === 5
      )
        throw error;
      await Bun.sleep(15 * 2 ** attempt);
    }
  }
}

/** Creates a portable snapshot while the caller holds the source's offline instance lock. */
export async function backupStorage(
  options: BackupOptions,
): Promise<BackupManifest> {
  const destination = resolve(options.destination);
  separateTrees(options.instanceRoot, destination, "backup");
  try {
    const staging = await workspace(destination, "backup");
    await mkdir(join(staging, "state"));
    options.database.snapshot(join(staging, databaseFile));
    const snapshot = Database.open({
      path: join(staging, databaseFile),
      formatId: options.formatId,
      readonly: true,
    });
    let captured: ReturnType<typeof readInventory>;
    try {
      captured = readInventory(snapshot);
      verifyDatabase(snapshot);
    } finally {
      snapshot.close();
    }
    for (const record of captured.records)
      await verifyObject(options.cas, record, join(staging, "objects"));
    await copyConfiguration(options.instanceRoot, staging, options.paths);
    const identity = await readRecord(
      join(staging, instanceFile),
      instanceSchema,
    );
    checkIdentity(identity, options);
    const stats: BackupInfo = {
      ...captured.inventory,
      createdAt: new Date().toISOString(),
    };
    const installation = options.installationConfigPath
      ? await readRegular(options.installationConfigPath)
      : undefined;
    if (installation)
      await writeFile(join(staging, installationFile), installation, {
        flag: "wx",
        mode: 0o600,
      });
    const manifest: BackupManifest = {
      ...stats,
      format: "themelios.backup/1",
      applicationId: options.applicationId,
      instanceId: options.instanceId,
      installationConfig: installation
        ? { present: true, sha256: digest(installation) }
        : { present: false },
    };
    await writeFile(
      join(staging, manifestFile),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await publish(staging, destination, "backup");
    return manifest;
  } catch (error) {
    throw maintenanceError("backup", destination, error);
  }
}

async function copyData(
  backup: string,
  staging: string,
  manifest: BackupManifest,
): Promise<void> {
  const original = join(backup, databaseFile);
  const state = await existing(join(backup, "state"));
  if (!state?.isDirectory() || !(await existing(original))?.isFile()) {
    throw storageError("storage.backup_invalid", {
      path: original,
      reason: "required database file is missing",
    });
  }
  const snapshot = Database.open({
    path: original,
    formatId: manifest.formatId,
    readonly: true,
  });
  let captured: ReturnType<typeof readInventory>;
  try {
    verifyDatabase(snapshot);
    captured = readInventory(snapshot);
  } finally {
    snapshot.close();
  }
  for (const field of ["cut", "artifacts", "blobs", "bytes"] as const) {
    if (captured.inventory[field] !== manifest[field]) {
      throw storageError("storage.backup_invalid", {
        field,
        expected: manifest[field],
        actual: captured.inventory[field],
      });
    }
  }
  await mkdir(join(staging, "state"));
  await copyFile(
    original,
    join(staging, databaseFile),
    constants.COPYFILE_EXCL,
  );
  const source = await Cas.open(join(backup, "objects"));
  try {
    for (const record of captured.records)
      await verifyObject(source, record, join(staging, "objects"));
  } finally {
    await source.close();
  }
}

async function installationConfig(
  backup: string,
  manifest: BackupManifest,
  destination?: string,
): Promise<(() => Promise<void>) | undefined> {
  const archived = await readRegular(join(backup, installationFile));
  const expected = manifest.installationConfig;
  if (
    expected.present !== (archived !== undefined) ||
    (expected.present && expected.sha256 !== digest(archived!))
  ) {
    throw storageError("storage.backup_invalid", {
      path: join(backup, installationFile),
      reason: "installation configuration does not match the manifest",
    });
  }
  const current = destination ? await readRegular(destination) : undefined;
  if (current) {
    if (archived && current.equals(archived)) return undefined;
    throw storageError("config.invalid", {
      path: destination!,
      reason: "installation configuration differs from the backup",
    });
  }
  if (!archived) return undefined;
  if (!destination)
    throw storageError("config.invalid", {
      reason: "specify the destination installation configuration path",
    });

  await mkdir(dirname(destination), { recursive: true });
  const created = await stageFile(
    dirname(destination),
    async (file) => {
      await writeChunk(file, archived);
      return file.stat({ bigint: true });
    },
    async (path) => {
      try {
        await link(path, destination);
      } catch (error) {
        if (fileErrorCode(error) === "EEXIST")
          throw storageError("config.invalid", {
            path: destination,
            reason: "installation configuration appeared during restore",
          });
        throw error;
      }
      await syncParent(destination);
    },
  );
  return async () => {
    const latest = await existing(destination);
    if (
      latest &&
      BigInt(latest.dev) === created.dev &&
      BigInt(latest.ino) === created.ino &&
      (await readRegular(destination))?.equals(archived)
    ) {
      await unlink(destination);
    }
  };
}

/** Verifies the backup before publishing a new instance directory or altering installation configuration. */
export async function restoreStorage(
  options: RestoreOptions,
): Promise<BackupManifest> {
  const destination = resolve(options.destination);
  const backup = resolve(options.backup);
  separateTrees(backup, destination, "restore");
  let staging: string | undefined;
  let rollbackConfig: (() => Promise<void>) | undefined;
  try {
    await requireNew(destination, "restore");
    const manifest = await readRecord(
      join(backup, manifestFile),
      manifestSchema,
    );
    const identity = await readRecord(
      join(backup, instanceFile),
      instanceSchema,
    );
    checkIdentity(identity, { ...options, instanceId: manifest.instanceId });
    checkIdentity(
      { ...manifest, id: manifest.instanceId },
      { ...options, instanceId: identity.id },
    );
    staging = await workspace(destination, "restore");
    await copyData(backup, staging, manifest);
    await copyConfiguration(backup, staging);
    for (const name of ["cache", "logs", "run", "objects"])
      await mkdir(join(staging, name), { recursive: true });
    rollbackConfig = await installationConfig(
      backup,
      manifest,
      options.installationConfigPath,
    );
    await publish(staging, destination, "restore");
    return manifest;
  } catch (error) {
    await Promise.allSettled([
      rollbackConfig?.(),
      staging && removeStaging(staging),
    ]);
    throw maintenanceError("restore", destination, error);
  }
}

function maintenanceError(
  operation: string,
  path: string,
  error: unknown,
): AppError {
  return error instanceof AppError
    ? error
    : storageError(
        "storage.write_failed",
        { operation, path, reason: String(error) },
        error,
      );
}
