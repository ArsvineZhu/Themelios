import { type ArtifactInfo, type Materials } from "@themelios/content";
import {
  appError,
  decodeUtf8,
  materialSchema,
  parseValue,
  selectUtf8,
  type CallOptions,
  type Completed,
  type Json,
  type Material,
  type Range,
  type SavedResult,
  type Selection,
} from "@themelios/core";
import type { MediaInput } from "./input-contracts.js";
import { readMediaBytes } from "./media-bytes.js";

const encoder = new TextEncoder();
export interface ResolvedMediaInput extends MediaInput {
  readonly selection?: Selection;
}

function valueText(value: Json): string {
  return typeof value === "string"
    ? value
    : JSON.stringify(value, null, 2) + "\n";
}

function bytesInput(
  source: Material,
  bytes: Uint8Array,
  mediaType: string,
  name?: string,
): ResolvedMediaInput {
  const info: MediaInput["info"] = {
    mediaType,
    sizeBytes: bytes.byteLength,
    extent: mediaType.startsWith("text/")
      ? { kind: "text", bytes: bytes.byteLength }
      : { kind: "unknown" },
    ...(name === undefined ? {} : { name }),
  };
  return {
    source,
    info,
    async open() {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          if (bytes.length) controller.enqueue(bytes);
          controller.close();
        },
      });
    },
  };
}

function formalInput(
  source: Material,
  info: ArtifactInfo,
  materials: Materials,
  range?: Range,
): ResolvedMediaInput {
  return {
    source,
    info,
    ...(range === undefined ? {} : { range }),
    selection: { ref: info.ref, ...(range === undefined ? {} : { range }) },
    async open(options) {
      return (await materials.read(info.ref, options)).body;
    },
  };
}

function outputMaterial(result: Completed | SavedResult, name: string) {
  if ("ref" in result) {
    if (Object.hasOwn(result.files, name)) return result.files[name]?.material;
  } else {
    return result.files.find((file) => file.name === name)?.material;
  }
}

export function resolveMedia(
  source: Material,
  materials?: Materials,
): ResolvedMediaInput {
  const selected = parseValue(materialSchema, source);
  if ("ref" in selected) {
    if (!materials)
      throw appError("input.capability_missing", {
        details: { required: "materials.read", ref: selected.ref },
      });
    return formalInput(
      selected,
      materials.inspect(selected.ref),
      materials,
      selected.range,
    );
  }
  if ("bytes" in selected)
    return bytesInput(
      selected,
      selected.bytes,
      selected.mediaType,
      selected.name,
    );
  const { result, output = "$value" } = selected;
  if (output === "$value") {
    const value = valueText(result.value);
    return bytesInput(
      source,
      encoder.encode(value),
      typeof result.value === "string" ? "text/plain" : "application/json",
    );
  }
  const material = outputMaterial(result, output);
  if (!material) {
    const availableNames =
      "ref" in result
        ? Object.keys(result.files)
        : result.files.map((file) => file.name);
    throw appError("content.output_not_found", {
      details: { output, availableNames: ["$value", ...availableNames] },
    });
  }
  return { ...resolveMedia(material, materials), source };
}

export async function readMediaText(
  input: ResolvedMediaInput,
  materials: Materials | undefined,
  options: CallOptions,
  maxBytes: number,
): Promise<string> {
  const mime = input.info.mediaType;
  const syntax = mime === "application/json" || mime.endsWith("+json");
  if (
    input.selection &&
    materials &&
    (input.range || syntax || mime === "text/plain" || mime === "text/markdown")
  ) {
    const size = materialBytes(input);
    if (size > maxBytes) {
      throw appError("model.input_too_large", {
        details: { actualBytes: size, maxBytes },
      });
    }
    return materials.text(input.selection, options);
  }
  const bytes = await readMediaBytes(input, options, maxBytes);
  if (input.range && input.range.kind !== "text") {
    throw appError("content.selection_invalid", {
      details: { kind: input.range.kind },
    });
  }
  if (syntax) {
    if (input.range)
      throw appError("content.selection_invalid", {
        details: { kind: input.range.kind },
      });
    try {
      return valueText(
        JSON.parse(decodeUtf8(bytes).replace(/^\uFEFF/, "")) as Json,
      );
    } catch (cause) {
      throw appError("content.decode_failed", {
        details: { mediaType: "application/json" },
        cause,
      });
    }
  }
  // Check the original encoding even when the selected span would itself decode as UTF-8.
  if (input.range) {
    decodeUtf8(bytes);
    return decodeUtf8(selectUtf8(bytes, input.range));
  }
  return decodeUtf8(bytes);
}

export function rangeDescription(input: MediaInput): string {
  const range = input.range;
  if (!range) return "whole";
  switch (range.kind) {
    case "text":
      return "UTF-8 bytes [" + range.start + "," + range.end + ")";
    case "pages":
      return "pages [" + range.start + "," + range.end + ")";
    case "time":
      return "milliseconds [" + range.startMs + "," + range.endMs + ")";
    case "image":
      return (
        "pixels " +
        range.x +
        "," +
        range.y +
        " " +
        range.width +
        "×" +
        range.height
      );
    case "json":
      return "JSON Pointer " + JSON.stringify(range.pointer);
  }
}

/** Formal text ranges only hold their selected bytes; other representations may require the full original. */
export function materialBytes(input: ResolvedMediaInput): number {
  const range = input.selection?.range;
  return range?.kind === "text"
    ? range.end - range.start
    : input.info.sizeBytes;
}
