import { Database as SQLite } from "bun:sqlite";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import writeAtomic from "write-file-atomic";
import { throwIfAborted, type Json } from "@themelios/core";
import { z } from "zod";
import { failure } from "./failure.js";
import type { InstancePaths } from "./paths.js";

export type Endpoints = Readonly<Record<string, string>>;
const ownerSchema = z.object({
  ownerPid: z.int().positive(),
  startedAt: z.iso.datetime(),
  endpoints: z.record(z.string(), z.string()).optional(),
});

export interface OwnedLock {
  endpoints(value: Endpoints): Promise<void>;
  close(): Promise<void>;
}

function isBusyError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  return (
    code === "SQLITE_BUSY" ||
    /SQLITE_BUSY|database is locked/i.test(String(error))
  );
}

function acquireSqliteExclusive(path: string): SQLite | undefined {
  let db: SQLite | undefined;
  try {
    db = new SQLite(path, { create: true });
    db.exec(
      "PRAGMA journal_mode = DELETE; PRAGMA locking_mode = EXCLUSIVE; PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS lock_holder (id INTEGER PRIMARY KEY); REPLACE INTO lock_holder (id) VALUES (1);",
    );
    return db;
  } catch (error) {
    try {
      db?.close(true);
    } catch {
      /* Ignore cleanup errors after lock rejection. */
    }
    if (isBusyError(error)) return undefined;
    throw failure("runtime.lock_failed", { path }, error);
  }
}

export async function openInstanceLock(
  paths: InstancePaths,
  instanceId?: string,
  signal?: AbortSignal,
): Promise<OwnedLock> {
  throwIfAborted(signal);
  const path = join(paths.run, "instance.lock");
  const ownerPath = join(paths.run, "owner.json");
  const handle = acquireSqliteExclusive(path);
  if (!handle) {
    let owner: z.infer<typeof ownerSchema> | undefined;
    try {
      owner = ownerSchema.safeParse(
        JSON.parse(await readFile(ownerPath, "utf8")),
      ).data;
    } catch {
      /* The OS lock is authoritative even before owner.json is written. */
    }
    throw failure(
      "runtime.instance_busy",
      {
        ...(instanceId ? { instanceId } : {}),
        ...owner,
      } as Json,
      undefined,
      true,
    );
  }
  const owner = { ownerPid: process.pid, startedAt: new Date().toISOString() };
  let writes = Promise.resolve();
  let closing: Promise<void> | undefined;
  const writeOwner = async (endpoints?: Endpoints) => {
    try {
      await writeAtomic(
        ownerPath,
        JSON.stringify({ ...owner, ...(endpoints ? { endpoints } : {}) }) +
          "\n",
      );
    } catch (error) {
      throw failure("runtime.owner_failed", { path: ownerPath }, error);
    }
  };
  const releaseHandle = () => {
    try {
      handle.exec("ROLLBACK; PRAGMA locking_mode = NORMAL;");
    } catch {
      /* Connection may already be outside a transaction on early abort. */
    } finally {
      handle.close(true);
    }
  };
  try {
    throwIfAborted(signal);
    await writeOwner();
    throwIfAborted(signal);
  } catch (error) {
    try {
      await rm(ownerPath, { force: true });
    } finally {
      releaseHandle();
    }
    throw error;
  }
  return {
    endpoints(value) {
      if (closing)
        return Promise.reject(failure("runtime.closed", { state: "closing" }));
      const update = writes.then(() => writeOwner(value));
      writes = update.catch(() => undefined);
      return update;
    },
    close() {
      closing ??= writes.then(async () => {
        try {
          await rm(ownerPath, { force: true });
        } finally {
          releaseHandle();
        }
      });
      return closing;
    },
  };
}
