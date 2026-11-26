import { z } from "zod";
import { appError } from "./errors.js";
import { jsonPointerSchema } from "./json.js";
import { mediaTypeSchema, plainTextMediaType } from "./media-type.js";

export const artifactRefSchema = z
  .string()
  .regex(
    /^art_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  )
  .meta({ "x-themelios-ref": true });
export const blobDigestAlgorithm = "sha256";
export const blobRefPrefix = `${blobDigestAlgorithm}:`;
export const blobDigestHexLength = 64;
export const blobDigestHexCharacters = "0-9a-f";
const digestHexPattern = `[${blobDigestHexCharacters}]{${blobDigestHexLength}}`;
export const blobDigestHexSchema = z
  .string()
  .regex(new RegExp(`^${digestHexPattern}$`));
export const blobRefSchema = z
  .string()
  .regex(new RegExp(`^${blobRefPrefix}${digestHexPattern}$`));

export function blobRefFromDigest(digest: string): BlobRef {
  return `${blobRefPrefix}${blobDigestHexSchema.parse(digest)}`;
}
export const commitPointSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(
    (value) => value.length < 19 || value <= "9223372036854775807",
    "Commit point exceeds the signed 64-bit range",
  );

export type ArtifactRef = z.infer<typeof artifactRefSchema>;
export type BlobRef = z.infer<typeof blobRefSchema>;
export type CommitPoint = z.infer<typeof commitPointSchema>;

const offset = z.int().nonnegative();
const positive = z.int().positive();

export const textRangeSchema = z
  .strictObject({ start: offset, end: offset })
  .refine((value) => value.start <= value.end, {
    path: ["end"],
    message: "End must be at or after start",
  });

export const rangeSchema = z.discriminatedUnion("kind", [
  textRangeSchema.safeExtend({ kind: z.literal("text") }),
  z
    .strictObject({ kind: z.literal("pages"), start: positive, end: positive })
    .refine((value) => value.start < value.end, {
      path: ["end"],
      message: "End must be after start",
    }),
  z
    .strictObject({
      kind: z.literal("time"),
      startMs: z.number().nonnegative(),
      endMs: z.number().positive(),
    })
    .refine((value) => value.startMs < value.endMs, {
      path: ["endMs"],
      message: "End must be after start",
    }),
  z.strictObject({
    kind: z.literal("image"),
    x: offset,
    y: offset,
    width: positive,
    height: positive,
  }),
  z.strictObject({
    kind: z.literal("json"),
    pointer: jsonPointerSchema,
  }),
]);

export type Range = z.infer<typeof rangeSchema>;

/** Encodes a range independently of the caller's property order. */
export function selectionRangeKey(range?: Range): string {
  return range === undefined ? "" : JSON.stringify(rangeSchema.parse(range));
}

export const selectionSchema = z.strictObject({
  ref: artifactRefSchema,
  range: rangeSchema.optional(),
});
export type Selection = z.infer<typeof selectionSchema>;

export const inlineMaterialSchema = z.strictObject({
  bytes: z.instanceof(Uint8Array<ArrayBufferLike>),
  mediaType: mediaTypeSchema,
  name: z.string().min(1).optional(),
});
export type InlineMaterial = z.output<typeof inlineMaterialSchema>;

/** Constructs plain UTF-8 input for operations that consume inline material. */
export function inlineText(text: string, name?: string): InlineMaterial {
  return {
    bytes: new TextEncoder().encode(text),
    mediaType: plainTextMediaType,
    ...(name === undefined ? {} : { name }),
  };
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch (cause) {
    throw appError("content.decode_failed", {
      details: { mediaType: plainTextMediaType, reason: "invalid UTF-8" },
      cause,
    });
  }
}

export function selectUtf8(
  bytes: Uint8Array,
  range: { start: number; end: number },
): Uint8Array {
  const { start, end } = range;
  const boundary = (index: number) =>
    index === bytes.length || ((bytes[index] ?? 0) & 0xc0) !== 0x80;
  if (
    !textRangeSchema.safeParse({ start, end }).success ||
    end > bytes.length ||
    !boundary(start) ||
    !boundary(end)
  ) {
    throw appError("content.selection_invalid", {
      details: { kind: "text", start: range.start, end: range.end },
    });
  }
  return bytes.subarray(start, end);
}
