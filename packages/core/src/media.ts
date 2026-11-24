import { z } from "zod";
import type { Completed, Material, ProducedFile } from "./completion.js";
import type { Json } from "./json.js";
import { rangeSchema, type Range } from "./selection.js";
import { AppError, appError } from "./errors.js";
import { openCall, streamChunks, type CallOptions } from "./flow.js";

export const extentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), bytes: z.int().nonnegative() }),
  z.strictObject({
    kind: z.literal("image"),
    width: z.int().positive(),
    height: z.int().positive(),
    frames: z.int().positive(),
  }),
  z.strictObject({ kind: z.literal("pages"), pages: z.int().nonnegative() }),
  z.strictObject({
    kind: z.literal("time"),
    durationMs: z.number().nonnegative(),
  }),
  z.strictObject({ kind: z.literal("unknown") }),
]);
export type Extent = z.infer<typeof extentSchema>;

export const representationCoverageSchema = z.strictObject({
  sourceRange: z
    .union([
      rangeSchema,
      z.strictObject({
        kind: z.literal("timePoint"),
        atMs: z.number().nonnegative(),
      }),
    ])
    .nullable(),
  extent: extentSchema,
});
export type RepresentationCoverage = z.infer<
  typeof representationCoverageSchema
>;

const deliveredMediaSchema = representationCoverageSchema.extend({
  mediaType: z.string().min(1),
  name: z.string().min(1).optional(),
});
export type DeliveredMedia = z.infer<typeof deliveredMediaSchema>;

export interface SourceCoverage {
  readonly originalExtent: Extent;
  readonly requestedRange: Range | null;
  readonly delivered: readonly DeliveredMedia[];
}

export const sourceCoverageSchema = z.strictObject({
  originalExtent: extentSchema,
  requestedRange: rangeSchema.nullable(),
  delivered: z.array(deliveredMediaSchema),
});

export type ModalityNeed = "text" | "visual" | "speech" | "motion";

/** open() always reads the complete captured original. The range is relative to that original. */
export interface MediaInput {
  readonly source: Material;
  readonly info: {
    readonly mediaType: string;
    readonly sizeBytes: number;
    readonly name?: string;
    readonly extent: Extent;
  };
  readonly range?: Range;
  open(options?: { signal?: AbortSignal }): Promise<ReadableStream<Uint8Array>>;
}

export function mediaDecodeError(input: MediaInput, cause: unknown): AppError {
  if (cause instanceof AppError) return cause;
  return appError("content.decode_failed", {
    cause,
    details: {
      mediaType: input.info.mediaType,
      ...(input.info.name === undefined ? {} : { name: input.info.name }),
      ...("ref" in input.source ? { ref: input.source.ref } : {}),
      reason: String(cause),
    },
  });
}

export interface RecipeDescription {
  readonly id: string;
  readonly version: string;
  readonly inputMimeTypes: readonly string[];
  readonly outputMimeTypes: readonly string[];
  readonly supplies: readonly ModalityNeed[];
  readonly parameters: z.ZodType<Json>;
  readonly priority: number;
  readonly titleKey: string;
}

export interface PreparedRepresentation {
  readonly result: Completed & {
    readonly files: readonly RepresentationFile[];
  };
  readonly outputs: readonly string[];
}

export type RepresentationFile = ProducedFile & {
  readonly coverage: RepresentationCoverage;
};

export interface RepresentationAdapter {
  readonly description: RecipeDescription;
  available(): Promise<{
    readonly available: boolean;
    readonly missing: readonly string[];
  }>;
  probe(input: MediaInput, options?: CallOptions): Promise<Extent>;
  /** Determines whether matching originals can be sent without this normalization. */
  requiresNormalization?(
    input: MediaInput,
    options?: CallOptions,
  ): Promise<boolean>;
  /** Runtime dependencies that affect reuse in addition to the recipe and its parameters. */
  cacheIdentity?(): Json | Promise<Json>;
  validateForModel?(
    representation: PreparedRepresentation,
    input: MediaInput,
  ): void;
  parametersForModel?(
    inputMime: string,
    acceptedMime: (mediaType: string) => boolean,
    parameters: Json,
  ): Json;
  prepare(
    input: MediaInput,
    parameters: Json,
    options?: CallOptions,
  ): Promise<PreparedRepresentation>;
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
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of streamChunks(body, scope.signal)) {
      size += chunk.byteLength;
      if (size > maxBytes) oversized(size);
      chunks.push(new Uint8Array(chunk));
    }
    if (chunks.length === 1) return chunks[0]!;
    return Buffer.concat(chunks, size);
  } finally {
    scope.close();
  }
}
