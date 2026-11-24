import { extname } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";
import { appError } from "./errors.js";

export const mediaTypeSchema = z
  .string()
  .regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/);

export const mediaProbeBytes = 16_384;

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
  const mime = declared?.toLowerCase();
  let detected: string | undefined;
  try {
    detected = (await fileTypeFromBuffer(prefix))?.mime;
  } catch (error) {
    if (!(error instanceof Error && error.name === "EndOfStreamError"))
      throw error;
  }
  if (
    mime !== undefined &&
    mime !== detected &&
    (signatureRequired.has(mime) ||
      (mime.startsWith("image/") && detected !== undefined))
  ) {
    throw appError("content.media_mismatch", {
      details: { declared: mime, detected: detected ?? null },
    });
  }
  return mime ?? detected;
}

export function textMediaForName(name?: string): string | undefined {
  return name ? textExtensions[extname(name).toLowerCase()] : undefined;
}

export function hasTextControls(text: string): boolean {
  for (const char of text) {
    if (char < " " && !"\r\n\t\f".includes(char)) return true;
  }
  return false;
}
