import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  appError,
  errorCode,
  throwIfAborted,
  streamChunks,
  type BlobRef,
  type CommitPoint,
  type Instant,
} from "@themelios/core";
import { type BlobInfo, type Cas, objectPath } from "./cas.js";
import type { Database } from "./database.js";
import { writeChunk } from "./files.js";
import {
  resolveCut,
  synchronousResult,
  type ReadSql,
  type WriteTransaction,
} from "./transaction.js";

export interface StorageInventory {
  formatId: string;
  cut: CommitPoint;
  blobs: number;
  bytes: number;
}

export interface BackupInfo extends StorageInventory {
  createdAt: Instant;
}

export interface CollectionReport {
  historyFloor: CommitPoint;
  removedBlobs: number;
  reclaimedBytes: number;
  sweepComplete: boolean;
  problems: readonly { path: string; reason: string }[];
}

type CollectionProblem = CollectionReport["problems"][number];

interface BlobRecord {
  ref: BlobRef;
  size_bytes: bigint;
}

export interface CollectionOptions {
  retainSince?: CommitPoint;
  signal?: AbortSignal;
  /** Delete expired application rows in the same transaction as the history floor advances. */
  prune?: (tx: WriteTransaction, floor: bigint) => void;
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function referencedBlobs(sql: ReadSql): Map<BlobRef, BlobInfo> {
  // The owning rows are authoritative. A foreign key can use any table and column name.
  const owners = sql
    .query<{ table_name: string; column_name: string }>(
      `
    SELECT DISTINCT s.name AS table_name, fk."from" AS column_name
    FROM main.sqlite_schema s JOIN pragma_foreign_key_list(s.name, 'main') fk
    WHERE s.type = 'table' AND fk."table" = 'blobs' COLLATE NOCASE
      AND (fk."to" IS NULL OR fk."to" = 'ref' COLLATE NOCASE)
    `,
    )
    .all();
  const records = new Map<BlobRef, BlobInfo>();
  for (const { table_name, column_name } of owners) {
    const table = quoteIdentifier(table_name);
    const column = quoteIdentifier(column_name);
    const rows = sql
      .query<BlobRecord>(
        `SELECT DISTINCT b.ref, b.size_bytes FROM main.${table} o
       JOIN main.blobs b ON b.ref = o.${column}`,
      )
      .iterate();
    for (const { ref, size_bytes } of rows)
      records.set(ref, { ref, sizeBytes: Number(size_bytes) });
  }
  return records;
}

export function readInventory(database: Database) {
  return database.read((tx) => {
    const { format_id: formatId } = tx.sql
      .query<{ format_id: string }>(
        "SELECT format_id FROM store_meta WHERE singleton = 1",
      )
      .get()!;
    const records = [...referencedBlobs(tx.sql).values()].sort((a, b) =>
      a.ref.localeCompare(b.ref),
    );
    const inventory: StorageInventory = {
      formatId,
      cut: tx.cut.toString(),
      blobs: records.length,
      bytes: records.reduce((total, record) => total + record.sizeBytes, 0),
    };
    return { inventory, records };
  });
}

export function verifyDatabase(database: Database): void {
  database.read((tx) => {
    const quick = tx.sql
      .query<{ quick_check: string }>("PRAGMA quick_check")
      .all();
    const foreign = tx.sql
      .query<{ table: string; parent: string }>("PRAGMA foreign_key_check")
      .all();
    if (
      quick.length !== 1 ||
      quick[0]?.quick_check !== "ok" ||
      foreign.length
    ) {
      throw appError("storage.database_corrupt", {
        details: {
          quickCheck: quick.map((row) => row.quick_check),
          foreignKeyCheck: foreign.map((row) => ({
            table: row.table,
            parent: row.parent,
          })),
        },
      });
    }
  });
}

export async function verifyObject(
  cas: Cas,
  record: BlobInfo,
  signal?: AbortSignal,
  stagingObjects?: string,
): Promise<void> {
  throwIfAborted(signal);
  const current = await cas.stat(record.ref);
  if (current.sizeBytes !== record.sizeBytes) {
    throw appError("storage.blob_corrupt", {
      details: {
        blobRef: record.ref,
        expected: record.sizeBytes,
        actual: current.sizeBytes,
      },
    });
  }
  const path =
    stagingObjects === undefined
      ? undefined
      : objectPath(stagingObjects, record.ref);
  if (path) await mkdir(dirname(path), { recursive: true });
  // In a private backup/restore directory the enclosing rename publishes the bytes.
  const target = path ? await open(path, "wx", 0o600) : undefined;
  const hash = createHash("sha256");
  let sizeBytes = 0;
  try {
    const stream = await cas.read(record.ref, signal ? { signal } : undefined);
    for await (const bytes of streamChunks(stream, signal)) {
      hash.update(bytes);
      sizeBytes += bytes.byteLength;
      if (target) await writeChunk(target, bytes, signal);
    }
    throwIfAborted(signal);
    await target?.sync();
  } finally {
    await target?.close();
  }
  const ref = `sha256:${hash.digest("hex")}`;
  if (ref !== record.ref || sizeBytes !== record.sizeBytes) {
    throw appError("storage.blob_corrupt", {
      details: {
        blobRef: record.ref,
        expected: `${record.ref}/${record.sizeBytes}`,
        actual: `${ref}/${sizeBytes}`,
      },
    });
  }
}

/** The caller must hold the application instance's offline lock. */
export async function verifyStorage(
  database: Database,
  cas: Cas,
  options: { signal?: AbortSignal } = {},
): Promise<StorageInventory> {
  const { signal } = options;
  throwIfAborted(signal);
  verifyDatabase(database);
  const { inventory, records } = readInventory(database);
  for (const record of records) await verifyObject(cas, record, signal);
  throwIfAborted(signal);
  return inventory;
}

async function directoryEntries(
  path: string,
  problems: CollectionProblem[],
  signal?: AbortSignal,
) {
  if (signal?.aborted) return [];
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) !== "ENOENT")
      problems.push({ path, reason: String(error) });
    return [];
  }
}

