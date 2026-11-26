import { registerRepresentation } from "./representation-index.js";
import type { Representation } from "./representations.js";
import {
  artifactRefSchema,
  modelInputRepresentationPurpose,
  openCall,
  resultFile,
  resultValueOutput,
  resultValueSelection,
  savedResultSchema,
  type ArtifactRef,
  type CallOptions,
  type Completed,
  type InlineMaterial,
  type InputUse,
  type Json,
  type Material,
  type SavedFile,
  type SavedResult,
  type Selection,
} from "@themelios/core";
import type {
  Cas,
  Database,
  TransactionResult,
  WriteTransaction,
} from "@themelios/storage";
import { z, type ZodType } from "zod";
import {
  addArtifact,
  addEdges,
  newArtifactRef,
  retain,
  storedArtifact,
  type ArtifactDraft,
  type SourceLink,
} from "./artifacts.js";
import { captureImport, importArtifact, type ImportLimits } from "./imports.js";
import { captureResult, resultLinks } from "./result-graph.js";
import {
  rawBytes,
  resultMediaType,
  utf8Text,
  validateSelection,
} from "./selections.js";
import { jsonValue, validated } from "./validation.js";

const resultManifestFormat = "themelios.result";

type ResultManifest = Omit<SavedResult, "ref"> & {
  format: typeof resultManifestFormat;
  upstreamResults: readonly ArtifactRef[];
};

export type ResultAttachment<T extends Json, R> = (
  tx: WriteTransaction,
  saved: SavedResult<T>,
) => TransactionResult<R>;

export const resultOperationIds = {
  read: "results.read",
  save: "results.save",
  adopt: "results.adopt",
} as const;

export interface Results {
  read<T extends Json = Json>(
    ref: ArtifactRef,
    options?: CallOptions & { schema?: ZodType<T> },
  ): Promise<SavedResult<T>>;
  /** Saves a standalone result and adds it to the retention catalog. */
  save<T extends Json>(
    completed: Completed<T>,
    options?: CallOptions,
  ): Promise<SavedResult<T>>;
  /** Saves a result graph and its application ownership in one commit. */
  adopt<T extends Json, R>(
    completed: Completed<T>,
    attach: ResultAttachment<T, R>,
    options?: CallOptions,
  ): Promise<R>;
}

const manifestEnvelope = z.looseObject({
  format: z.literal(resultManifestFormat),
  ref: z.never().optional(),
  upstreamResults: z.array(artifactRefSchema),
});

export function parseManifest(
  ref: ArtifactRef,
  text: string,
): { result: SavedResult; upstreamResults: ArtifactRef[] } {
  const {
    format: _format,
    ref: _ref,
    upstreamResults,
    ...record
  } = validated(manifestEnvelope, jsonValue(text, ref));
  return {
    result: validated(savedResultSchema, { ...record, ref }),
    upstreamResults,
  };
}

async function loadResult(
  database: Database,
  cas: Cas,
  ref: ArtifactRef,
  signal: AbortSignal,
): Promise<SavedResult> {
  const artifact = database.read((tx) => storedArtifact(tx.sql, ref, "result"));
  const { result, upstreamResults } = parseManifest(
    ref,
    utf8Text(await rawBytes(cas, artifact, signal), artifact),
  );
  database.read((tx) => {
    for (const link of resultLinks(result, upstreamResults)) {
      storedArtifact(
        tx.sql,
        link.selection.ref,
        link.relation === "representation-source" ? "result" : undefined,
      );
    }
  });
  return result;
}

export function createResults(
  database: Database,
  cas: Cas,
  importLimits: () => ImportLimits,
): Results {
  async function persist<T extends Json, R>(
    completed: Completed<T>,
    operation: string,
    attach: ResultAttachment<T, R>,
    options?: CallOptions,
  ): Promise<R> {
    database.requireWritable(operation);
    const scope = openCall(operation, options);
    try {
      scope.throwIfAborted();
      const limits = importLimits();
      const captured = captureResult(completed, limits.maxInlineBytes);
      scope.throwIfAborted();
      const plan = await buildPlan(
        database,
        cas,
        limits,
        captured,
        scope.signal,
      );
      const saved = plan.root as SavedResult<T>;
      scope.throwIfAborted();
      return database.write<R>((tx) => {
        for (const [ref, item] of plan.newArtifacts) {
          if (!addArtifact(tx, item.artifact)) continue;
          for (const link of item.edges)
            storedArtifact(tx.sql, link.selection.ref);
          addEdges(tx, ref, item.edges);
        }
        for (const { saved, entry } of plan.representations)
          registerRepresentation(tx, saved, entry);
        return attach(tx, saved);
      });
    } finally {
      scope.close();
    }
  }

  async function read<T extends Json = Json>(
    ref: ArtifactRef,
    options?: CallOptions & { schema?: ZodType<T> },
  ): Promise<SavedResult<T>> {
    const scope = openCall(resultOperationIds.read, options);
    try {
      scope.throwIfAborted();
      const result = await loadResult(database, cas, ref, scope.signal);
      scope.throwIfAborted();
      return options?.schema
        ? {
            ...result,
            value: validated(options.schema, result.value, ["value"]),
          }
        : (result as SavedResult<T>);
    } finally {
      scope.close();
    }
  }

  return {
    read,
    save(completed, options) {
      return persist(
        completed,
        resultOperationIds.save,
        (tx, saved) => {
          retain(tx.sql, saved.ref, tx.seq);
          return saved;
        },
        options,
      );
    },
    adopt(completed, attach, options) {
      return persist(completed, resultOperationIds.adopt, attach, options);
    },
  };
}

