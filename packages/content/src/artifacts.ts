import { randomUUID } from "node:crypto";
import {
  artifactRefSchema,
  blobRefSchema,
  commitPointSchema,
  extentSchema,
  formatAgentArtifactRef,
  generateReadable60,
  instantSchema,
  jsonSchema,
  mediaTypeSchema,
  parseAgentArtifactCode,
  rangeSchema,
  selectionRangeKey,
  selectionSchema,
  type AgentArtifactRef,
  type ArtifactRef,
  type Selection,
} from "@themelios/core";
import type { ReadTransaction, WriteTransaction } from "@themelios/storage";
import { z } from "zod";
import { contentError, jsonValue, validated } from "./validation.js";

export const originSchema = z.strictObject({
  kind: z.enum(["file", "url", "application"]),
  locator: z.string().min(1).optional(),
  capturedAt: instantSchema,
  metadata: jsonSchema.optional(),
});
export type Origin = z.infer<typeof originSchema>;

export const artifactInfoSchema = z.strictObject({
  ref: artifactRefSchema,
  kind: z.enum(["material", "result"]),
  mediaType: mediaTypeSchema,
  sizeBytes: z.int().nonnegative(),
  name: z.string().min(1).optional(),
  extent: extentSchema,
  origin: originSchema.optional(),
  createdAt: instantSchema,
  createdAtCut: commitPointSchema,
});
export type ArtifactInfo = z.infer<typeof artifactInfoSchema>;

const artifactRowSchema = artifactInfoSchema.extend({ blob: blobRefSchema });
export type ArtifactRow = z.infer<typeof artifactRowSchema>;

export const sourceLinkSchema = z.strictObject({
  relation: z.enum(["input", "file", "representation-source"]),
  selection: selectionSchema,
});
export type SourceLink = z.infer<typeof sourceLinkSchema>;

interface StoredArtifact {
  ref: string;
  agent_code: string;
  kind: ArtifactInfo["kind"];
  media_type: string;
  blob_ref: string;
  size_bytes: bigint;
  name: string | null;
  extent_json: string;
  origin_json: string | null;
  created_seq: bigint;
  recorded_at: string;
}

const artifactQuery = `
  SELECT a.*, b.size_bytes, c.recorded_at FROM artifacts a
  JOIN blobs b ON b.ref = a.blob_ref
  JOIN commits c ON c.seq = a.created_seq
`;

export type ArtifactDraft = Omit<ArtifactRow, "createdAt" | "createdAtCut">;
export type Query = ReadTransaction["sql"];

export function newArtifactRef(): ArtifactRef {
  return `art_${randomUUID()}`;
}

function storedInfo(row: StoredArtifact): ArtifactRow {
  return validated(artifactRowSchema, {
    ref: row.ref,
    kind: row.kind,
    mediaType: row.media_type,
    blob: row.blob_ref,
    sizeBytes: Number(row.size_bytes),
    extent: jsonValue(row.extent_json, row.ref),
    createdAt: row.recorded_at,
    createdAtCut: row.created_seq.toString(),
    ...(row.name === null ? {} : { name: row.name }),
    ...(row.origin_json === null
      ? {}
      : {
          origin: jsonValue(row.origin_json, row.ref),
        }),
  });
}

export function publicInfo({
  blob: _blob,
  ...info
}: ArtifactRow): ArtifactInfo {
  return info;
}

export function storedArtifact(
  sql: Query,
  ref: ArtifactRef,
  kind?: ArtifactInfo["kind"],
): ArtifactRow {
  validated(artifactRefSchema, ref);
  const row = sql
    .query<StoredArtifact, [ArtifactRef]>(artifactQuery + " WHERE a.ref = ?")
    .get(ref);
  if (!row || (kind && row.kind !== kind))
    throw contentError("content.not_found", { ref });
  return storedInfo(row);
}

