import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  blobRefSchema,
  type BlobRef,
  type CommitPoint,
  type Instant,
} from "@themelios/core";
import { type Cas, objectPath } from "./cas.js";
import type { Database } from "./database.js";
import { fileErrorCode, storageError } from "./errors.js";
import { streamChunks, writeChunk } from "./files.js";
import { resolveCut, type ReadTransaction } from "./transaction.js";

export interface StorageInventory {
  formatId: string;
  cut: CommitPoint;
  artifacts: number;
  blobs: number;
  bytes: number;
}

export interface BackupInfo extends StorageInventory {
  createdAt: Instant;
}

export interface CollectionReport {
  historyFloor: CommitPoint;
  removedArtifacts: number;
  removedBlobs: number;
  reclaimedBytes: number;
  problems: readonly { path: string; reason: string }[];
}

interface ReferencedBlob {
  blob_ref: BlobRef;
  size_bytes: bigint;
  largest: bigint;
}

function hasArtifacts(tx: ReadTransaction): boolean {
  return (
    tx.sql
      .query(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'",
      )
      .get() !== null
  );
}

export function readInventory(database: Database) {
  return database.read((tx) => {
    const { format_id: formatId } = tx.sql
      .query<{ format_id: string }>(
        "SELECT format_id FROM store_meta WHERE singleton = 1",
      )
      .get()!;
    const available = hasArtifacts(tx);
    const artifacts = available
      ? Number(
          tx.sql
            .query<{ count: bigint }>("SELECT count(*) AS count FROM artifacts")
            .get()!.count,
        )
      : 0;
    const references = available
      ? tx.sql
          .query<ReferencedBlob>(
            `
      SELECT blob_ref, min(size_bytes) AS size_bytes, max(size_bytes) AS largest FROM artifacts GROUP BY blob_ref ORDER BY blob_ref
    `,
          )
          .all()
      : [];
    const records = references.map(
      ({ blob_ref: ref, size_bytes: minimum, largest }) => {
        if (
          minimum !== largest ||
          minimum > BigInt(Number.MAX_SAFE_INTEGER) ||
          !blobRefSchema.safeParse(ref).success
        ) {
          throw storageError("storage.blob_corrupt", {
            blobRef: ref,
            expected: String(minimum),
            actual: String(largest),
          });
        }
        return { ref, sizeBytes: Number(minimum) };
      },
    );
    const inventory: StorageInventory = {
      formatId,
      cut: tx.cut.toString(),
      artifacts,
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
      throw storageError("storage.database_corrupt", {
        quickCheck: quick.map((row) => row.quick_check),
        foreignKeyCheck: foreign.map((row) => ({
          table: row.table,
          parent: row.parent,
        })),
      });
    }
  });
}

export async function verifyObject(
  cas: Cas,
  record: { ref: BlobRef; sizeBytes: number },
  stagingObjects?: string,
): Promise<void> {
  const current = await cas.stat(record.ref);
  if (current.sizeBytes !== record.sizeBytes) {
    throw storageError("storage.blob_corrupt", {
      blobRef: record.ref,
      expected: record.sizeBytes,
      actual: current.sizeBytes,
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
    const stream = await cas.read(record.ref);
    for await (const bytes of streamChunks(
      stream,
      new AbortController().signal,
    )) {
      hash.update(bytes);
      sizeBytes += bytes.byteLength;
      if (target) await writeChunk(target, bytes);
    }
    await target?.sync();
  } finally {
    await target?.close();
  }
  const ref = `sha256:${hash.digest("hex")}`;
  if (ref !== record.ref || sizeBytes !== record.sizeBytes) {
    throw storageError("storage.blob_corrupt", {
      blobRef: record.ref,
      expected: `${record.ref}/${record.sizeBytes}`,
      actual: `${ref}/${sizeBytes}`,
    });
  }
}

/** The caller must hold the application instance's offline lock. */
export async function verifyStorage(
  database: Database,
  cas: Cas,
): Promise<StorageInventory> {
  verifyDatabase(database);
  const { inventory, records } = readInventory(database);
  for (const record of records) await verifyObject(cas, record);
  return inventory;
}

async function directoryEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return [];
    throw error;
  }
}

