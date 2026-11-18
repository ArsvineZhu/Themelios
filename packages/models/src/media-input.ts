import { basename, extname } from "node:path";
import {
  appError,
  decodeUtf8,
  openCall,
  selectUtf8,
  throwIfAborted,
  type CallOptions,
  type Completed,
  type Material,
  type Range,
  type SavedResult,
} from "@themelios/core";
import { fileTypeFromBuffer } from "file-type";
import type {
  MediaInput,
  PreparationStore,
  TaskMaterial,
  TaskMaterialInput,
} from "./types.js";

const extensionMimes: Readonly<Record<string, string>> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
};

const signatureRequired = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/tiff",
  "image/avif",
]);

export function isTextMedia(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType.endsWith("+json")
  );
}

/** Reads one media stream under byte and cancellation budgets. */
export async function readMediaBytes(
  input: MediaInput,
  options?: CallOptions,
  maxBytes = 67_108_864,
): Promise<Uint8Array> {
  const scope = openCall("input.media_read", options);
  const oversized = (actual: number): never => {
    throw appError("model.input_too_large", {
      details: {
        name: input.info.name ?? null,
        mediaType: input.info.mediaType,
        maxBytes,
        actualBytes: actual,
      },
    });
  };
  try {
    scope.throwIfAborted();
    if (input.info.sizeBytes > maxBytes) oversized(input.info.sizeBytes);
    const body = await input.open({ signal: scope.signal });
    const reader = body.getReader();
    const abort = () => {
      void reader.cancel(scope.signal.reason).catch(() => undefined);
    };
    scope.signal.addEventListener("abort", abort, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    let done = false;
    try {
      while (!done) {
        scope.throwIfAborted();
        const next = await reader.read();
        done = next.done;
        scope.throwIfAborted();
        if (!next.done) {
          size += next.value.byteLength;
          if (size > maxBytes) oversized(size);
          chunks.push(next.value);
        }
      }
    } finally {
      scope.signal.removeEventListener("abort", abort);
      if (!done) abort();
      reader.releaseLock();
    }
    if (chunks.length === 1) return chunks[0]!;
    const bytes = new Uint8Array(size);
    let cursor = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    return bytes;
  } finally {
    scope.close();
  }
}

export async function detectInlineMimeType(
  bytes: Uint8Array,
  declared?: string,
  name?: string,
): Promise<string> {
  let detected: string | undefined;
  try {
    detected = (await fileTypeFromBuffer(bytes.subarray(0, 16_384)))?.mime;
  } catch (error) {
    if (!(error instanceof Error && error.name === "EndOfStreamError"))
      throw error;
  }
  if (
    declared !== undefined &&
    declared !== detected &&
    (signatureRequired.has(declared) ||
      (declared.startsWith("image/") && detected !== undefined))
  ) {
    throw appError("content.media_mismatch", {
      details: { declared, detected: detected ?? null },
    });
  }
  if (declared) return declared;
  if (detected) return detected;
  const byExt = name ? extensionMimes[extname(name).toLowerCase()] : undefined;
  if (byExt) return byExt;
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return "text/plain";
  } catch {
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

function inlineMediaInput(material: {
  bytes: Uint8Array;
  mediaType: string;
  name?: string;
}): MediaInput {
  const bytes = material.bytes;
  return {
    source: material,
    info: {
      mediaType: material.mediaType,
      sizeBytes: bytes.byteLength,
      ...(material.name === undefined ? {} : { name: material.name }),
      extent: isTextMedia(material.mediaType)
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
): MediaInput {
  const artifact = store.inspect(selection.ref);
  return {
    source: selection,
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

function resultOutputInput(
  material: { result: Completed | SavedResult; output?: string },
  store?: PreparationStore,
): MediaInput {
  const target = material.output ?? "$value";
  if (target === "$value") {
    const jsonBytes = new TextEncoder().encode(
      JSON.stringify(material.result.value, null, 2),
    );
    return {
      source: material,
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
  if ("files" in material.result && Array.isArray(material.result.files)) {
    const found = material.result.files.find((f) => f.name === target);
    if (!found) {
      throw appError("content.output_not_found", {
        details: { output: target },
      });
    }
    return resolveMedia(found.material, store);
  }
  const saved = material.result as SavedResult;
  const savedFile = Object.hasOwn(saved.files, target)
    ? saved.files[target]
    : undefined;
  if (!savedFile) {
    throw appError("content.output_not_found", {
      details: { output: target },
    });
  }
  return resolveMedia(savedFile.material, store);
}

export function resolveMedia(
  material: Material,
  store?: PreparationStore,
): MediaInput {
  if ("bytes" in material) return inlineMediaInput(material);
  if ("ref" in material) {
    if (!store) {
      throw appError("input.capability_missing", {
        details: {
          required: "PreparationStore is required for Selection inputs",
        },
      });
    }
    return storeSelectionInput(material, store);
  }
  return resultOutputInput(material, store);
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

function readJsonPointerValue(
  text: string,
  range: Extract<Range, { kind: "json" }>,
): string {
  let current: unknown = JSON.parse(
    text.startsWith("\uFEFF") ? text.slice(1) : text,
  );
  if (range.pointer) {
    for (const part of range.pointer.slice(1).split("/")) {
      const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
      if (
        current === null ||
        typeof current !== "object" ||
        !Object.hasOwn(current, key)
      ) {
        throw appError("content.range_invalid", {
          details: {
            pointer: range.pointer,
            reason: "JSON Pointer does not resolve",
          },
        });
      }
      current = (current as Record<string, unknown>)[key];
    }
  }
  return typeof current === "string"
    ? current
    : JSON.stringify(current, null, 2);
}

export async function readMediaText(
  input: MediaInput,
  store: PreparationStore | undefined,
  call: CallOptions,
  maxBytes: number,
): Promise<string> {
  if ("ref" in input.source && store) {
    return store.text(input.source, call);
  }
  const bytes = await readMediaBytes(input, call, maxBytes);
  const range = input.range;
  if (range?.kind === "text") return decodeUtf8(selectUtf8(bytes, range));
  const full = decodeUtf8(bytes);
  if (range?.kind === "json") return readJsonPointerValue(full, range);
  return full;
}
