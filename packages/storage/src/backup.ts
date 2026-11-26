import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  AppError,
  appError,
  blobDigestAlgorithm,
  blobDigestHexSchema,
  commitPointSchema,
  errorCode,
  instanceDirectories,
  instanceManifestFile,
  instanceManifestSchema,
  throwIfAborted,
  type InstanceManifest,
} from "@themelios/core";
import {
  publishNewFile,
  stageFile,
  tryExclusiveFileLock,
} from "@themelios/core/files";
import { instantSchema } from "@themelios/core/time";
import { z } from "zod";
import {
  copyBackupFile,
  copyConfiguration,
  defaultBackupPaths,
  existing,
  removeStaging,
} from "./backup-files.js";
import { Cas } from "./cas.js";
import { Database, databaseFileName } from "./database.js";
import { syncParent, writeChunk } from "./files.js";
import {
  readInventory,
  verifyDatabase,
  verifyObject,
  type BackupInfo,
} from "./maintenance.js";

const installationFile = "installation-config.toml";
const manifestFile = "backup.json";
const backupFormat = "themelios.backup";
const databaseFile = join(instanceDirectories.state, databaseFileName);

const installationConfigSchema = z.discriminatedUnion("present", [
  z.strictObject({ present: z.literal(false) }),
  z.strictObject({
    present: z.literal(true),
    sha256: blobDigestHexSchema,
  }),
]);
const manifestSchema = z.strictObject({
  format: z.literal(backupFormat),
  applicationId: z.string().min(1),
  instanceId: z.string().min(1),
  formatId: z.string().min(1),
  cut: commitPointSchema,
  createdAt: instantSchema,
  blobs: z.int().nonnegative(),
  bytes: z.int().nonnegative(),
  instancePaths: z.array(z.string()),
  installationConfig: installationConfigSchema,
});

export type BackupManifest = z.infer<typeof manifestSchema>;

export interface BackupOptions {
  destination: string;
  instanceRoot: string;
  installationConfigPath?: string;
  /** Explicit instance-relative configuration paths under config/. */
  paths?: readonly string[];
  signal?: AbortSignal;
}

export interface RestoreOptions {
  backup: string;
  destination: string;
  applicationId: string;
  formatId: string;
  installationConfigPath?: string;
  signal?: AbortSignal;
}

function digest(bytes: Uint8Array): string {
  return createHash(blobDigestAlgorithm).update(bytes).digest("hex");
}

async function readRegular(
  path: string,
  signal?: AbortSignal,
): Promise<Buffer | undefined> {
  throwIfAborted(signal);
  const info = await existing(path);
  if (!info) return undefined;
  if (!info.isFile())
    throw appError("storage.backup_invalid", {
      details: {
        path,
        reason: "expected a regular file",
      },
    });
  return readFile(path, signal ? { signal } : undefined);
}

async function readRecord<T>(
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const data = await readRegular(path, signal);
  if (data === undefined)
    throw appError("storage.backup_invalid", {
      details: {
        path,
        reason: "required metadata file is missing",
      },
    });
  try {
    return schema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)),
    );
  } catch (error) {
    throw appError("storage.backup_invalid", {
      details: { path, reason: String(error) },
      cause: error,
    });
  }
}

type ApplicationIdentity = Pick<InstanceManifest, "applicationId" | "formatId">;

function checkApplicationIdentity(
  actual: ApplicationIdentity,
  expected: ApplicationIdentity,
): void {
  if (actual.applicationId !== expected.applicationId) {
    throw appError("runtime.application_mismatch", {
      details: {
        expected: expected.applicationId,
        actual: actual.applicationId,
      },
    });
  }
  if (actual.formatId !== expected.formatId) {
    throw appError("storage.format_mismatch", {
      details: {
        expected: expected.formatId,
        actual: actual.formatId,
      },
    });
  }
}

function checkInstanceIdentity(
  actual: InstanceManifest,
  expected: BackupManifest,
): void {
  checkApplicationIdentity(actual, expected);
  if (actual.id !== expected.instanceId) {
    throw appError("storage.backup_invalid", {
      details: {
        expected: expected.instanceId,
        actual: actual.id,
        reason: "instance identity mismatch",
      },
    });
  }
}

function readSnapshotInventory(path: string, formatId: string) {
  const snapshot = Database.open({ path, formatId, readonly: true });
  try {
    verifyDatabase(snapshot);
    return readInventory(snapshot);
  } finally {
    snapshot.close();
  }
}