/** Removes unreachable metadata first and then deletes unreferenced bytes. Caller holds the offline lock. */
export async function collectStorage(
  database: Database,
  cas: Cas,
  options: { retainSince?: CommitPoint } = {},
): Promise<CollectionReport> {
  const { floor, available } = database.read((tx) => ({
    floor:
      options.retainSince === undefined
        ? tx.sql
            .query<{ history_floor: bigint }>(
              "SELECT history_floor FROM store_meta WHERE singleton = 1",
            )
            .get()!.history_floor
        : resolveCut(tx, options.retainSince),
    available: hasArtifacts(tx),
  }));
  const removedArtifacts = database.write((tx) => {
    tx.sql.run(
      "UPDATE store_meta SET history_floor = ? WHERE singleton = 1",
      floor,
    );
    if (!available) return 0;
    tx.sql.run(
      "CREATE TEMP TABLE keep_artifacts (ref TEXT PRIMARY KEY) WITHOUT ROWID",
    );
    tx.sql.run(
      `INSERT INTO keep_artifacts
      WITH RECURSIVE kept(ref) AS (
        SELECT artifact_ref FROM artifact_roots WHERE released_seq IS NULL OR released_seq > ?
        UNION SELECT e.target_ref FROM kept k JOIN artifact_edges e ON e.owner_ref = k.ref
        UNION SELECT p.result_ref FROM kept k JOIN representations p ON p.source_ref = k.ref
          WHERE p.retired_seq IS NULL OR p.retired_seq > ?
      ) SELECT ref FROM kept`,
      floor,
      floor,
    );
    const unretained =
      "(SELECT ref FROM artifacts WHERE ref NOT IN (SELECT ref FROM keep_artifacts))";
    tx.sql.run(
      `DELETE FROM representations WHERE retired_seq <= ? OR source_ref IN ${unretained} OR result_ref IN ${unretained}`,
      floor,
    );
    tx.sql.run(
      `DELETE FROM artifact_edges WHERE owner_ref IN ${unretained} OR target_ref IN ${unretained}`,
    );
    tx.sql.run(
      `DELETE FROM artifact_roots WHERE released_seq <= ? OR artifact_ref IN ${unretained}`,
      floor,
    );
    const removed = tx.sql.run(
      `DELETE FROM artifacts WHERE ref IN ${unretained}`,
    ).changes;
    tx.sql.run("DROP TABLE keep_artifacts");
    return Number(removed);
  });

  const live = new Set(
    readInventory(database).records.map((record) => record.ref),
  );
  const problems: CollectionReport["problems"][number][] = [];
  let removedBlobs = 0;
  let reclaimedBytes = 0;
  async function remove(path: string, blob: boolean): Promise<void> {
    try {
      const entry = await lstat(path);
      if (entry.isDirectory()) return;
      await unlink(path);
      if (blob) {
        removedBlobs += 1;
        reclaimedBytes += entry.size;
      }
    } catch (error) {
      if (fileErrorCode(error) !== "ENOENT")
        problems.push({ path, reason: String(error) });
    }
  }
  async function entries(path: string) {
    try {
      return await directoryEntries(path);
    } catch (error) {
      problems.push({ path, reason: String(error) });
      return [];
    }
  }

  const objectRoot = join(cas.root, "sha256");
  for (const shard of await entries(objectRoot)) {
    if (!shard.isDirectory() || !/^[a-f0-9]{2}$/.test(shard.name)) continue;
    for (const entry of await entries(join(objectRoot, shard.name))) {
      if (!entry.isFile() || !/^[a-f0-9]{62}$/.test(entry.name)) continue;
      const ref = `sha256:${shard.name}${entry.name}`;
      if (!live.has(ref)) await remove(objectPath(cas.root, ref), true);
    }
  }
  const temporary = join(cas.root, "tmp");
  for (const entry of await entries(temporary))
    await remove(join(temporary, entry.name), false);
  return {
    historyFloor: floor.toString(),
    removedArtifacts,
    removedBlobs,
    reclaimedBytes,
    problems,
  };
}
