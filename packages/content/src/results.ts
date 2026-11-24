import { registerRepresentation } from "./representation-index.js";
import type { Representation } from "./representations.js";
import {
  artifactRefSchema,
  openCall,
  throwIfAborted,
  savedResultSchema,
  type ArtifactRef,
  type CallOptions,
  type Completed,
  type InlineMaterial,
  type InputUse,
  type Json,
  type Material,
  type Producer,
  type SavedFile,
  type SavedResult,
  type Selection,
} from "@themelios/core";
import type { Cas, Database, WriteTransaction } from "@themelios/storage";
import { z, type ZodType } from "zod";
import {
  addArtifact,
  addEdges,
  newArtifactRef,
  prepareAdoption,
  retain,
  storedArtifact,
  type ArtifactDraft,
  type SourceLink,
} from "./artifacts.js";
import { captureImport, importArtifact, type ImportLimits } from "./imports.js";
import { captureResult, resultLinks, selectOutput } from "./result-graph.js";
import {
  rawBytes,
  resultMediaType,
  utf8Text,
  validateSelection,
} from "./selections.js";
import { jsonValue, validated } from "./validation.js";

export interface ResultManifest<T extends Json = Json> {
  format: "themelios.result";
  value: T;
  inputs: readonly InputUse<Selection>[];
  files: Readonly<Record<string, SavedFile>>;
  producer: Producer;
  upstreamResults: readonly ArtifactRef[];
}

export interface PreparedResult<T extends Json = Json> {
  readonly ref: ArtifactRef;
  adopt(tx: WriteTransaction): SavedResult<T>;
  close(): Promise<void>;
}

export interface Results {
  prepare<T extends Json>(
    completed: Completed<T>,
    options?: CallOptions,
  ): Promise<PreparedResult<T>>;
  read(ref: ArtifactRef, options?: CallOptions): Promise<SavedResult>;
  read<T extends Json>(
    ref: ArtifactRef,
    schema: ZodType<T>,
    options?: CallOptions,
  ): Promise<SavedResult<T>>;
  save<T extends Json>(
    completed: Completed<T>,
    options?: CallOptions,
  ): Promise<SavedResult<T>>;
}

const manifestEnvelope = z.looseObject({
  format: z.literal("themelios.result"),
  upstreamResults: z.array(artifactRefSchema),
});

export function parseManifest(
  ref: ArtifactRef,
  text: string,
): { result: SavedResult; upstreamResults: ArtifactRef[] } {
  const {
    format: _format,
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
  limits: ImportLimits,
): Results {
  async function prepare<T extends Json>(
    completed: Completed<T>,
    operation: string,
    options?: CallOptions,
  ): Promise<PreparedResult<T>> {
    database.requireWritable(operation);
    const scope = openCall(operation, options);
    try {
      const captured = captureResult(
        completed,
        Math.min(limits.maxInlineBytes, limits.maxImportBytes),
      );
      scope.throwIfAborted();
      const plan = await buildPlan(
        database,
        cas,
        limits,
        captured,
        scope.signal,
      );
      const saved = plan.root as SavedResult<T>;
      return {
        ref: saved.ref,
        ...prepareAdoption(database, operation, (tx) => {
          for (const [ref, item] of plan.newArtifacts) {
            if (!addArtifact(tx, item.artifact)) continue;
            for (const link of item.edges)
              storedArtifact(tx.sql, link.selection.ref);
            addEdges(tx, ref, item.edges);
            if (ref === saved.ref) retain(tx.sql, ref, tx.seq);
          }
          for (const entry of plan.representations)
            registerRepresentation(tx, entry);
          return structuredClone(saved);
        }),
      };
    } finally {
      scope.close();
    }
  }

  async function read(
    ref: ArtifactRef,
    options?: CallOptions,
  ): Promise<SavedResult>;
  async function read<T extends Json>(
    ref: ArtifactRef,
    schema: ZodType<T>,
    options?: CallOptions,
  ): Promise<SavedResult<T>>;
  async function read<T extends Json>(
    ref: ArtifactRef,
    schemaOrOptions?: CallOptions | ZodType<T>,
    options?: CallOptions,
  ) {
    const schema =
      schemaOrOptions && "safeParse" in schemaOrOptions
        ? schemaOrOptions
        : undefined;
    const scope = openCall(
      "content.read_result",
      schema ? options : (schemaOrOptions as CallOptions | undefined),
    );
    try {
      scope.throwIfAborted();
      const result = await loadResult(database, cas, ref, scope.signal);
      scope.throwIfAborted();
      return schema
        ? { ...result, value: validated(schema, result.value, ["value"]) }
        : result;
    } finally {
      scope.close();
    }
  }

  return {
    prepare<T extends Json>(completed: Completed<T>, options?: CallOptions) {
      return prepare<T>(completed, "results.prepare", options);
    },
    read,
    async save<T extends Json>(completed: Completed<T>, options?: CallOptions) {
      const prepared = await prepare<T>(completed, "results.save", options);
      try {
        throwIfAborted(options?.signal);
        return database.write((tx) => prepared.adopt(tx));
      } finally {
        await prepared.close();
      }
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
  const representations: Representation[] = [];
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
    return selectOutput(result.ref, result.files, material.output);
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
    const files: Record<string, SavedFile> = Object.create(null) as Record<
      string,
      SavedFile
    >;
    for (const file of node.files) {
      files[file.name] = {
        material: await resolve(file.material, upstream),
        sourceIndices: file.sourceIndices,
        ...(file.coverage === undefined ? {} : { coverage: file.coverage }),
      };
    }
    const { value, producer } = node;
    const manifest: ResultManifest = {
      format: "themelios.result",
      value,
      inputs,
      files,
      producer,
      upstreamResults: [...upstream],
    };
    const ref = newArtifactRef();
    const result: SavedResult = {
      ref,
      value,
      inputs,
      files,
      producer,
    };
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
      for (const output of key.outputs) selectOutput(ref, files, output);
      representations.push({
        source: key.source,
        purpose: "model-input",
        recipe: key.recipe,
        result: ref,
        outputs: key.outputs,
      });
    }
    return result;
  }

  const root = await build(captured);
  return { root, newArtifacts, representations };
}
