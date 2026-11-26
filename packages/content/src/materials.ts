import {
  artifactRefSchema,
  commitPointSchema,
  openCall,
  selectionSchema,
  throwIfAborted,
  type AgentArtifactRef,
  type ArtifactRef,
  type CallOptions,
  type Selection,
} from "@themelios/core";
import {
  resolveCut,
  type Cas,
  type Database,
  type TransactionResult,
  type WriteTransaction,
} from "@themelios/storage";
import { z } from "zod";
import {
  addArtifact,
  agentRefFor,
  edgeSelection,
  listRetainedArtifacts,
  publicInfo,
  resolveArtifactRef,
  retain,
  storedArtifact,
  type ArtifactDraft,
  type ArtifactInfo,
  type Query,
  type SourceLink,
} from "./artifacts.js";
import {
  captureImport,
  importArtifact,
  type AcceptInput,
  type ImportLimits,
} from "./imports.js";
import { rawBytes, selectionText, utf8Text } from "./selections.js";
import { structureText, type TextBlock } from "./text-structure.js";
import { contentError, validated } from "./validation.js";

export interface CapturedMaterial {
  readonly info: Omit<ArtifactInfo, "createdAt" | "createdAtCut">;
  readonly signal: AbortSignal;
  /** Opens the exact captured bytes during analysis. */
  read(): Promise<ReadableStream<Uint8Array>>;
}

export type MaterialAttachment<R> = (
  tx: WriteTransaction,
  selection: Selection,
) => TransactionResult<R>;

export interface AnalyzedMaterialAdoption<A, R> {
  analyze(material: CapturedMaterial): Promise<A>;
  attach(
    tx: WriteTransaction,
    selection: Selection,
    analysis: A,
  ): TransactionResult<R>;
}

export const materialOperationIds = {
  accept: "materials.accept",
  adopt: "materials.adopt",
  adoptAnalyzed: "materials.adoptAnalyzed",
  inspect: "materials.inspect",
  read: "materials.read",
  text: "materials.text",
  structure: "materials.structure",
  sources: "materials.sources",
  listRetained: "materials.listRetained",
  retain: "materials.retain",
  release: "materials.release",
  export: "materials.export",
} as const;

export const sourceTraceOptionsSchema = z.strictObject({
  depth: z.int().min(1).max(16).default(1),
});
export const retainedListOptionsSchema = z.strictObject({
  at: commitPointSchema.optional(),
  after: artifactRefSchema.optional(),
  limit: z.int().min(1).max(1000).default(100),
});

export interface MaterialRead {
  readonly info: ArtifactInfo;
  readonly body: ReadableStream<Uint8Array>;
}

export interface Materials {
  /** Captures a standalone material and adds it to the retention catalog. */
  accept(input: AcceptInput, options?: CallOptions): Promise<Selection>;
  /** Captures input and attaches it to application rows in one commit. */
  adopt<R>(
    input: AcceptInput,
    attach: MaterialAttachment<R>,
    options?: CallOptions,
  ): Promise<R>;
  /** Reads the captured input for analysis before attaching it in one commit. */
  adoptAnalyzed<A, R>(
    input: AcceptInput,
    adoption: AnalyzedMaterialAdoption<A, R>,
    options?: CallOptions,
  ): Promise<R>;
  inspect(ref: ArtifactRef): ArtifactInfo;
  resolve(refOrAgentRef: string): ArtifactRef;
  agentRef(ref: ArtifactRef): AgentArtifactRef;
  read(ref: ArtifactRef, options?: CallOptions): Promise<MaterialRead>;
  text(selection: Selection, options?: CallOptions): Promise<string>;
  structure(ref: ArtifactRef, options?: CallOptions): Promise<TextBlock[]>;
  sources(
    ref: ArtifactRef,
    options?: z.input<typeof sourceTraceOptionsSchema>,
  ): SourceLink[];
  /** Enumerates the standalone retention catalog at the requested commit. */
  listRetained(
    options?: z.input<typeof retainedListOptionsSchema>,
  ): ArtifactInfo[];
  retain(ref: ArtifactRef): void;
  release(ref: ArtifactRef): void;
  export(
    ref: ArtifactRef,
    destination: string,
    options?: CallOptions,
  ): Promise<void>;
}

function readSources(
  sql: Query,
  ref: ArtifactRef,
  depth: number,
): SourceLink[] {
  const edges = sql.query<
    {
      relation: SourceLink["relation"];
      target_ref: ArtifactRef;
      range_json: string | null;
    },
    [ArtifactRef]
  >(
    "SELECT relation, target_ref, range_json FROM artifact_edges WHERE owner_ref = ? ORDER BY relation, ordinal",
  );
  const queued = new Set([ref]);
  const queue = [{ ref, level: 1 }];
  const found = new Map<string, SourceLink>();
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    for (const edge of edges.all(current.ref)) {
      const key = `${edge.relation}:${edge.target_ref}:${edge.range_json ?? ""}`;
      if (!found.has(key))
        found.set(key, {
          relation: edge.relation,
          selection: edgeSelection(edge.target_ref, edge.range_json),
        });
      if (current.level < depth && !queued.has(edge.target_ref)) {
        queued.add(edge.target_ref);
        queue.push({ ref: edge.target_ref, level: current.level + 1 });
      }
    }
  }
  return [...found.values()];
}

