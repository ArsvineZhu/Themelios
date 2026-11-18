import { appError, jsonSchema, parseJson, type Json } from "@themelios/core";
import { z } from "zod";
import type {
  Connection,
  EmbeddingSpace,
  ModelBinding,
  ModelParameters,
} from "./contracts.js";

export const modelNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const modalityNeedSchema = z.enum([
  "text",
  "visual",
  "speech",
  "motion",
]);
const modelOperationSchema = z.enum([
  "generate",
  "embed",
  "rank",
  "transcribe",
]);
export const mimePatternSchema = z
  .string()
  .regex(/^[\w!#$&^.+-]+\/(?:[\w!#$&^.+-]+|\*)$/);
const providerOptionsSchema = z.record(
  z.string(),
  z.record(z.string(), jsonSchema),
);

export const modelParametersSchema = z.strictObject({
  temperature: z.number().nonnegative().optional(),
  topP: z.number().min(0).max(1).optional(),
  maxOutputTokens: z.int().positive().optional(),
  seed: z.int().optional(),
  providerOptions: providerOptionsSchema.optional(),
}) as z.ZodType<ModelParameters>;

export const connectionSchema = z.strictObject({
  protocol: z.enum(["openai-compatible", "openai", "google", "cohere"]),
  baseURL: z.url({ protocol: /^https?$/ }).refine((value) => {
    const url = URL.parse(value);
    return !!url && !url.username && !url.password && !url.hash && !url.search;
  }, "Expected an HTTP(S) base URL without credentials, query, or fragment"),
  credential: z
    .string()
    .regex(/^(?:env:[A-Za-z_][A-Za-z0-9_]*|file:.+)$/)
    .optional(),
  headers: z
    .record(
      z.string().regex(/^[!#$%&'*+\-.^_\x60|~\w]+$/),
      z.string().regex(/^[^\r\n]*$/),
    )
    .refine(
      (headers) =>
        Object.keys(headers).every(
          (name) =>
            ![
              "authorization",
              "proxy-authorization",
              "x-api-key",
              "x-goog-api-key",
              "cookie",
            ].includes(name.toLowerCase()),
        ),
      "Use a credential reference for authentication",
    )
    .optional(),
}) as z.ZodType<Connection>;

const embeddingSpaceSchema = z.strictObject({
  id: modelNameSchema,
  dimensions: z.int().positive(),
  metric: z.enum(["cosine", "dot", "euclidean"]),
  normalization: z.enum(["none", "l2"]),
  purposes: z.array(z.enum(["query", "document"])).min(1),
}) satisfies z.ZodType<EmbeddingSpace>;

export const modelBindingSchema = z.strictObject({
  connection: modelNameSchema,
  providerModel: z.string().min(1),
  capabilities: z.strictObject({
    operations: z.array(modelOperationSchema).min(1),
    inputMimeTypes: z.array(mimePatternSchema),
    needs: z.array(modalityNeedSchema),
    structuredOutput: z.boolean(),
    streaming: z.boolean(),
    transcriptionTimestamps: z.array(z.enum(["segment", "word"])).optional(),
    limits: z
      .strictObject({
        maxInputBytes: z.int().positive().optional(),
        maxImages: z.int().nonnegative().optional(),
        maxOutputTokens: z.int().positive().optional(),
      })
      .optional(),
  }),
  parameters: modelParametersSchema.optional(),
  embeddingSpace: embeddingSpaceSchema.optional(),
}) as z.ZodType<ModelBinding>;

export const modelDefaultsSchema = z.strictObject({
  timeoutMs: z.int().positive().default(120_000),
  maxAttempts: z.int().min(1).max(8).default(1),
  concurrency: z.int().positive().default(4),
});

export function matchesMime(pattern: string, mediaType: string): boolean {
  return (
    pattern === mediaType ||
    (pattern.endsWith("/*") && mediaType.startsWith(pattern.slice(0, -1)))
  );
}

export function outputSchema(schema: z.ZodType<Json>): Json {
  return parseJson(z.toJSONSchema(schema, { target: "draft-7" }));
}

export function validateOutput<O extends Json>(
  schema: z.ZodType<O>,
  value: unknown,
  binding: string,
): O {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw appError("model.output_invalid", {
      details: {
        binding,
        issues: result.error.issues.map((issue) => ({
          path: issue.path.map(String),
          reason: issue.message,
        })),
      },
    });
  }
  parseJson(result.data);
  return result.data;
}
