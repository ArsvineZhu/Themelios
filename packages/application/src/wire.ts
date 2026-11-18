import type { AcceptInput, Materials, Origin } from "@themelios/content";
import {
  artifactRefSchema,
  instantSchema,
  jsonSchema,
  parseValue,
  preparedRepresentationSchema,
  rangeSchema,
  type ArtifactRef,
  type CallOptions,
  type Completed,
  type ErrorInfo,
  type InlineMaterial,
  type InputUse,
  type Json,
  type Material,
  type ProducedFile,
  type Producer,
  type Range,
  type SavedFile,
  type SavedResult,
  type Selection,
} from "@themelios/core";
import {
  modelNameSchema,
  modelParametersSchema,
  type ModelParameters,
  type Preview,
  type TaskMaterial,
} from "@themelios/models";
import { sourceEntrySchema } from "@themelios/models/tasks";
import { z } from "zod";

export const wireArtifactRefSchema = artifactRefSchema;

export const mediaTypeSchema = z
  .string()
  .regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/);

export const wireOriginSchema = z.strictObject({
  kind: z.enum(["file", "url", "application"]),
  locator: z.string().min(1).optional(),
  capturedAt: instantSchema,
  metadata: jsonSchema.optional(),
});

export interface WireProducer {
  kind: "model" | "transform" | "application";
  name: string;
  version?: string | undefined;
  details?: Json | undefined;
}

const wireProducerSchema: z.ZodType<WireProducer> = z.strictObject({
  kind: z.enum(["model", "transform", "application"]),
  name: z.string().min(1),
  version: z.string().min(1).optional(),
  details: jsonSchema.optional(),
});

function toProducer(producer: WireProducer): Producer {
  return {
    kind: producer.kind,
    name: producer.name,
    ...(producer.version === undefined ? {} : { version: producer.version }),
    ...(producer.details === undefined ? {} : { details: producer.details }),
  };
}

export function toOrigin(origin: z.infer<typeof wireOriginSchema>): Origin {
  return {
    kind: origin.kind,
    capturedAt: origin.capturedAt,
    ...(origin.locator === undefined ? {} : { locator: origin.locator }),
    ...(origin.metadata === undefined ? {} : { metadata: origin.metadata }),
  };
}

export interface WireSelection {
  ref: string;
  range?: Range | undefined;
}

export const wireSelectionSchema: z.ZodType<WireSelection> = z.strictObject({
  ref: wireArtifactRefSchema,
  range: rangeSchema.optional(),
});

export interface WireInlineMaterial {
  bytes: string;
  mediaType: string;
  name?: string | undefined;
}

const wireInlineSchema = z.strictObject({
  bytes: z.base64(),
  mediaType: mediaTypeSchema,
  name: z.string().min(1).optional(),
});

export const wireAcceptSchema = wireInlineSchema.extend({
  origin: wireOriginSchema.optional(),
});

export interface WireProducedFile {
  name: string;
  material: WireInlineMaterial | WireSelection;
  sourceIndices: number[];
}

export interface WireResultOutput {
  result: string | WireCompleted;
  output?: string | undefined;
}

export type WireMaterial =
  | WireSelection
  | { inline: WireInlineMaterial }
  | { resultOutput: WireResultOutput };

export interface WireInputUse {
  source: WireMaterial;
  delivered: WireMaterial[];
  role: "primary" | "context";
}

export interface WireCompleted {
  value: Json;
  inputs: WireInputUse[];
  files: WireProducedFile[];
  producer: WireProducer;
  representation?: z.infer<typeof wireRepresentationSchema> | undefined;
}

export interface WireTaskMaterial {
  source: WireMaterial;
  role?: "primary" | "context" | undefined;
}

export interface WireRunTaskInput {
  task: string;
  variables?: Json | undefined;
  materials: WireTaskMaterial[];
  model?: string | undefined;
  parameters?: ModelParameters | undefined;
  persist?: boolean | undefined;
}

export type WireTaskResult = SavedResult | WireCompleted;

export type WireBatchItemResult =
  { ok: true; result: WireTaskResult } | { ok: false; error: ErrorInfo };

export interface WirePreview {
  model: string;
  messages: Preview["messages"];
  sources: { entries: z.infer<typeof sourceEntrySchema>[] };
  pending: Preview["pending"];
  taskSchema?: Json;
  sentSchema?: Json;
}