export function createMaterials(
  database: Database,
  cas: Cas,
  importLimits: () => ImportLimits,
): Materials {
  const lookup = (ref: ArtifactRef) =>
    database.read((tx) => storedArtifact(tx.sql, ref));

  async function captureAndAttach<R>(
    input: AcceptInput,
    operation: string,
    options: CallOptions | undefined,
    prepare: (
      artifact: ArtifactDraft,
      signal: AbortSignal,
    ) => Promise<MaterialAttachment<R>>,
  ): Promise<R> {
    database.requireWritable(operation);
    const scope = openCall(operation, options);
    try {
      scope.throwIfAborted();
      const limits = importLimits();
      const captured = captureImport(input, limits.maxInlineBytes);
      const artifact = await importArtifact(cas, captured, limits, {
        signal: scope.signal,
      });
      const attach = await prepare(artifact, scope.signal);
      scope.throwIfAborted();
      return database.write<R>((tx) => {
        addArtifact(tx, artifact);
        return attach(tx, { ref: artifact.ref });
      });
    } finally {
      scope.close();
    }
  }

  return {
    accept(input, options) {
      return captureAndAttach(
        input,
        materialOperationIds.accept,
        options,
        async () => (tx, selection) => {
          retain(tx.sql, selection.ref, tx.seq);
          return selection;
        },
      );
    },

    adopt(input, attach, options) {
      return captureAndAttach(
        input,
        materialOperationIds.adopt,
        options,
        async () => attach,
      );
    },

    adoptAnalyzed(input, { analyze, attach }, options) {
      return captureAndAttach(
        input,
        materialOperationIds.adoptAnalyzed,
        options,
        async ({ blob, ...info }, callerSignal) => {
          const reader = new AbortController();
          const signal = AbortSignal.any([callerSignal, reader.signal]);
          try {
            const analysis = await analyze({
              info: structuredClone(info),
              signal,
              read: () => cas.read(blob, { signal }),
            });
            return (tx, selection) => attach(tx, selection, analysis);
          } finally {
            reader.abort();
          }
        },
      );
    },

    inspect(ref) {
      return publicInfo(lookup(ref));
    },

    resolve(refOrAgentRef) {
      return database.read((tx) => resolveArtifactRef(tx.sql, refOrAgentRef));
    },

    agentRef(ref) {
      return database.read((tx) => agentRefFor(tx.sql, ref));
    },

    async read(ref, options) {
      throwIfAborted(options?.signal);
      const artifact = lookup(ref);
      return {
        info: publicInfo(artifact),
        body: await cas.read(artifact.blob, options),
      };
    },

    async text(selection, options) {
      const scope = openCall(materialOperationIds.text, options);
      try {
        scope.throwIfAborted();
        const selected = validated(selectionSchema, selection);
        return await selectionText(
          cas,
          lookup(selected.ref),
          selected,
          scope.signal,
        );
      } finally {
        scope.close();
      }
    },

    async structure(ref, options) {
      const scope = openCall(materialOperationIds.structure, options);
      try {
        scope.throwIfAborted();
        const artifact = lookup(ref);
        if (!["text/plain", "text/markdown"].includes(artifact.mediaType)) {
          throw contentError("content.text_unavailable", {
            ref,
            mediaType: artifact.mediaType,
          });
        }
        const bytes = await rawBytes(cas, artifact, scope.signal);
        const blocks = structureText(
          ref,
          utf8Text(bytes, artifact),
          artifact.mediaType === "text/markdown",
        );
        scope.throwIfAborted();
        return blocks;
      } finally {
        scope.close();
      }
    },

    sources(ref, options = {}) {
      const { depth } = validated(sourceTraceOptionsSchema, options);
      return database.read((tx) => {
        storedArtifact(tx.sql, ref);
        return readSources(tx.sql, ref, depth);
      });
    },

    listRetained(options = {}) {
      const { at, after, limit } = validated(
        retainedListOptionsSchema,
        options,
      );
      return database.read((tx) =>
        listRetainedArtifacts(tx, resolveCut(tx, at), after, limit),
      );
    },

    retain(ref) {
      database.write((tx) => {
        storedArtifact(tx.sql, ref);
        retain(tx.sql, ref, tx.seq);
      });
    },

    release(ref) {
      database.write((tx) => {
        storedArtifact(tx.sql, ref);
        tx.sql.run(
          "UPDATE artifact_retention SET released_seq = ? WHERE artifact_ref = ? AND released_seq IS NULL",
          tx.seq,
          ref,
        );
      });
    },

    async export(ref, destination, options) {
      throwIfAborted(options?.signal);
      await cas.export(lookup(ref).blob, destination, options);
    },
  };
}