async function requireNew(
  destination: string,
  operation: string,
): Promise<void> {
  if (await existing(destination))
    throw appError("storage.already_exists", {
      details: {
        operation,
        path: destination,
      },
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
    throw appError("storage.backup_invalid", {
      details: {
        operation,
        path: destination,
        reason: "destination overlaps the source directory",
      },
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
  signal?: AbortSignal,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    await requireNew(destination, operation);
    throwIfAborted(signal);
    try {
      await rename(staging, destination);
      return;
    } catch (error) {
      await requireNew(destination, operation);
      // Windows can briefly deny renaming a just-written tree even after our handles are closed.
      if (
        process.platform !== "win32" ||
        errorCode(error) !== "EPERM" ||
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
  const { signal, instanceRoot } = options;
  throwIfAborted(signal);
  separateTrees(instanceRoot, destination, "backup");
  let staging: string | undefined;
  try {
    staging = await workspace(destination, "backup");
    const instancePaths = await copyConfiguration(
      instanceRoot,
      staging,
      options.paths ?? defaultBackupPaths,
      { required: options.paths !== undefined, ...(signal ? { signal } : {}) },
    );
    const identity = await readRecord(
      join(staging, instanceManifestFile),
      instanceManifestSchema,
      signal,
    );
    await mkdir(join(staging, instanceDirectories.state));
    throwIfAborted(signal);
    const path = join(staging, databaseFile);
    const database = Database.open({
      path: join(instanceRoot, databaseFile),
      formatId: identity.formatId,
      readonly: true,
    });
    try {
      database.snapshot(path);
    } finally {
      database.close();
    }
    const captured = readSnapshotInventory(path, identity.formatId);
    const cas = await Cas.open(join(instanceRoot, instanceDirectories.objects));
    try {
      for (const record of captured.records)
        await verifyObject(
          cas,
          record,
          signal,
          join(staging, instanceDirectories.objects),
        );
    } finally {
      await cas.close();
    }
    const stats: BackupInfo = {
      ...captured.inventory,
      createdAt: new Date().toISOString(),
    };
    const installation = options.installationConfigPath
      ? await readRegular(options.installationConfigPath, signal)
      : undefined;
    if (installation)
      await writeFile(join(staging, installationFile), installation, {
        flag: "wx",
        mode: 0o600,
        flush: true,
        ...(signal ? { signal } : {}),
      });
    const manifest: BackupManifest = {
      ...stats,
      format: backupFormat,
      applicationId: identity.applicationId,
      instanceId: identity.id,
      instancePaths,
      installationConfig: installation
        ? { present: true, sha256: digest(installation) }
        : { present: false },
    };
    await writeFile(
      join(staging, manifestFile),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: "wx", mode: 0o600, flush: true, ...(signal ? { signal } : {}) },
    );
    await publish(staging, destination, "backup", signal);
    return manifest;
  } catch (error) {
    if (staging) await removeStaging(staging).catch(() => undefined);
    throwIfAborted(signal);
    throw maintenanceError("backup", destination, error);
  }
}

async function copyData(
  backup: string,
  staging: string,
  manifest: BackupManifest,
  signal?: AbortSignal,
): Promise<void> {
  const original = join(backup, databaseFile);
  const state = await existing(join(backup, instanceDirectories.state));
  if (!state?.isDirectory() || !(await existing(original))?.isFile()) {
    throw appError("storage.backup_invalid", {
      details: {
        path: original,
        reason: "required database file is missing",
      },
    });
  }
  await mkdir(join(staging, instanceDirectories.state));
  const copied = join(staging, databaseFile);
  await copyBackupFile(original, copied, signal);
  throwIfAborted(signal);
  const captured = readSnapshotInventory(copied, manifest.formatId);
  for (const field of ["cut", "blobs", "bytes"] as const) {
    if (captured.inventory[field] !== manifest[field]) {
      throw appError("storage.backup_invalid", {
        details: {
          field,
          expected: manifest[field],
          actual: captured.inventory[field],
        },
      });
    }
  }
  const source = await Cas.open(join(backup, instanceDirectories.objects));
  try {
    for (const record of captured.records)
      await verifyObject(
        source,
        record,
        signal,
        join(staging, instanceDirectories.objects),
      );
  } finally {
    await source.close();
  }
}

async function readArchivedConfig(
  backup: string,
  manifest: BackupManifest,
  signal?: AbortSignal,
): Promise<Buffer | undefined> {
  const path = join(backup, installationFile);
  const archived = await readRegular(path, signal);
  const expected = manifest.installationConfig.present
    ? manifest.installationConfig.sha256
    : undefined;
  if (expected !== (archived === undefined ? undefined : digest(archived))) {
    throw appError("storage.backup_invalid", {
      details: {
        path,
        reason: "installation configuration does not match the manifest",
      },
    });
  }
  return archived;
}

function requireMatchingConfig(
  path: string,
  archived: Buffer | undefined,
  current: Buffer,
): void {
  if (!archived?.equals(current))
    throw appError("config.invalid", {
      details: {
        path,
        reason: "installation configuration differs from the backup",
      },
    });
}

async function publishRestoredInstance(
  staging: string,
  destination: string,
  archived: Buffer | undefined,
  configureAt: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (!configureAt) {
    if (archived) {
      throw appError("config.invalid", {
        details: {
          reason: "specify the destination installation configuration path",
        },
      });
    }
    return publish(staging, destination, "restore", signal);
  }
  const path = resolve(configureAt);
  const directory = dirname(path);
  const lockPath = join(directory, `.${basename(path)}.restore.lock`);
  const preexisting = await readRegular(path, signal);
  // A configuration created by restore always has a persistent coordination file.
  if (preexisting && !(await existing(lockPath))) {
    requireMatchingConfig(path, archived, preexisting);
    return publish(staging, destination, "restore", signal);
  }

  await mkdir(directory, { recursive: true });
  const release = await waitForRestoreLock(lockPath, signal);
  try {
    const current = await readRegular(path, signal);
    if (current) requireMatchingConfig(path, archived, current);
    if (!archived || current)
      return await publish(staging, destination, "restore", signal);

    await stageFile(
      directory,
      (file) => writeChunk(file, archived, signal),
      (temporary) => {
        throwIfAborted(signal);
        publishNewFile(temporary, path);
      },
    );
    try {
      await syncParent(path);
      await publish(staging, destination, "restore", signal);
    } catch (cause) {
      await removeUnchangedConfig(path, archived).catch(() => undefined);
      throw cause;
    }
  } finally {
    release();
  }
}

async function waitForRestoreLock(
  path: string,
  signal?: AbortSignal,
): Promise<() => void> {
  for (;;) {
    throwIfAborted(signal);
    const release = tryExclusiveFileLock(path);
    if (release) return release;
    await Bun.sleep(25);
  }
}

async function removeUnchangedConfig(
  path: string,
  archived: Buffer,
): Promise<void> {
  if ((await readRegular(path))?.equals(archived)) await unlink(path);
}

/** Verifies the backup before publishing a new instance directory or altering installation configuration. */
export async function restoreStorage(
  options: RestoreOptions,
): Promise<BackupManifest> {
  const destination = resolve(options.destination);
  const backup = resolve(options.backup);
  const { signal } = options;
  throwIfAborted(signal);
  separateTrees(backup, destination, "restore");
  let staging: string | undefined;
  try {
    await requireNew(destination, "restore");
    const manifest = await readRecord(
      join(backup, manifestFile),
      manifestSchema,
      signal,
    );
    checkApplicationIdentity(manifest, options);
    const archivedConfig = await readArchivedConfig(backup, manifest, signal);
    staging = await workspace(destination, "restore");
    await copyConfiguration(backup, staging, manifest.instancePaths, {
      required: true,
      ...(signal ? { signal } : {}),
    });
    const identity = await readRecord(
      join(staging, instanceManifestFile),
      instanceManifestSchema,
      signal,
    );
    checkInstanceIdentity(identity, manifest);
    await copyData(backup, staging, manifest, signal);
    const { cache, logs, run, objects } = instanceDirectories;
    for (const name of [cache, logs, run, objects])
      await mkdir(join(staging, name), { recursive: true });
    await publishRestoredInstance(
      staging,
      destination,
      archivedConfig,
      options.installationConfigPath,
      signal,
    );
    return manifest;
  } catch (error) {
    if (staging) await removeStaging(staging).catch(() => undefined);
    throwIfAborted(signal);
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
    : appError("storage.write_failed", {
        details: { operation, path, reason: String(error) },
        cause: error,
      });
}
