import { originSchema, type AcceptInput } from "@themelios/content";
import {
  artifactRefSchema,
  instantSchema,
  jsonSchema,
  mediaTypeSchema,
  preparedRepresentationSchema,
  producerSchema,
  rangeSchema,
  representationCoverageSchema,
  resultOutputNameSchema,
  sourceCoverageSchema,
  type Completed,
  type ErrorInfo,
  type InlineMaterial,
  type InputUse,
  type Json,
  type Material,
  type ProducedFile,
  type Producer,
  type Range,
  type RepresentationCoverage,
  type SavedFile,
  type SavedResult,
  type Selection,
  type SourceCoverage,
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

export interface WireSelection {
  ref: string;
  range?: Range | undefined;
}

export const wireSelectionSchema: z.ZodType<WireSelection> = z.strictObject({
  ref: artifactRefSchema,
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
  origin: originSchema.optional(),
});

export interface WireProducedFile {
  name: string;
  material: WireInlineMaterial | WireSelection;
  sourceIndices: number[];
  coverage?: RepresentationCoverage | undefined;
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
  coverage?: SourceCoverage | undefined;
}

export interface WireCompleted {
  value: Json;
  inputs: WireInputUse[];
  files: WireProducedFile[];
  producer: Producer;
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
  sources: { entries: Preview["sources"]["entries"] };
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
    producer: producerSchema,
    representation: wireRepresentationSchema.optional(),
  }),
);

const wireMaterialSchema: z.ZodType<WireMaterial> = z.lazy(() =>
  z.union([
    wireSelectionSchema,
    z.strictObject({ inline: wireInlineSchema }),
    z.strictObject({
      resultOutput: z.strictObject({
        result: z.union([artifactRefSchema, wireCompletedSchema]),
        output: resultOutputNameSchema.optional(),
      }),
    }),
  ]),
);

const wireInputUseSchema: z.ZodType<WireInputUse> = z.lazy(() =>
  z.strictObject({
    source: wireMaterialSchema,
    delivered: z.array(wireMaterialSchema),
    role: z.enum(["primary", "context"]),
    coverage: sourceCoverageSchema.optional(),
  }),
);

const wireProducedFileSchema: z.ZodType<WireProducedFile> = z.strictObject({
  name: z.string().min(1),
  material: z.union([wireSelectionSchema, wireInlineSchema]),
  sourceIndices: z.array(z.int().nonnegative()),
  coverage: representationCoverageSchema.optional(),
});

const savedFileSchema: z.ZodType<SavedFile> = z.strictObject({
  material: z.strictObject({
    ref: artifactRefSchema,
    range: rangeSchema.optional(),
  }) as z.ZodType<Selection>,
  sourceIndices: z.array(z.int().nonnegative()),
  coverage: representationCoverageSchema.optional(),
});

export const wireSavedSchema = z.strictObject({
  ref: artifactRefSchema,
  value: jsonSchema,
  inputs: z.array(
    z.strictObject({
      source: wireSelectionSchema,
      delivered: z.array(wireSelectionSchema),
      role: z.enum(["primary", "context"]),
      coverage: sourceCoverageSchema.optional(),
    }),
  ),
  files: z.record(z.string(), savedFileSchema),
  producer: producerSchema,
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

export const wireRunTaskSchema: z.ZodType<WireRunTaskInput> =
  wirePreviewInputSchema.extend({
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

export function decodeWireAccept(
  input: z.output<typeof wireAcceptSchema>,
): AcceptInput {
  return {
    bytes: decodeBase64(input.bytes),
    mediaType: input.mediaType,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.origin === undefined ? {} : { origin: input.origin }),
  };
}

function decodeSelection({ ref, range }: WireSelection): Selection {
  return range === undefined ? { ref } : { ref, range };
}

function decodeMaterial(wire: WireMaterial): Material {
  if ("inline" in wire) return decodeInline(wire.inline);
  if ("resultOutput" in wire) {
    const { result, output } = wire.resultOutput;
    return {
      result: typeof result === "string" ? result : decodeCompleted(result),
      ...(output === undefined ? {} : { output }),
    };
  }
  return decodeSelection(wire);
}

export function decodeCompleted(wire: WireCompleted): Completed {
  const { representation, ...node } = wire;
  return {
    ...node,
    inputs: wire.inputs.map((use): InputUse => ({
      ...use,
      source: decodeMaterial(use.source),
      delivered: use.delivered.map(decodeMaterial),
    })),
    files: wire.files.map((file): ProducedFile => ({
      ...file,
      material:
        "bytes" in file.material
          ? decodeInline(file.material)
          : decodeSelection(file.material),
    })),
    ...(representation === undefined
      ? {}
      : {
          representation: {
            ...representation,
            source: decodeSelection(representation.source),
          },
        }),
  };
}

function encodeMaterial(material: Material): WireMaterial {
  if ("bytes" in material) return { inline: encodeInline(material) };
  if ("result" in material) {
    const target = material.result;
    return {
      resultOutput: {
        result: typeof target === "string" ? target : encodeCompleted(target),
        ...(material.output === undefined ? {} : { output: material.output }),
      },
    };
  }
  return material;
}

export function encodeCompleted(completed: Completed): WireCompleted {
  return {
    value: completed.value,
    inputs: completed.inputs.map((use) => ({
      source: encodeMaterial(use.source),
      delivered: use.delivered.map(encodeMaterial),
      role: use.role,
      ...(use.coverage === undefined ? {} : { coverage: use.coverage }),
    })),
    files: completed.files.map((file) => ({
      name: file.name,
      material:
        "bytes" in file.material ? encodeInline(file.material) : file.material,
      sourceIndices: [...file.sourceIndices],
      ...(file.coverage === undefined ? {} : { coverage: file.coverage }),
    })),
    producer: completed.producer,
    ...(completed.representation
      ? { representation: completed.representation }
      : {}),
  };
}

export function encodePreview(preview: Preview): WirePreview {
  return { ...preview, sources: { entries: preview.sources.entries } };
}

export function decodeTaskMaterials(
  items: readonly WireTaskMaterial[],
): TaskMaterial[] {
  return items.map(({ source, role }) => ({
    source: decodeMaterial(source),
    ...(role === undefined ? {} : { role }),
  }));
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
  return Buffer.from(text, "base64");
}
