import { extname } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";
import { appError } from "./errors.js";
import { parseValue } from "./json.js";

export const mediaTypeSchema = z
  .string()
  .regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/)
  .toLowerCase();

export const plainTextMediaType = "text/plain";

export const mediaProbeBytes = 16_384;

const textExtensions: Partial<Record<string, string>> = {
  ".txt": plainTextMediaType,
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
};

export function isJsonMedia(mediaType: string): boolean {
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

export function isTextMedia(mediaType: string): boolean {
  return mediaType.startsWith("text/") || isJsonMedia(mediaType);
}

export function matchesMime(pattern: string, mediaType: string): boolean {
  return (
    pattern === mediaType ||
    (pattern.endsWith("/*") && mediaType.startsWith(pattern.slice(0, -1)))
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
const sqliteHeader = new TextEncoder().encode("SQLite format 3\0");

/** Check declared MIME against the actual binary signature of a captured prefix. */
export async function probeMediaType(
  prefix: Uint8Array,
  declared?: string,
): Promise<string | undefined> {
  const mime =
    declared === undefined ? undefined : parseValue(mediaTypeSchema, declared);
  let detected: string | undefined;
  try {
    detected = (await fileTypeFromBuffer(prefix))?.mime;
    // A prose note can begin with the shorter prefix reported by file-type.
    if (
      detected === "application/x-sqlite3" &&
      !sqliteHeader.every((byte, index) => prefix[index] === byte)
    ) {
      detected = undefined;
    }
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