interface PlannedArtifact {
  artifact: ArtifactDraft;
  edges: SourceLink[];
}

async function buildPlan(
  database: Database,
  cas: Cas,
  limits: ImportLimits,
  captured: Completed,
  signal: AbortSignal,
) {
  const newArtifacts = new Map<ArtifactRef, PlannedArtifact>();
  const inlines = new WeakMap<InlineMaterial, ArtifactRef>();
  const results = new WeakMap<Completed, SavedResult>();
  const representations: {
    saved: SavedResult;
    entry: Omit<Representation, "result">;
  }[] = [];
  const existingResults = new Map<ArtifactRef, SavedResult>();
  const lookup = (ref: ArtifactRef): ArtifactDraft =>
    newArtifacts.get(ref)?.artifact ??
    database.read((tx) => storedArtifact(tx.sql, ref));

  async function resolve(
    material: Material,
    upstreamResults: Set<ArtifactRef>,
  ): Promise<Selection> {
    if ("bytes" in material) {
      const reused = inlines.get(material);
      if (reused) return { ref: reused };
      const artifact = await importArtifact(
        cas,
        captureImport(material, limits.maxInlineBytes, false),
        limits,
        { signal },
      );
      newArtifacts.set(artifact.ref, { artifact, edges: [] });
      inlines.set(material, artifact.ref);
      return { ref: artifact.ref };
    }
    if ("ref" in material) {
      await validateSelection(cas, lookup(material.ref), material, signal);
      return material;
    }
    let result: SavedResult;
    if (typeof material.result === "string") {
      result =
        existingResults.get(material.result) ??
        (await loadResult(database, cas, material.result, signal));
      existingResults.set(result.ref, result);
    } else {
      result = await build(material.result);
    }
    upstreamResults.add(result.ref);
    const output = material.output ?? resultValueOutput;
    return output === resultValueOutput
      ? resultValueSelection(result.ref)
      : resultFile(result, output).material;
  }

  async function build(node: Completed): Promise<SavedResult> {
    const reused = results.get(node);
    if (reused) return reused;
    const upstream = new Set<ArtifactRef>();
    const inputs: InputUse<Selection>[] = [];
    for (const use of node.inputs) {
      const source = await resolve(use.source, upstream);
      const delivered: Selection[] = [];
      for (const material of use.delivered)
        delivered.push(await resolve(material, upstream));
      inputs.push({ ...use, source, delivered });
    }
    const files: SavedFile[] = [];
    for (const file of node.files) {
      files.push({
        name: file.name,
        material: await resolve(file.material, upstream),
        sourceIndices: file.sourceIndices,
        ...(file.coverage === undefined ? {} : { coverage: file.coverage }),
      });
    }
    const { value, producer } = node;
    const body = { value, inputs, files, producer };
    const manifest: ResultManifest = {
      format: resultManifestFormat,
      ...body,
      upstreamResults: [...upstream],
    };
    const ref = newArtifactRef();
    const result: SavedResult = { ref, ...body };
    const { ref: blob, sizeBytes } = await cas.put(
      new TextEncoder().encode(JSON.stringify(manifest)),
      { signal },
    );
    const artifact: ArtifactDraft = {
      ref,
      blob,
      sizeBytes,
      kind: "result",
      mediaType: resultMediaType,
      extent: { kind: "text", bytes: sizeBytes },
    };
    newArtifacts.set(ref, {
      artifact,
      edges: resultLinks(result, manifest.upstreamResults),
    });
    results.set(node, result);
    const key = node.representation;
    if (key) {
      representations.push({
        saved: result,
        entry: {
          source: key.source,
          purpose: modelInputRepresentationPurpose,
          recipe: key.recipe,
          outputs: key.outputs,
        },
      });
    }
    return result;
  }

  const root = await build(captured);
  return { root, newArtifacts, representations };
}
