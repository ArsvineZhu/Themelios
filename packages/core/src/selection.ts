import { z } from "zod";
import { appError } from "./errors.js";
import { mediaTypeSchema } from "./media-type.js";

export const artifactRefSchema = z
  .string()
  .regex(
    /^art_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  )
  .meta({ "x-themelios-ref": true });
export const blobRefSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
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
    pointer: z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/),
  }),
]);

export type Range = z.infer<typeof rangeSchema>;

export interface Selection {
  ref: ArtifactRef;
  range?: Range;
}

export const selectionSchema = z
  .strictObject({ ref: artifactRefSchema, range: rangeSchema.optional() })
  .transform(({ ref, range }): Selection =>
    range === undefined ? { ref } : { ref, range },
  );

export interface InlineMaterial {
  bytes: Uint8Array;
  mediaType: string;
  name?: string;
}

export const inlineMaterialSchema = z
  .strictObject({
    bytes: z.instanceof(Uint8Array),
    mediaType: mediaTypeSchema.toLowerCase(),
    name: z.string().min(1).optional(),
  })
  .transform(({ bytes, mediaType, name }): InlineMaterial =>
    name === undefined ? { bytes, mediaType } : { bytes, mediaType, name },
  );

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch (cause) {
    throw appError("content.decode_failed", {
      details: { mediaType: "text/plain", reason: "invalid UTF-8" },
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