const wireRepresentationSchema = preparedRepresentationSchema.extend({
  source: wireSelectionSchema,
});

export const wireCompletedSchema: z.ZodType<WireCompleted> = z.lazy(() =>
  z.strictObject({
    value: jsonSchema,
    inputs: z.array(wireInputUseSchema),
    files: z.array(wireProducedFileSchema),
    producer: wireProducerSchema,
    representation: wireRepresentationSchema.optional(),
  }),
);

const wireMaterialSchema: z.ZodType<WireMaterial> = z.lazy(() =>
  z.union([
    wireSelectionSchema,
    z.strictObject({ inline: wireInlineSchema }),
    z.strictObject({
      resultOutput: z.strictObject({
        result: z.union([wireArtifactRefSchema, wireCompletedSchema]),
        output: z.string().min(1).optional(),
      }),
    }),
  ]),
);

const wireInputUseSchema: z.ZodType<WireInputUse> = z.lazy(() =>
  z.strictObject({
    source: wireMaterialSchema,
    delivered: z.array(wireMaterialSchema),
    role: z.enum(["primary", "context"]),
  }),
);

const wireProducedFileSchema: z.ZodType<WireProducedFile> = z.strictObject({
  name: z.string().min(1),
  material: z.union([wireSelectionSchema, wireInlineSchema]),
  sourceIndices: z.array(z.int().nonnegative()),
});

const savedFileSchema: z.ZodType<SavedFile> = z.strictObject({
  material: z.strictObject({
    ref: wireArtifactRefSchema,
    range: rangeSchema.optional(),
  }) as z.ZodType<Selection>,
  sourceIndices: z.array(z.int().nonnegative()),
});

export const wireSavedSchema = z.strictObject({
  ref: wireArtifactRefSchema,
  value: jsonSchema,
  inputs: z.array(
    z.strictObject({
      source: wireSelectionSchema,
      delivered: z.array(wireSelectionSchema),
      role: z.enum(["primary", "context"]),
    }),
  ),
  files: z.record(z.string(), savedFileSchema),
  producer: wireProducerSchema,
});

const wireTaskMaterialSchema: z.ZodType<WireTaskMaterial> = z.strictObject({
  source: wireMaterialSchema,
  role: z.enum(["primary", "context"]).optional(),
});

export const wirePreviewInputSchema = z.strictObject({
  task: modelNameSchema,
  variables: jsonSchema.optional(),
  materials: z.array(wireTaskMaterialSchema),
  model: modelNameSchema.optional(),
  parameters: modelParametersSchema.optional(),
});

export const wireRunTaskSchema: z.ZodType<WireRunTaskInput> = z.strictObject({
  task: modelNameSchema,
  variables: jsonSchema.optional(),
  materials: z.array(wireTaskMaterialSchema),
  model: modelNameSchema.optional(),
  parameters: modelParametersSchema.optional(),
  persist: z.boolean().optional(),
});

export const wireResultSchema = z.union([wireSavedSchema, wireCompletedSchema]);

export const wirePreviewSchema = z.strictObject({
  model: z.string(),
  messages: z.array(
    z.strictObject({
      role: z.enum(["system", "user", "assistant"]),
      parts: z.array(
        z.union([
          z.strictObject({ kind: z.literal("text"), text: z.string() }),
          z.strictObject({
            kind: z.literal("media"),
            mediaType: z.string(),
            name: z.string().optional(),
            sizeBytes: z.number().optional(),
          }),
        ]),
      ),
    }),
  ),
  sources: z.strictObject({ entries: z.array(sourceEntrySchema) }),
  pending: z.array(
    z.strictObject({
      sourceKey: z.string(),
      action: z.string(),
      requiresModel: z.boolean(),
    }),
  ),
  taskSchema: jsonSchema.optional(),
  sentSchema: jsonSchema.optional(),
});

export function parseWireInline(value: unknown): AcceptInput {
  const input = parseValue(
    wireAcceptSchema,
    value,
    "transport.invalid_request",
  );
  return {
    bytes: decodeBase64(input.bytes),
    mediaType: input.mediaType,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.origin === undefined ? {} : { origin: toOrigin(input.origin) }),
  };
}

export interface WireCodec {
  resolveSelection(selection: WireSelection): Selection;
  decodeCompleted(wire: WireCompleted): Promise<Completed>;
  decodeMaterial(wire: WireMaterial): Promise<Material>;
  encodeCompleted(completed: Completed): WireCompleted;
  encodePreview(preview: Preview): WirePreview;
}

