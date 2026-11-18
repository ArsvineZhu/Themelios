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
  type SavedFile,
  type SavedResult,
  type Selection,
} from "@themelios/core";
import type { Cas, Database } from "@themelios/storage";
import { z, type ZodType } from "zod";
import {
  addArtifact,
  addEdges,
  newArtifactRef,
  prepareAdoption,
  retain,
  storedArtifact,
  type ArtifactDraft,
} from "./artifacts.js";
import type {
  PreparedResult,
  ResultManifest,
  Results,
  SourceLink,
} from "./contracts.js";
import { captureImport, importArtifact, type ImportLimits } from "./imports.js";
import {
  captureResult,
  resultLinks,
  selectOutput,
  type CapturedMaterial,
  type CapturedResult,
} from "./result-graph.js";
import {
  rawBytes,
  resultMediaType,
  utf8Text,
  validateSelection,
} from "./selections.js";
import { contentError, jsonValue, validated } from "./validation.js";
import type { ScheduleContentWrite } from "./write-schedule.js";

const manifestEnvelope = z.looseObject({
  format: z.literal("themelios.result/1"),
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
  scheduleWrite: ScheduleContentWrite,
): Results {
  async function prepare<T extends Json>(
    captured: CapturedResult,
    signal: AbortSignal,
  ): Promise<PreparedResult<T>> {
    throwIfAborted(signal);
    const plan = await buildPlan(database, cas, limits, captured, signal);
    const saved = plan.root as SavedResult<T>;
    return {
      ref: saved.ref,
      ...prepareAdoption(database, "results.prepare", (tx) => {
        for (const [ref, item] of plan.newArtifacts) {
          // Edges are inserted only for newly adopted result rows.
          if (!addArtifact(tx, item.artifact)) continue;
          for (const link of item.edges)
            storedArtifact(tx.sql, link.selection.ref);
          addEdges(tx, ref, item.edges);
          if (ref === saved.ref) retain(tx.sql, ref, tx.seq);
        }
        return structuredClone(saved);
      }),
    };
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
      return scheduleWrite(
        "results.prepare",
        () => {
          database.requireWritable("results.prepare");
          const captured = captureResult(completed, limits.maxInlineBytes);
          return (signal) => prepare<T>(captured, signal);
        },
        options,
      );
    },
    read,
    save<T extends Json>(completed: Completed<T>, options?: CallOptions) {
      return scheduleWrite(
        "results.save",
        () => {
          database.requireWritable("results.save");
          const captured = captureResult(completed, limits.maxInlineBytes);
          return async (signal) => {
            const prepared = await prepare<T>(captured, signal);
            try {
              throwIfAborted(signal);
              return database.write((tx) => prepared.adopt(tx));
            } finally {
              await prepared.close();
            }
          };
        },
        options,
      );
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
  captured: CapturedResult,
  signal: AbortSignal,
) {
  const newArtifacts = new Map<ArtifactRef, PlannedArtifact>();
  const inlines = new WeakMap<InlineMaterial, ArtifactRef>();
  const results = new WeakMap<CapturedResult, SavedResult>();
  const existingResults = new Map<ArtifactRef, SavedResult>();
  const lookup = (ref: ArtifactRef): ArtifactDraft =>
    newArtifacts.get(ref)?.artifact ??
    database.read((tx) => storedArtifact(tx.sql, ref));

  async function resolve(
    material: CapturedMaterial,
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
    if ("ref" in material.result) {
      result =
        existingResults.get(material.result.ref) ??
        (await loadResult(database, cas, material.result.ref, signal));
      existingResults.set(result.ref, result);
    } else {
      result = await build(material.result);
    }
    upstreamResults.add(result.ref);
    return selectOutput(result.ref, result.files, material.output);
  }

  async function build(node: CapturedResult): Promise<SavedResult> {
    const reused = results.get(node);
    if (reused) return reused;
    const upstream = new Set<ArtifactRef>();
    const inputs: InputUse<Selection>[] = [];
    for (const use of node.inputs) {
      const source = await resolve(use.source, upstream);
      const delivered: Selection[] = [];
      for (const material of use.delivered)
        delivered.push(await resolve(material, upstream));
      inputs.push({ source, delivered, role: use.role });
    }
    const files: Record<string, SavedFile> = Object.create(null) as Record<
      string,
      SavedFile
    >;
    for (const file of node.files) {
      files[file.name] = {
        material: await resolve(file.material, upstream),
        sourceIndices: file.sourceIndices,
      };
    }
    const { value, producer, mappings } = node;
    for (const mapping of mappings ?? []) {
      const file = files[mapping.output]!;
      const outputInfo = lookup(file.material.ref);
      const sourceInfo = lookup(mapping.source.ref);
      await verifyCopy(
        cas,
        file.material,
        [outputInfo, sourceInfo],
        mapping,
        signal,
      );
    }
    const manifest: ResultManifest = {
      format: "themelios.result/1",
      value,
      inputs,
      files,
      producer,
      upstreamResults: [...upstream],
      ...(mappings === undefined ? {} : { mappings }),
    };
    const ref = newArtifactRef();
    const result: SavedResult = {
      ref,
      value,
      inputs,
      files,
      producer,
      ...(mappings === undefined ? {} : { mappings }),
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
    return result;
  }

  const root = await build(captured);
  return { root, newArtifacts };
}

async function verifyCopy(
  cas: Cas,
  file: Selection,
  [outputInfo, sourceInfo]: [ArtifactDraft, ArtifactDraft],
  mapping: NonNullable<Completed["mappings"]>[number],
  signal: AbortSignal,
): Promise<void> {
  function mismatch(): never {
    throw contentError("content.mapping_invalid", {
      output: mapping.output,
      range: mapping.range,
      source: { ...mapping.source },
    });
  }
  if (file.range && file.range.kind !== "text") mismatch();
  const base = file.range?.start ?? 0;
  if (file.range?.kind === "text" && mapping.range.end > file.range.end - base)
    mismatch();
  const outputRange = {
    kind: "text" as const,
    start: base + mapping.range.start,
    end: base + mapping.range.end,
  };
  const sourceRange = mapping.source.range;
  if (sourceRange?.kind !== "text") mismatch();
  const length = outputRange.end - outputRange.start;
  if (length !== sourceRange.end - sourceRange.start) mismatch();
  try {
    await validateSelection(cas, sourceInfo, mapping.source, signal);
    await validateSelection(
      cas,
      outputInfo,
      { ref: file.ref, range: outputRange },
      signal,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "content.range_invalid"
    )
      mismatch();
    throw error;
  }
  if (
    !(await equalBytes(
      cas,
      [sourceInfo, sourceRange.start],
      [outputInfo, outputRange.start],
      length,
      signal,
    ))
  )
    mismatch();
}

async function equalBytes(
  cas: Cas,
  source: [ArtifactDraft, number],
  output: [ArtifactDraft, number],
  length: number,
  signal: AbortSignal,
): Promise<boolean> {
  const chunkBytes = 256 * 1024;
  const chunk = (
    [artifact, start]: [ArtifactDraft, number],
    offset: number,
    size: number,
  ) =>
    rawBytes(cas, artifact, signal, {
      start: start + offset,
      end: start + offset + size,
    });
  for (let offset = 0; offset < length; offset += chunkBytes) {
    const size = Math.min(chunkBytes, length - offset);
    const expected = await chunk(source, offset, size);
    const actual = await chunk(output, offset, size);
    if (
      !Buffer.from(
        expected.buffer,
        expected.byteOffset,
        expected.byteLength,
      ).equals(actual)
    )
      return false;
  }
  return true;
}
