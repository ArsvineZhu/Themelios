import { rangeSchema, type Range, type Selection } from "@themelios/core";
import type { Cas } from "@themelios/storage";
import type { ArtifactDraft } from "./artifacts.js";
import { blobBytes, isTextMedia } from "./media-metadata.js";
import { contentError, jsonValue } from "./validation.js";

export const resultMediaType = "application/vnd.themelios.result+json";

function invalidRange(selection: Selection, reason: string): never {
  throw contentError("content.range_invalid", {
    ref: selection.ref,
    range: selection.range ?? null,
    reason,
  });
}

export function rangeKey(range?: Range): string {
  if (range === undefined) return "";
  return JSON.stringify(rangeSchema.parse(range));
}

export function checkExtent(
  artifact: ArtifactDraft,
  selection: Selection,
): void {
  const range = selection.range;
  if (!range) return;
  switch (range.kind) {
    case "text":
      if (!isTextMedia(artifact.mediaType) || range.end > artifact.sizeBytes)
        invalidRange(selection, "text byte interval is outside the material");
      break;
    case "json":
      if (!isJson(artifact.mediaType))
        invalidRange(selection, "material is not JSON");
      break;
    default: {
      const reason = outsideMediaExtent(artifact, range);
      if (reason) invalidRange(selection, reason);
    }
  }
}

function outsideMediaExtent(
  { extent, mediaType }: ArtifactDraft,
  range: Extract<Range, { kind: "image" | "pages" | "time" }>,
): string | undefined {
  switch (range.kind) {
    case "image":
      if (
        extent.kind !== "image" ||
        range.x + range.width > extent.width ||
        range.y + range.height > extent.height
      )
        return "pixel rectangle is outside the image";
      break;
    case "pages":
      if (
        mediaType !== "application/pdf" ||
        (extent.kind === "pages" && range.end > extent.pages + 1)
      )
        return "page interval is outside the document";
      break;
    case "time":
      if (
        !/^(audio|video)\//.test(mediaType) ||
        (extent.kind === "time" && range.endMs > extent.durationMs)
      )
        return "time interval is outside the media";
      break;
  }
}

function isJson(mediaType: string): boolean {
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

export async function rawBytes(
  cas: Cas,
  artifact: ArtifactDraft,
  signal: AbortSignal,
  range?: { start: number; end: number },
) {
  return blobBytes(
    cas,
    { ref: artifact.blob, sizeBytes: artifact.sizeBytes },
    signal,
    range,
  );
}

export function utf8Text(
  bytes: Uint8Array,
  artifact: ArtifactDraft,
  selection?: Selection,
): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (error) {
    if (selection?.range)
      invalidRange(selection, "interval is not aligned to UTF-8 code points");
    throw contentError(
      "content.decode_failed",
      { mediaType: artifact.mediaType, reason: "invalid UTF-8" },
      error,
    );
  }
}

async function checkedTextBytes(
  cas: Cas,
  artifact: ArtifactDraft,
  selection: Selection,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const range = selection.range;
  if (range?.kind !== "text")
    invalidRange(selection, "expected a text interval");
  checkExtent(artifact, selection);
  const end = Math.min(artifact.sizeBytes, range.end + 1);
  const bytes = await rawBytes(cas, artifact, signal, {
    start: range.start,
    end,
  });
  const length = range.end - range.start;
  if (
    ((bytes[0] ?? 0) & 0xc0) === 0x80 ||
    ((bytes[length] ?? 0) & 0xc0) === 0x80
  ) {
    invalidRange(selection, "interval is not aligned to UTF-8 code points");
  }
  return bytes.subarray(0, length);
}

async function selectedJson(
  cas: Cas,
  artifact: ArtifactDraft,
  selection: Selection,
  signal: AbortSignal,
): Promise<unknown> {
  const text = utf8Text(await rawBytes(cas, artifact, signal), artifact);
  // JSON accepts a UTF-8 BOM on input. Text selections still retain its original bytes.
  let value = jsonValue(
    text.startsWith("\uFEFF") ? text.slice(1) : text,
    artifact.ref,
  );
  const path = selection.range?.kind === "json" ? selection.range.pointer : "";
  if (!path) return value;
  for (const part of path.slice(1).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key))
      invalidRange(selection, "invalid JSON array index");
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, key)
    )
      invalidRange(selection, "JSON Pointer does not resolve");
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export async function validateSelection(
  cas: Cas,
  artifact: ArtifactDraft,
  selection: Selection,
  signal: AbortSignal,
): Promise<void> {
  checkExtent(artifact, selection);
  switch (selection.range?.kind) {
    case "text": {
      // Only the boundary bytes are needed for validation, even for large selections.
      for (const offset of new Set([
        selection.range.start,
        selection.range.end,
      ])) {
        if (offset === artifact.sizeBytes) continue;
        const bytes = await rawBytes(cas, artifact, signal, {
          start: offset,
          end: offset + 1,
        });
        if (((bytes[0] ?? 0) & 0xc0) === 0x80)
          invalidRange(
            selection,
            "interval is not aligned to UTF-8 code points",
          );
      }
      break;
    }
    case "json":
      await selectedJson(cas, artifact, selection, signal);
      break;
  }
}

export async function selectionText(
  cas: Cas,
  artifact: ArtifactDraft,
  selection: Selection,
  signal: AbortSignal,
): Promise<string> {
  checkExtent(artifact, selection);
  if (
    selection.range?.kind === "json" ||
    (selection.range === undefined && isJson(artifact.mediaType))
  ) {
    const value = await selectedJson(cas, artifact, selection, signal);
    return typeof value === "string"
      ? value
      : `${JSON.stringify(value, null, 2)}\n`;
  }
  if (selection.range?.kind === "text") {
    return utf8Text(
      await checkedTextBytes(cas, artifact, selection, signal),
      artifact,
      selection,
    );
  }
  if (
    selection.range === undefined &&
    ["text/plain", "text/markdown"].includes(artifact.mediaType)
  ) {
    return utf8Text(await rawBytes(cas, artifact, signal), artifact);
  }
  throw contentError("content.text_unavailable", {
    ref: artifact.ref,
    mediaType: artifact.mediaType,
  });
}