export function resolveArtifactRef(
  sql: Query,
  refOrAgentRef: string,
): ArtifactRef {
  if (artifactRefSchema.safeParse(refOrAgentRef).success) {
    return storedArtifact(sql, refOrAgentRef as ArtifactRef).ref;
  }
  const code = parseAgentArtifactCode(refOrAgentRef);
  if (!code) {
    throw contentError("content.schema_invalid", {
      issues: [{ path: "/ref", constraint: "Expected an artifact reference" }],
    });
  }
  const row = sql
    .query<{ ref: string }, [string]>(
      "SELECT ref FROM artifacts WHERE agent_code = ?",
    )
    .get(code);
  if (!row) throw contentError("content.not_found", { ref: refOrAgentRef });
  return validated(artifactRefSchema, row.ref);
}

export function agentRefFor(sql: Query, ref: ArtifactRef): AgentArtifactRef {
  validated(artifactRefSchema, ref);
  const row = sql
    .query<{ agent_code: string }, [ArtifactRef]>(
      "SELECT agent_code FROM artifacts WHERE ref = ?",
    )
    .get(ref);
  if (!row) throw contentError("content.not_found", { ref });
  return formatAgentArtifactRef(row.agent_code);
}

export function edgeRange({ range }: Selection): string | null {
  return range === undefined ? null : selectionRangeKey(range);
}

export function edgeSelection(
  ref: ArtifactRef,
  range: string | null,
): Selection {
  return range === null
    ? { ref }
    : { ref, range: validated(rangeSchema, jsonValue(range, ref)) };
}

function isAgentCodeUniqueError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed") &&
    error.message.includes("agent_code")
  );
}

export function addArtifact(
  tx: WriteTransaction,
  artifact: ArtifactDraft,
): boolean {
  const origin =
    artifact.origin === undefined ? null : JSON.stringify(artifact.origin);
  const extent = JSON.stringify(artifact.extent);
  const blob = tx.registerBlob({
    ref: artifact.blob,
    sizeBytes: artifact.sizeBytes,
  });
  for (let attempt = 0; ; attempt += 1) {
    const agentCode = generateReadable60();
    try {
      const changes = tx.sql.run(
        `
        INSERT INTO artifacts (ref, agent_code, kind, media_type, blob_ref, name, extent_json, origin_json, created_seq)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ref) DO NOTHING
      `,
        artifact.ref,
        agentCode,
        artifact.kind,
        artifact.mediaType,
        blob,
        artifact.name ?? null,
        extent,
        origin,
        tx.seq,
      ).changes;
      if (changes > 0) return true;
      break;
    } catch (error) {
      if (attempt < 7 && isAgentCodeUniqueError(error)) continue;
      throw error;
    }
  }
  const row = tx.sql
    .query<Omit<StoredArtifact, "size_bytes" | "recorded_at">>(
      "SELECT * FROM artifacts WHERE ref = ?",
    )
    .get(artifact.ref)!;
  if (
    row.kind !== artifact.kind ||
    row.media_type !== artifact.mediaType ||
    row.blob_ref !== artifact.blob ||
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
    "INSERT OR IGNORE INTO artifact_retention (artifact_ref, retained_seq) VALUES (?, ?)",
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
    "INSERT INTO artifact_edges (owner_ref, relation, ordinal, target_ref, range_json) VALUES (?, ?, ?, ?, ?)",
  );
  for (const edge of indexEdges(edges)) {
    insert.run(
      owner,
      edge.relation,
      edge.ordinal,
      edge.selection.ref,
      edgeRange(edge.selection),
    );
  }
}

export function listRetainedArtifacts(
  tx: ReadTransaction,
  cut: bigint,
  after: ArtifactRef | undefined,
  limit: number,
): ArtifactInfo[] {
  return tx.sql
    .query<StoredArtifact>(
      `
    ${artifactQuery} JOIN artifact_retention r ON r.artifact_ref = a.ref
    WHERE r.retained_seq <= ? AND (r.released_seq IS NULL OR r.released_seq > ?) AND r.artifact_ref > ?
    ORDER BY r.artifact_ref LIMIT ?
  `,
    )
    .all(cut, cut, after ?? "", limit)
    .map((row) => publicInfo(storedInfo(row)));
}
