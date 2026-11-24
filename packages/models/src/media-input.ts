import { basename } from "node:path";
import {
  appError,
  decodeUtf8,
  hasTextControls,
  inlineMaterialSchema,
  isTextMedia,
  mediaProbeBytes,
  probeMediaType,
  textMediaForName,
  readMediaBytes,
  throwIfAborted,
  type CallOptions,
  type Completed,
  type InlineMaterial,
  type Material,
  type MediaInput,
  type RepresentationCoverage,
  type ResultOutput,
  type SavedResult,
  type Selection,
} from "@themelios/core";
import type {
  PreparationStore,
  TaskMaterial,
  TaskMaterialInput,
} from "./types.js";

export interface ResolvedMediaInput extends MediaInput {
  readonly storedSelection?: Selection;
  readonly coverage?: RepresentationCoverage;
}

export async function detectInlineMimeType(
  bytes: Uint8Array,
  declared?: string,
  name?: string,
): Promise<string> {
  const detected = await probeMediaType(
    bytes.subarray(0, mediaProbeBytes),
    declared,
  );
  if (detected) return detected;
  const byExtension = textMediaForName(name);
  try {
    const text = decodeUtf8(bytes);
    return (
      byExtension ??
      (hasTextControls(text) ? "application/octet-stream" : "text/plain")
    );
  } catch (error) {
    if (byExtension) throw error;
    return "application/octet-stream";
  }
}

export function rangeDescription(input: Pick<MediaInput, "range">): string {
  const range = input.range;
  if (!range) return "full";
  switch (range.kind) {
    case "text":
      return `bytes ${range.start}..${range.end}`;
    case "pages":
      return range.end === range.start + 1
        ? `page ${range.start}`
        : `pages ${range.start}..${range.end - 1}`;
    case "time":
      return `${range.startMs}ms..${range.endMs}ms`;
    case "image":
      return `region ${range.x},${range.y} ${range.width}x${range.height} px`;
    case "json":
      return `pointer ${range.pointer}`;
  }
}

function inlineMediaInput(material: InlineMaterial): ResolvedMediaInput {
  const parsed = inlineMaterialSchema.safeParse(material);
  if (!parsed.success) {
    throw appError("input.invalid", {
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String),
          reason: issue.message,
        })),
      },
    });
  }
  const { bytes, mediaType, name } = parsed.data;
  return {
    source: parsed.data,
    info: {
      mediaType,
      sizeBytes: bytes.byteLength,
      ...(name === undefined ? {} : { name }),
      extent: isTextMedia(mediaType)
        ? { kind: "text", bytes: bytes.byteLength }
        : { kind: "unknown" },
    },
    async open({ signal } = {}) {
      throwIfAborted(signal);
      return new Blob([new Uint8Array(bytes)]).stream();
    },
  };
}

function storeSelectionInput(
  selection: Extract<Material, { ref: string }>,
  store: PreparationStore,
): ResolvedMediaInput {
  const artifact = store.inspect(selection.ref);
  return {
    source: selection,
    storedSelection: selection,
    info: {
      mediaType: artifact.mediaType,
      sizeBytes: artifact.sizeBytes,
      ...(artifact.name === undefined ? {} : { name: artifact.name }),
      extent: artifact.extent,
    },
    ...(selection.range === undefined ? {} : { range: selection.range }),
    async open(options) {
      const read = await store.read(selection.ref, options);
      return read.body;
    },
  };
}

