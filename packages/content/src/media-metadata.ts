import {
  AppError,
  hasTextControls,
  isTextMedia,
  mediaProbeBytes,
  probeMediaType,
  textMediaForName,
  type Extent,
} from "@themelios/core";
import type { BlobInfo, Cas } from "@themelios/storage";
import { contentError } from "./validation.js";

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
      if (forbidControls && hasTextControls(part)) return false;
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
  const extensionType = textMediaForName(name);
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
    end: Math.min(mediaProbeBytes, blob.sizeBytes),
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
