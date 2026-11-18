import { randomUUID } from "node:crypto";
import {
  artifactRefSchema,
  blobRefSchema,
  jsonSchema,
  selectionSchema,
  type ArtifactRef,
  type Selection,
} from "@themelios/core";
import { instantSchema } from "@themelios/core/time";
import type {
  Database,
  ReadTransaction,
  WriteTransaction,
} from "@themelios/storage";
import { z } from "zod";
import type { ArtifactInfo, ArtifactRow, SourceLink } from "./contracts.js";
import { contentError, jsonValue, validated } from "./validation.js";

const size = z.int().nonnegative();
export const mediaTypeSchema = z
  .string()
  .regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/)
  .transform((mime) => mime.toLowerCase());
export const originSchema = z
  .strictObject({
    kind: z.enum(["file", "url", "application"]),
    locator: z.string().min(1).optional(),
    capturedAt: instantSchema,
    metadata: jsonSchema.optional(),
  })
  .transform(({ kind, capturedAt, locator, metadata }) => ({
    kind,
    capturedAt,
    ...(locator === undefined ? {} : { locator }),
    ...(metadata === undefined ? {} : { metadata }),
  }));

const extentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), bytes: size }),
  z.strictObject({
    kind: z.literal("image"),
    width: z.int().positive(),
    height: z.int().positive(),
    frames: z.int().positive(),
  }),
  z.strictObject({ kind: z.literal("pages"), pages: size }),
  z.strictObject({
    kind: z.literal("time"),
    durationMs: z.number().nonnegative(),
  }),
  z.strictObject({ kind: z.literal("unknown") }),
]);

interface StoredArtifact {
  ref: string;
  kind: ArtifactInfo["kind"];
  media_type: string;
  blob_ref: string;
  size_bytes: bigint;
  name: string | null;
  extent_json: string;
  origin_json: string | null;
  created_seq: bigint;
  created_at: string;
}

export type ArtifactDraft = Omit<ArtifactInfo, "createdAt" | "createdAtCut"> &
  Pick<ArtifactRow, "blob">;
export type StoredInfo = ArtifactInfo & Pick<ArtifactRow, "blob">;
export type Query = ReadTransaction["sql"];

export function newArtifactRef(): ArtifactRef {
  return `art_${randomUUID()}`;
}

function storedInfo(row: StoredArtifact): StoredInfo {
  return {
    ref: validated(artifactRefSchema, row.ref),
    kind: row.kind,
    mediaType: row.media_type,
    blob: validated(blobRefSchema, row.blob_ref),
    sizeBytes: validated(size, Number(row.size_bytes)),
    extent: validated(extentSchema, jsonValue(row.extent_json, row.ref)),
    createdAt: validated(instantSchema, row.created_at),
    createdAtCut: row.created_seq.toString(),
    ...(row.name === null ? {} : { name: row.name }),
    ...(row.origin_json === null
      ? {}
      : {
          origin: validated(originSchema, jsonValue(row.origin_json, row.ref)),
        }),
  };
}

export function publicInfo({ blob: _blob, ...info }: StoredInfo): ArtifactInfo {
  return info;
}

export function storedArtifact(
  sql: Query,
  ref: ArtifactRef,
  kind?: ArtifactInfo["kind"],
): StoredInfo {
  validated(artifactRefSchema, ref);
  const row = sql
    .query<StoredArtifact, [ArtifactRef]>(
      "SELECT * FROM artifacts WHERE ref = ?",
    )
    .get(ref);
  if (!row || (kind && row.kind !== kind))
    throw contentError("content.not_found", { ref });
  return storedInfo(row);
}

export function decodeSelection(value: string, ref: ArtifactRef): Selection {
  return validated(selectionSchema, jsonValue(value, ref));
}

export function addArtifact(
  tx: WriteTransaction,
  artifact: ArtifactDraft,
): boolean {
  const origin =
    artifact.origin === undefined ? null : JSON.stringify(artifact.origin);
  const extent = JSON.stringify(artifact.extent);
  const changes = tx.sql.run(
    `
    INSERT INTO artifacts (ref, kind, media_type, blob_ref, size_bytes, name, extent_json, origin_json, created_seq, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ref) DO NOTHING
  `,
    artifact.ref,
    artifact.kind,
    artifact.mediaType,
    artifact.blob,
    artifact.sizeBytes,
    artifact.name ?? null,
    extent,
    origin,
    tx.seq,
    tx.recordedAt,
  ).changes;
  if (changes > 0) return true;
  const row = tx.sql
    .query<StoredArtifact>("SELECT * FROM artifacts WHERE ref = ?")
    .get(artifact.ref)!;
  if (
    row.kind !== artifact.kind ||
    row.media_type !== artifact.mediaType ||
    row.blob_ref !== artifact.blob ||
    row.size_bytes !== BigInt(artifact.sizeBytes) ||
    row.name !== (artifact.name ?? null) ||
    row.extent_json !== extent ||
    row.origin_json !== origin
  ) {
    throw contentError("content.artifact_conflict", { ref: artifact.ref });
  }
  return false;
}

export function retain(
  sql: WriteTransaction["sql"],
  ref: ArtifactRef,
  seq: bigint,
): void {
  sql.run(
    "INSERT OR IGNORE INTO artifact_roots (artifact_ref, retained_seq) VALUES (?, ?)",
    ref,
    seq,
  );
}

export function* indexEdges(
  edges: readonly SourceLink[],
): Generator<SourceLink & { ordinal: number }> {
  const ordinal = new Map<SourceLink["relation"], number>();
  for (const edge of edges) {
    const order = ordinal.get(edge.relation) ?? 0;
    yield { ...edge, ordinal: order };
    ordinal.set(edge.relation, order + 1);
  }
}

export function addEdges(
  tx: WriteTransaction,
  owner: ArtifactRef,
  edges: readonly SourceLink[],
): void {
  const insert = tx.sql.query(
    "INSERT INTO artifact_edges (owner_ref, relation, ordinal, target_ref, selection_json) VALUES (?, ?, ?, ?, ?)",
  );
  for (const edge of indexEdges(edges)) {
    insert.run(
      owner,
      edge.relation,
      edge.ordinal,
      edge.selection.ref,
      JSON.stringify(edge.selection),
    );
  }
}

export function listArtifacts(
  tx: ReadTransaction,
  cut: bigint,
  after: ArtifactRef | undefined,
  limit: number,
): ArtifactInfo[] {
  return tx.sql
    .query<StoredArtifact>(
      `
    SELECT a.* FROM artifact_roots r JOIN artifacts a ON a.ref = r.artifact_ref
    WHERE r.retained_seq <= ? AND (r.released_seq IS NULL OR r.released_seq > ?) AND r.artifact_ref > ?
    ORDER BY r.artifact_ref LIMIT ?
  `,
    )
    .all(cut, cut, after ?? "", limit)
    .map((row) => publicInfo(storedInfo(row)));
}

export function prepareAdoption<T>(
  database: Database,
  operation: string,
  work: (tx: WriteTransaction) => T,
) {
  let closed = false;
  return {
    adopt(tx: WriteTransaction): T {
      if (closed) throw contentError("content.prepared_closed", { operation });
      if (!database.owns(tx))
        throw contentError("content.transaction_mismatch", { operation });
      return work(tx);
    },
    close(): Promise<void> {
      closed = true;
      return Promise.resolve();
    },
  };
}
