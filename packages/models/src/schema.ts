import {
  sourceKeySchema,
  appError,
  artifactRefSchema,
  inputOriginalSchema,
  inputRoleSchema,
  jsonSchema,
  mediaTypeSchema,
  modalityNeedSchema,
  parseJson,
  parseValue,
  resultFileNameSchema,
  sourceCoverageSchema,
  type InputUse,
  type Json,
} from "@themelios/core";
import { z } from "zod";
import { credentialSchema } from "@themelios/runtime/secrets";
import { modelRepresentationRecipeSchema } from "./representation-route.js";
import type { SourceDirectory, SourceEntry } from "./types.js";

export const modelNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const modelOperationSchema = z.enum([
  "generate",
  "embed",
  "rank",
  "transcribe",
]);
export const mimePatternSchema = z
  .string()
  .regex(/^[\w!#$&^.+-]+\/(?:[\w!#$&^.+-]+|\*)$/)
  .toLowerCase();
const providerOptionsSchema = z
  .record(z.string(), z.record(z.string(), jsonSchema).readonly())
  .readonly();

export const modelParametersSchema = z
  .strictObject({
    temperature: z.number().nonnegative().optional(),
    topP: z.number().min(0).max(1).optional(),
    maxOutputTokens: z.int().positive().optional(),
    seed: z.int().optional(),
    providerOptions: providerOptionsSchema.optional(),
  })
  .readonly();

export const connectionSchema = z
  .strictObject({
    protocol: z.enum(["openai-compatible", "openai", "google", "cohere"]),
    baseURL: z.url({ protocol: /^https?$/ }).refine((value) => {
      const url = URL.parse(value);
      return (
        !!url && !url.username && !url.password && !url.hash && !url.search
      );
    }, "Expected an HTTP(S) base URL without credentials, query, or fragment"),
    credential: credentialSchema.optional(),
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
      .readonly()
      .optional(),
  })
  .readonly();

export const embeddingPurposeSchema = z.enum(["query", "document"]);
export const embeddingSpaceSchema = z
  .strictObject({
    id: modelNameSchema,
    dimensions: z.int().positive(),
    metric: z.enum(["cosine", "dot", "euclidean"]),
    normalization: z.enum(["none", "l2"]),
    purposes: z.array(embeddingPurposeSchema).min(1).readonly(),
  })
  .readonly();

export const transcriptionTimestampSchema = z.enum(["segment", "word"]);
export const modelCapabilitiesSchema = z
  .strictObject({
    operations: z.array(modelOperationSchema).min(1).readonly(),
    inputMimeTypes: z.array(mimePatternSchema).readonly(),
    needs: z.array(modalityNeedSchema).readonly(),
    structuredOutput: z.boolean(),
    streaming: z.boolean(),
    transcriptionTimestamps: z
      .array(transcriptionTimestampSchema)
      .readonly()
      .optional(),
    limits: z
      .strictObject({
        maxInputBytes: z.int().positive().optional(),
        maxImages: z.int().nonnegative().optional(),
        maxOutputTokens: z.int().positive().optional(),
      })
      .readonly()
      .optional(),
  })
  .readonly();

export const modelBindingSchema = z
  .strictObject({
    connection: modelNameSchema,
    providerModel: z.string().min(1),
    capabilities: modelCapabilitiesSchema,
    parameters: modelParametersSchema.optional(),
    embeddingSpace: embeddingSpaceSchema.optional(),
  })
  .readonly();

export const promptRoleSchema = z.enum(["system", "user"]);
const modelRoleSchema = z.enum([
  ...promptRoleSchema.options,
  "assistant",
] as const);
const textPartSchema = z
  .strictObject({
    kind: z.literal("text"),
    text: z.string(),
  })
  .readonly();
export const modelPartSchema = z.discriminatedUnion("kind", [
  textPartSchema,
  z
    .strictObject({
      kind: z.literal("media"),
      mediaType: mediaTypeSchema,
      bytes: z.instanceof(Uint8Array<ArrayBufferLike>),
      name: z.string().optional(),
    })
    .readonly(),
]);
export const modelMessageSchema = z
  .strictObject({
    role: modelRoleSchema,
    parts: z.array(modelPartSchema).min(1).readonly(),
  })
  .readonly();

export const modelAttemptsSchema = z.int().positive();
const modelTimeoutSchema = z.int().positive();

export const preparationPolicySchema = z
  .strictObject({
    representations: z
      .array(
        z.strictObject({
          mediaType: mimePatternSchema,
          recipe: modelNameSchema,
          parameters: jsonSchema.optional(),
        }),
      )
      .readonly()
      .optional(),
    models: z
      .array(
        z.strictObject({
          mediaType: mimePatternSchema,
          recipe: modelRepresentationRecipeSchema,
          model: modelNameSchema,
        }),
      )
      .readonly()
      .optional(),
  })
  .readonly();

export const taskRepresentationSchema = z.strictObject({
  result: artifactRefSchema,
  output: resultFileNameSchema,
});

export const taskRouteSchema = z
  .strictObject({
    model: modelNameSchema,
    fallback: z.array(modelNameSchema).readonly().optional(),
    parameters: modelParametersSchema.optional(),
    preparation: preparationPolicySchema.optional(),
    variables: z.record(z.string(), jsonSchema).readonly().optional(),
    timeoutMs: modelTimeoutSchema.optional(),
    maxAttempts: modelAttemptsSchema.optional(),
  })
  .readonly();

export const modelDefaultsSchema = z.strictObject({
  timeoutMs: modelTimeoutSchema.default(120_000),
  maxAttempts: modelAttemptsSchema.default(1),
  concurrency: z.int().positive().default(4),
});

export const textOutput = Object.freeze({
  kind: "text",
  schema: z.string(),
} as const);

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

export const sourceEntrySchema = sourceCoverageSchema.extend({
  key: sourceKeySchema.describe("Short key for a material in this call."),
  mediaType: inputOriginalSchema.shape.mediaType.describe(
    "Media type of the original material.",
  ),
  name: inputOriginalSchema.shape.name.describe(
    "Display name of the original material, when known.",
  ),
  role: inputRoleSchema.describe(
    "Material being processed or auxiliary context.",
  ),
});

const directorySchema = z.array(sourceEntrySchema);
const sourceEntriesSchema = z
  .strictObject({
    entries: directorySchema.readonly(),
  })
  .readonly();
const pendingSchema = z
  .array(
    z
      .strictObject({
        sourceKey: sourceKeySchema,
        action: z.string(),
        requiresModel: z.boolean(),
      })
      .readonly(),
  )
  .readonly();

/** The data exposed by task preview, including safe metadata for each attachment. */
export const previewSchema = z
  .strictObject({
    model: modelNameSchema,
    messages: z
      .array(
        z
          .strictObject({
            role: modelRoleSchema,
            parts: z
              .array(
                z.discriminatedUnion("kind", [
                  textPartSchema,
                  z
                    .strictObject({
                      kind: z.literal("media"),
                      mediaType: mediaTypeSchema,
                      name: z.string().optional(),
                      sizeBytes: z.int().nonnegative(),
                    })
                    .readonly(),
                ]),
              )
              .readonly(),
          })
          .readonly(),
      )
      .readonly(),
    sources: sourceEntriesSchema,
    pending: pendingSchema,
    taskSchema: jsonSchema.optional(),
    sentSchema: jsonSchema.optional(),
  })
  .readonly();

export const taskRequirementsSchema = z
  .strictObject({
    inputs: z
      .array(
        z
          .strictObject({
            mediaType: mimePatternSchema,
            accepts: z
              .array(z.array(modalityNeedSchema).min(1).readonly())
              .min(1)
              .readonly(),
          })
          .readonly(),
      )
      .readonly(),
    minMaterials: z.int().nonnegative(),
    maxMaterials: z.int().nonnegative().optional(),
  })
  .refine(
    (data) =>
      data.maxMaterials === undefined || data.maxMaterials >= data.minMaterials,
    {
      path: ["maxMaterials"],
      message: "Maximum must be at least the minimum",
    },
  )
  .readonly();

const promptFilesSchema = z
  .array(
    z
      .strictObject({
        role: promptRoleSchema,
        path: z.string(),
        source: z.enum(["builtin", "override", "inline"]),
      })
      .readonly(),
  )
  .readonly();

export const promptTemplatesSchema = z
  .strictObject({
    system: z.string(),
    user: z.string(),
    files: promptFilesSchema,
  })
  .readonly();

export const promptDescriptionSchema = z
  .strictObject({
    files: promptFilesSchema,
    variablesSchema: jsonSchema,
    outputSchema: jsonSchema.optional(),
    requirements: taskRequirementsSchema,
  })
  .readonly();

export const promptDiffSchema = z
  .strictObject({
    role: promptRoleSchema,
    builtin: z.string(),
    override: z.string().optional(),
  })
  .readonly();

export const taskExampleSourceSchema = sourceEntrySchema
  .extend({
    text: z.string().optional(),
  })
  .readonly();

export const taskExampleSchema = z
  .strictObject({
    name: z.string(),
    variables: jsonSchema,
    sources: z.array(taskExampleSourceSchema).readonly(),
    output: jsonSchema,
  })
  .readonly();

export const taskDescriptionSchema = z
  .strictObject({
    id: modelNameSchema,
    title: z.string(),
    purpose: z.string(),
    inputSchema: jsonSchema,
    sourcesSchema: jsonSchema,
    output: z.union([
      z.strictObject({ kind: z.literal("text") }).readonly(),
      z
        .strictObject({ kind: z.literal("json"), schema: jsonSchema })
        .readonly(),
    ]),
    requirements: taskRequirementsSchema,
    templates: promptFilesSchema,
    examples: z.array(taskExampleSchema).readonly(),
    outputRules: z.array(z.string()).readonly(),
  })
  .readonly();

export function createSourceDirectory(
  input: readonly SourceEntry[],
): SourceDirectory {
  const entries = Object.freeze(
    parseValue(directorySchema, input, "input.invalid").map((entry) =>
      Object.freeze({
        ...entry,
        originalExtent: Object.freeze(entry.originalExtent),
        requestedRange:
          entry.requestedRange && Object.freeze(entry.requestedRange),
        delivered: Object.freeze(
          entry.delivered.map((item) =>
            Object.freeze({
              ...item,
              extent: Object.freeze(item.extent),
              sourceRange: item.sourceRange && Object.freeze(item.sourceRange),
            }),
          ),
        ),
      }),
    ),
  );
  const keys = new Set(entries.map((entry) => entry.key));
  if (keys.size !== entries.length)
    throw appError("input.invalid", {
      details: {
        issues: [{ path: ["sources"], reason: "Duplicate source key" }],
      },
    });
  const result = { entries } as SourceDirectory;
  Object.defineProperties(result, {
    has: { value: (key: string) => keys.has(key) },
    link: {
      value: (key: string) => {
        if (!keys.has(key))
          throw appError("input.invalid_source_key", {
            details: { sourceKey: key },
          });
        return "source:" + key;
      },
    },
  });
  return Object.freeze(result);
}

export function sourcesJsonSchema(): Json {
  return parseJson(z.toJSONSchema(directorySchema));
}

/** Reads the source directory that accompanied a task result. */
export function sourceDirectoryFromInputs(
  inputs: readonly Pick<InputUse, "key" | "original" | "coverage" | "role">[],
): SourceDirectory {
  return createSourceDirectory(
    inputs.map(({ key, original, coverage, role }, index) => {
      if (!key || !original || !coverage)
        throw appError("model.output_invalid", {
          details: { input: index, reason: "Missing task source data" },
        });
      return { key, ...original, ...coverage, role };
    }),
  );
}
