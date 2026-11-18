import { extname } from "node:path";
import { AppError } from "@themelios/core";
import type { BlobInfo, Cas } from "@themelios/storage";
import { fileTypeFromBuffer } from "file-type";
import type { Extent } from "./artifacts.js";
import { contentError } from "./validation.js";

const textExtensions: Partial<Record<string, string>> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
};

export function isTextMedia(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType.endsWith("+json")
  );
}

export async function blobBytes(
  cas: Cas,
  blob: BlobInfo,
  signal: AbortSignal,
  range?: { start: number; end: number },
): Promise<Uint8Array> {
  const body = await cas.read(blob.ref, { signal, ...range });
  return new Uint8Array(await new Response(body).arrayBuffer());
}

async function validUtf8(
  cas: Cas,
  blob: BlobInfo,
  signal: AbortSignal,
  forbidControls: boolean,
): Promise<boolean> {
  const body = await cas.read(blob.ref, { signal });
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    for (
      let next = await reader.read();
      !next.done;
      next = await reader.read()
    ) {
      const part = decoder.decode(next.value, { stream: true });
      if (
        forbidControls &&
        [...part].some((char) => char < " " && !"\r\n\t\f".includes(char))
      )
        return false;
    }
    decoder.decode();
    return true;
  } catch (error) {
    if (error instanceof TypeError && !signal.aborted) return false;
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

const signatureRequired = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/tiff",
  "image/avif",
]);

/** Check declared MIME against the actual binary signature of a captured prefix. */
export async function probeMediaType(
  prefix: Uint8Array,
  declared?: string,
): Promise<string | undefined> {
  let detected: string | undefined;
  try {
    detected = (await fileTypeFromBuffer(prefix))?.mime;
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
    throw contentError("content.media_mismatch", {
      declared,
      detected: detected ?? null,
    });
  }
  return declared ?? detected;
}

type Metadata = { mediaType: string; extent: Extent };

function textMetadata(mediaType: string, sizeBytes: number): Metadata {
  return { mediaType, extent: { kind: "text", bytes: sizeBytes } };
}

function invalidUtf8(mediaType: string): never {
  throw contentError("content.decode_failed", {
    mediaType,
    reason: "invalid UTF-8",
  });
}

async function detectTextOrBinary(
  cas: Cas,
  blob: BlobInfo,
  signal: AbortSignal,
  name?: string,
): Promise<Metadata> {
  const extensionType =
    name === undefined
      ? undefined
      : textExtensions[extname(name).toLowerCase()];
  if (await validUtf8(cas, blob, signal, extensionType === undefined))
    return textMetadata(extensionType ?? "text/plain", blob.sizeBytes);
  if (extensionType) invalidUtf8(extensionType);
  return { mediaType: "application/octet-stream", extent: { kind: "unknown" } };
}

async function imageExtent(
  cas: Cas,
  blob: BlobInfo,
  signal: AbortSignal,
  mediaType: string,
): Promise<Extent> {
  try {
    const { default: sharp } = await import("sharp");
    const { width, height, autoOrient, pages } = await sharp(
      await blobBytes(cas, blob, signal),
    ).metadata();
    return {
      kind: "image",
      width: autoOrient?.width ?? width,
      height: autoOrient?.height ?? height,
      frames: pages ?? 1,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw contentError(
      "content.decode_failed",
      { mediaType, reason: String(error) },
      error,
    );
  }
}

export async function detectMetadata(
  cas: Cas,
  blob: BlobInfo,
  signal: AbortSignal,
  declared?: string,
  name?: string,
): Promise<{ mediaType: string; extent: Extent }> {
  const prefix = await blobBytes(cas, blob, signal, {
    start: 0,
    end: Math.min(16_384, blob.sizeBytes),
  });
  const mediaType = await probeMediaType(prefix, declared);
  if (!mediaType) return detectTextOrBinary(cas, blob, signal, name);
  if (isTextMedia(mediaType)) {
    if (!(await validUtf8(cas, blob, signal, false))) invalidUtf8(mediaType);
    return textMetadata(mediaType, blob.sizeBytes);
  }
  if (mediaType.startsWith("image/"))
    return {
      mediaType,
      extent: await imageExtent(cas, blob, signal, mediaType),
    };
  return { mediaType, extent: { kind: "unknown" } };
}