export function resolveResultOutput(
  result: Completed | SavedResult,
  output: string | undefined,
  store?: PreparationStore,
): ResolvedMediaInput {
  const source: ResultOutput = {
    result: "ref" in result ? result.ref : result,
    ...(output === undefined ? {} : { output }),
  };
  const target = output ?? "$value";
  if (target === "$value") {
    const jsonBytes = new TextEncoder().encode(
      JSON.stringify(result.value, null, 2),
    );
    return {
      source,
      info: {
        mediaType: "application/json",
        sizeBytes: jsonBytes.byteLength,
        name: "result.json",
        extent: { kind: "text", bytes: jsonBytes.byteLength },
      },
      async open({ signal } = {}) {
        throwIfAborted(signal);
        return new Blob([jsonBytes]).stream();
      },
    };
  }
  const file =
    "ref" in result
      ? Object.hasOwn(result.files, target)
        ? result.files[target]
        : undefined
      : result.files.find((entry) => entry.name === target);
  if (!file) {
    throw appError("content.output_not_found", {
      details: { output: target },
    });
  }
  return {
    ...resolvePart(file.material, store),
    source,
    ...(file.coverage === undefined ? {} : { coverage: file.coverage }),
  };
}

function resolvePart(
  material: Exclude<Material, ResultOutput>,
  store?: PreparationStore,
): ResolvedMediaInput {
  if ("bytes" in material) return inlineMediaInput(material);
  return storeSelectionInput(material, requireStore(store));
}

function requireStore(store?: PreparationStore): PreparationStore {
  if (!store)
    throw appError("input.capability_missing", {
      details: {
        required: "PreparationStore is required for stored materials",
      },
    });
  return store;
}

export async function resolveMedia(
  material: Material,
  store: PreparationStore | undefined,
  call: CallOptions,
): Promise<ResolvedMediaInput> {
  if (!("result" in material)) return resolvePart(material, store);
  const result =
    typeof material.result === "string"
      ? await requireStore(store).readResult(material.result, call)
      : material.result;
  return resolveResultOutput(result, material.output, store);
}

export async function normalizeMaterialInput(
  input: TaskMaterialInput,
  maxBytes: number,
  signal: AbortSignal,
): Promise<TaskMaterial> {
  if ("ref" in input)
    return { source: structuredClone(input), role: "primary" };
  const role = input.role === undefined ? {} : { role: input.role };
  if ("source" in input)
    return { source: structuredClone(input.source), ...role };
  if ("path" in input)
    return {
      source: await readLocalMaterial(input, maxBytes, signal),
      ...role,
    };
  const name = input.name === undefined ? {} : { name: input.name };
  const source =
    "text" in input
      ? {
          bytes: new TextEncoder().encode(input.text),
          mediaType: input.mediaType ?? "text/plain",
          ...name,
        }
      : {
          bytes: new Uint8Array(input.bytes),
          mediaType: input.mediaType,
          ...name,
        };
  return { source, ...role };
}

async function readLocalMaterial(
  input: Extract<TaskMaterialInput, { path: string }>,
  maxBytes: number,
  signal: AbortSignal,
) {
  throwIfAborted(signal);
  const file = Bun.file(input.path);
  if (!(await file.exists())) {
    throw appError("content.not_found", { details: { path: input.path } });
  }
  if (file.size > maxBytes) {
    throw appError("model.input_too_large", {
      details: { path: input.path, actualBytes: file.size, maxBytes },
    });
  }
  const bytes = await file.bytes();
  throwIfAborted(signal);
  const name = input.name ?? basename(input.path);
  const mediaType = await detectInlineMimeType(bytes, input.mediaType, name);
  return { bytes, mediaType, name };
}

export async function readMediaText(
  input: ResolvedMediaInput,
  store: PreparationStore | undefined,
  call: CallOptions,
  maxBytes: number,
): Promise<string> {
  if (input.storedSelection) {
    const range = input.range;
    const enforceBudget = (actualBytes: number) => {
      if (actualBytes > maxBytes)
        throw appError("model.input_too_large", {
          details: { mediaType: input.info.mediaType, actualBytes, maxBytes },
        });
    };
    if (range?.kind === "text") enforceBudget(range.end - range.start);
    if (!range) enforceBudget(input.info.sizeBytes);
    const text = await requireStore(store).text(input.storedSelection, call);
    enforceBudget(Buffer.byteLength(text));
    return text;
  }
  return decodeUtf8(await readMediaBytes(input, call, maxBytes));
}