export function createWireCodec(
  content: Pick<Materials, "resolve"> & {
    readResult(ref: ArtifactRef, options?: CallOptions): Promise<SavedResult>;
  },
  options?: CallOptions,
): WireCodec {
  function resolveSelection(selection: WireSelection): Selection {
    const ref = content.resolve(selection.ref);
    return selection.range === undefined
      ? { ref }
      : { ref, range: selection.range };
  }

  async function decodeMaterial(wire: WireMaterial): Promise<Material> {
    if ("inline" in wire) return decodeInline(wire.inline);
    if ("resultOutput" in wire) {
      const target = wire.resultOutput.result;
      const result =
        typeof target === "string"
          ? await content.readResult(content.resolve(target), options)
          : await decodeCompleted(target);
      return {
        result,
        ...(wire.resultOutput.output === undefined
          ? {}
          : { output: wire.resultOutput.output }),
      };
    }
    return resolveSelection(wire);
  }

  async function decodeInputUse(use: WireInputUse): Promise<InputUse> {
    return {
      source: await decodeMaterial(use.source),
      delivered: await Promise.all(use.delivered.map(decodeMaterial)),
      role: use.role,
    };
  }

  async function decodeCompleted(wire: WireCompleted): Promise<Completed> {
    return {
      value: wire.value,
      inputs: await Promise.all(wire.inputs.map(decodeInputUse)),
      files: wire.files.map((file): ProducedFile => ({
        name: file.name,
        material:
          "bytes" in file.material
            ? decodeInline(file.material)
            : resolveSelection(file.material),
        sourceIndices: file.sourceIndices,
      })),
      producer: toProducer(wire.producer),
      ...(wire.representation
        ? {
            representation: preparedRepresentationSchema.parse(
              wire.representation,
            ),
          }
        : {}),
    };
  }

  function encodeMaterial(material: Material): WireMaterial {
    if ("bytes" in material) return { inline: encodeInline(material) };
    if ("result" in material) {
      const target = material.result;
      return {
        resultOutput: {
          result: "ref" in target ? target.ref : encodeCompleted(target),
          ...(material.output === undefined ? {} : { output: material.output }),
        },
      };
    }
    return material;
  }

  function encodeCompleted(completed: Completed): WireCompleted {
    return {
      value: completed.value,
      inputs: completed.inputs.map((use) => ({
        source: encodeMaterial(use.source),
        delivered: use.delivered.map(encodeMaterial),
        role: use.role,
      })),
      files: completed.files.map((file) => ({
        name: file.name,
        material:
          "bytes" in file.material
            ? encodeInline(file.material)
            : file.material,
        sourceIndices: [...file.sourceIndices],
      })),
      producer: completed.producer,
      ...(completed.representation
        ? { representation: completed.representation }
        : {}),
    };
  }

  return {
    resolveSelection,
    decodeCompleted,
    decodeMaterial,
    encodeCompleted,
    encodePreview(preview): WirePreview {
      return {
        model: preview.model,
        messages: preview.messages,
        sources: { entries: [...preview.sources.entries] },
        pending: preview.pending,
        ...(preview.taskSchema === undefined
          ? {}
          : { taskSchema: preview.taskSchema }),
        ...(preview.sentSchema === undefined
          ? {}
          : { sentSchema: preview.sentSchema }),
      };
    },
  };
}

export async function decodeTaskMaterials(
  codec: WireCodec,
  items: readonly WireTaskMaterial[],
): Promise<TaskMaterial[]> {
  return Promise.all(
    items.map(async (item) => {
      const source = await codec.decodeMaterial(item.source);
      return item.role === undefined ? { source } : { source, role: item.role };
    }),
  );
}

function encodeInline(material: InlineMaterial): WireInlineMaterial {
  return {
    bytes: Buffer.from(material.bytes).toString("base64"),
    mediaType: material.mediaType,
    ...(material.name === undefined ? {} : { name: material.name }),
  };
}

function decodeInline(material: WireInlineMaterial): InlineMaterial {
  return {
    bytes: decodeBase64(material.bytes),
    mediaType: material.mediaType,
    ...(material.name === undefined ? {} : { name: material.name }),
  };
}

function decodeBase64(text: string): Uint8Array {
  return Uint8Array.from(Buffer.from(text, "base64"));
}