async function removeFile(
  path: string,
  problems: CollectionProblem[],
): Promise<number | undefined> {
  try {
    const entry = await lstat(path);
    if (entry.isDirectory()) return undefined;
    await unlink(path);
    return entry.size;
  } catch (error) {
    if (errorCode(error) !== "ENOENT")
      problems.push({ path, reason: String(error) });
    return undefined;
  }
}

async function* storedObjects(
  root: string,
  problems: CollectionProblem[],
  signal?: AbortSignal,
): AsyncGenerator<BlobRef> {
  const objects = join(root, "sha256");
  const shards = (await directoryEntries(objects, problems, signal)).filter(
    (entry) => entry.isDirectory() && /^[a-f0-9]{2}$/.test(entry.name),
  );
  for (const shard of shards) {
    if (signal?.aborted) return;
    for (const entry of await directoryEntries(
      join(objects, shard.name),
      problems,
    )) {
      if (signal?.aborted) return;
      if (entry.isFile() && /^[a-f0-9]{62}$/.test(entry.name))
        yield `sha256:${shard.name}${entry.name}`;
    }
  }
}

async function sweepStorage(
  root: string,
  live: ReadonlyMap<BlobRef, BlobInfo>,
  signal?: AbortSignal,
) {
  const problems: CollectionProblem[] = [];
  let removedBlobs = 0;
  let reclaimedBytes = 0;
  for await (const ref of storedObjects(root, problems, signal)) {
    if (signal?.aborted) break;
    if (live.has(ref)) continue;
    const bytes = await removeFile(objectPath(root, ref), problems);
    if (bytes !== undefined) {
      removedBlobs += 1;
      reclaimedBytes += bytes;
    }
  }
  const temporary = join(root, "tmp");
  for (const entry of await directoryEntries(temporary, problems, signal)) {
    if (signal?.aborted) break;
    await removeFile(join(temporary, entry.name), problems);
  }
  return {
    removedBlobs,
    reclaimedBytes,
    sweepComplete: signal?.aborted !== true,
    problems,
  };
}

/** Removes unreachable metadata first and then deletes unreferenced bytes. Caller holds the offline lock. */
export async function collectStorage(
  database: Database,
  cas: Cas,
  options: CollectionOptions = {},
): Promise<CollectionReport> {
  const { signal } = options;
  throwIfAborted(signal);
  const { floor, live } = database.write((tx) => {
    const floor =
      options.retainSince === undefined
        ? tx.sql
            .query<{ history_floor: bigint }>(
              "SELECT history_floor FROM store_meta WHERE singleton = 1",
            )
            .get()!.history_floor
        : resolveCut({ sql: tx.sql, cut: tx.seq - 1n }, options.retainSince);
    tx.sql.run(
      "UPDATE store_meta SET history_floor = ? WHERE singleton = 1",
      floor,
    );
    synchronousResult(options.prune?.(tx, floor), "write");
    const live = referencedBlobs(tx.sql);
    const registered = tx.sql
      .query<Pick<BlobRecord, "ref">>("SELECT ref FROM blobs")
      .all();
    const discard = tx.sql.query("DELETE FROM blobs WHERE ref = ?");
    for (const { ref } of registered) {
      if (!live.has(ref)) discard.run(ref);
    }
    throwIfAborted(signal);
    return { floor, live };
  });

  return {
    historyFloor: floor.toString(),
    ...(await sweepStorage(cas.root, live, signal)),
  };
}
