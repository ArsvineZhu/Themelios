import { originSchema, type AcceptInput } from "@themelios/content";
import {
  artifactRefSchema,
  base64Schema,
  inlineMaterialSchema,
  inputRoleSchema,
  jsonSchema,
  inputUseSchema,
  resultFileSchema,
  savedResultSchema,
  selectionSchema,
  preparedRepresentationSchema,
  producerSchema,
  resultOutputNameSchema,
  type Completed,
  type ErrorInfo,
  type InlineMaterial,
  type InputUse,
  type Json,
  type Material,
  type ProducedFile,
  type SavedResult,
  type Selection,
} from "@themelios/core";
import {
  modelNameSchema,
  modelParametersSchema,
  taskRepresentationSchema,
  type ModelParameters,
  type TaskMaterial,
} from "@themelios/models";
import { z } from "zod";

const wireInlineSchema = inlineMaterialSchema.extend({ bytes: base64Schema });

type WireInlineMaterial = z.output<typeof wireInlineSchema>;

export const wireAcceptSchema = wireInlineSchema.extend({
  origin: originSchema.optional(),
});

export interface WireResultOutput {
  result: string | WireCompleted;
  output?: string | undefined;
}

export type WireMaterial =
  Selection | z.output<typeof wireInlineSchema> | WireResultOutput;

export type WireInputUse = InputUse<WireMaterial>;

export type WireCompleted = Omit<Completed, "inputs" | "files"> & {
  readonly inputs: readonly WireInputUse[];
  readonly files: readonly z.output<typeof wireProducedFileSchema>[];
};

export type WireTaskMaterial = Omit<TaskMaterial, "source"> & {
  readonly source: WireMaterial;
};

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

export const wireCompletedSchema: z.ZodType<WireCompleted> = z.lazy(() =>
  z.strictObject({
    value: jsonSchema,
    inputs: z.array(wireInputUseSchema),
    files: z.array(wireProducedFileSchema),
    producer: producerSchema,
    representation: preparedRepresentationSchema.optional(),
  }),
);

const wireMaterialSchema: z.ZodType<WireMaterial> = z.lazy(() =>
  z.union([
    selectionSchema,
    wireInlineSchema,
    z.strictObject({
      result: z.union([artifactRefSchema, wireCompletedSchema]),
      output: resultOutputNameSchema.optional(),
    }),
  ]),
);

const wireInputUseSchema = inputUseSchema(wireMaterialSchema);
const wireProducedFileSchema = resultFileSchema(
  z.union([selectionSchema, wireInlineSchema]),
);

const wireTaskMaterialSchema: z.ZodType<WireTaskMaterial> = z.strictObject({
  source: wireMaterialSchema,
  role: inputRoleSchema.optional(),
  representation: taskRepresentationSchema.optional(),
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

export const wireResultSchema = z.union([
  savedResultSchema,
  wireCompletedSchema,
]);

export function decodeWireAccept(
  input: z.output<typeof wireAcceptSchema>,
): AcceptInput {
  return {
    bytes: Buffer.from(input.bytes, "base64"),
    mediaType: input.mediaType,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.origin === undefined ? {} : { origin: input.origin }),
  };
}

function decodeMaterial(wire: WireMaterial): Material {
  if ("bytes" in wire) return decodeInline(wire);
  if ("result" in wire) {
    const { result, output } = wire;
    return {
      result: typeof result === "string" ? result : decodeCompleted(result),
      ...(output === undefined ? {} : { output }),
    };
  }
  return wire;
}

export function decodeCompleted(wire: WireCompleted): Completed {
  return {
    ...wire,
    inputs: wire.inputs.map((use): InputUse => ({
      ...use,
      source: decodeMaterial(use.source),
      delivered: use.delivered.map(decodeMaterial),
    })),
    files: wire.files.map((file): ProducedFile => ({
      ...file,
      material:
        "bytes" in file.material ? decodeInline(file.material) : file.material,
    })),
  };
}

function encodeMaterial(material: Material): WireMaterial {
  if ("bytes" in material) return encodeInline(material);
  if ("result" in material) {
    const { result, output } = material;
    return {
      result: typeof result === "string" ? result : encodeCompleted(result),
      output,
    };
  }
  return material;
}

export function encodeCompleted(completed: Completed): WireCompleted {
  return {
    ...completed,
    inputs: completed.inputs.map((use) => ({
      ...use,
      source: encodeMaterial(use.source),
      delivered: use.delivered.map(encodeMaterial),
    })),
    files: completed.files.map(({ material, ...file }) => ({
      ...file,
      sourceIndices: [...file.sourceIndices],
      material: "bytes" in material ? encodeInline(material) : material,
    })),
  };
}

export function decodeTaskMaterials(
  items: readonly WireTaskMaterial[],
): TaskMaterial[] {
  return items.map(({ source, ...item }) => ({
    ...item,
    source: decodeMaterial(source),
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
    bytes: Buffer.from(material.bytes, "base64"),
    mediaType: material.mediaType,
    ...(material.name === undefined ? {} : { name: material.name }),
  };
}
