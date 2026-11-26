import { basename } from "node:path";
import {
  appError,
  decodeUtf8,
  hasTextControls,
  inlineMaterialSchema,
  isTextMedia,
  plainTextMediaType,
  mediaProbeBytes,
  probeMediaType,
  textMediaForName,
  readMediaBytes,
  resultFile,
  resultValueOutput,
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
import type { LocalTaskSource, PreparationStore, TaskSource } from "./types.js";

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
      (hasTextControls(text) ? "application/octet-stream" : plainTextMediaType)
    );
  } catch (error) {
    if (byExtension) throw error;
    return "application/octet-stream";
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
  const artifact = store.materials.inspect(selection.ref);
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
      const read = await store.materials.read(selection.ref, options);
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
  const target = output ?? resultValueOutput;
  if (target === resultValueOutput) {
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
  const file = resultFile(result, target);
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
  material: TaskSource,
  store: PreparationStore | undefined,
  call: CallOptions,
  maxInlineBytes: number,
  sourceKey: string,
): Promise<ResolvedMediaInput> {
  if ("file" in material || "bytes" in material) {
    const local = "file" in material;
    const resolved = local
      ? await readLocalMaterial(material, maxInlineBytes, call.signal)
      : material;
    const input = inlineMediaInput(resolved);
    if (input.info.sizeBytes > maxInlineBytes)
      throw appError("content.inline_too_large", {
        details: {
          sourceKey,
          actualBytes: input.info.sizeBytes,
          maxBytes: maxInlineBytes,
        },
      });
    if (!local)
      await detectInlineMimeType(
        resolved.bytes,
        input.info.mediaType,
        input.info.name,
      );
    return input;
  }
  if (!("result" in material)) return resolvePart(material, store);
  const result =
    typeof material.result === "string"
      ? await requireStore(store).results.read(material.result, call)
      : material.result;
  return resolveResultOutput(result, material.output, store);
}

async function readLocalMaterial(
  input: LocalTaskSource,
  maxBytes: number,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  const file = Bun.file(input.file);
  if (!(await file.exists())) {
    throw appError("content.not_found", { details: { path: input.file } });
  }
  if (file.size > maxBytes) {
    throw appError("model.input_too_large", {
      details: { path: input.file, actualBytes: file.size, maxBytes },
    });
  }
  const bytes = await file.bytes();
  throwIfAborted(signal);
  const name = input.name ?? basename(input.file);
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
    const text = await requireStore(store).materials.text(
      input.storedSelection,
      call,
    );
    enforceBudget(Buffer.byteLength(text));
    return text;
  }
  return decodeUtf8(await readMediaBytes(input, call, maxBytes));
}
