import { type Results, type Origin } from "@themelios/content";
import {
  appError,
  artifactRefSchema,
  jsonSchema,
  parseValue,
  rangeSchema,
  textRangeSchema,
  type CallOptions,
  type Completed,
  type InputUse,
  type InlineMaterial,
  type Material,
  type SavedResult,
  type Selection,
} from "@themelios/core";
import { instantSchema } from "@themelios/core/time";
import { modelNameSchema, modelParametersSchema } from "@themelios/models";
import { sourceEntrySchema, type Preview } from "@themelios/models/tasks";
import { z } from "zod";
import type { RunTaskInput } from "./contracts.js";
import type {
  WireCodec,
  WireCompleted,
  WireInlineMaterial,
  WireMaterial,
  WirePreview,
  WireRunTaskInput,
} from "./wire-contracts.js";

const ref = artifactRefSchema;
const selection = z.strictObject({
  ref,
  range: rangeSchema.optional(),
}) as z.ZodType<Selection>;
export const wireSelectionSchema = selection;
const mediaType = z.string().regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/);

const base64 = z
  .string()
  .regex(/^[A-Za-z0-9+/]*={0,2}$/)
  .refine((value) => value.length % 4 === 0, "Expected padded base64")
  .meta({ contentEncoding: "base64" });
const inline = z.strictObject({
  bytesBase64: base64,
  mediaType,
  name: z.string().min(1).optional(),
});
export const wireOriginSchema = z.strictObject({
  kind: z.enum(["file", "url", "application"]),
  locator: z.string().optional(),
  capturedAt: instantSchema,
  metadata: jsonSchema.optional(),
}) as z.ZodType<Origin>;

export const wireAcceptSchema = inline.extend({
  origin: wireOriginSchema.optional(),
});
const outputName = z.string().min(1);
const mapping = z.strictObject({
  output: outputName,
  range: textRangeSchema,
  source: selection,
});
const producer = z.strictObject({
  kind: z.enum(["model", "transform", "application"]),
  name: z.string().min(1),
  version: z.string().optional(),
  details: jsonSchema.optional(),
});

const role = z.enum(["primary", "context"]);
const sourceIndices = z.array(z.int().nonnegative());

const material: z.ZodType<WireMaterial> = z.lazy(
  () =>
    z.union([
      selection,
      inline,
      z.strictObject({
        result: z.union([z.strictObject({ ref }), wireCompletedSchema]),
        output: outputName.optional(),
      }),
    ]) as z.ZodType<WireMaterial>,
);

const inputUse = <T>(schema: z.ZodType<T>) =>
  z.strictObject({
    source: schema,
    delivered: z.array(schema).min(1),
    role,
  });
const commonResult = {
  value: jsonSchema,
  producer,
  mappings: z.array(mapping).optional(),
};
const completed = z.strictObject({
  ...commonResult,
  inputs: z.array(inputUse(material)),
  files: z.array(
    z.strictObject({
      name: outputName,
      material: z.union([selection, inline]),
      sourceIndices,
    }),
  ),
});
export const wireCompletedSchema = completed as z.ZodType<WireCompleted>;
export const wireSavedSchema = z.strictObject({
  ...commonResult,
  ref,
  inputs: z.array(inputUse(selection)),
  files: z.record(
    outputName,
    z.strictObject({
      material: selection,
      sourceIndices,
    }),
  ),
}) as z.ZodType<SavedResult>;
export const wireResultSchema = z.union([wireSavedSchema, wireCompletedSchema]);

const taskInput = z.strictObject({
  task: modelNameSchema,
  variables: jsonSchema,
  materials: z.array(
    z.strictObject({ source: material, role: role.optional() }),
  ),
  model: modelNameSchema.optional(),
  parameters: modelParametersSchema.optional(),
});
export const wireRunTaskSchema = taskInput.extend({
  persist: z.boolean().optional(),
}) as z.ZodType<WireRunTaskInput>;
export const wirePreviewInputSchema = taskInput as z.ZodType<
  Omit<WireRunTaskInput, "persist">
>;

const messagePart = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), text: z.string() }),
  z.strictObject({
    kind: z.literal("media"),
    mediaType,
    name: z.string().optional(),
    sizeBytes: z.int().nonnegative().optional(),
  }),
]);
export const wirePreviewSchema = z.strictObject({
  model: modelNameSchema,
  messages: z.array(
    z.strictObject({
      role: z.enum(["system", "user", "assistant"]),
      parts: z.array(messagePart),
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

function decodeInline({
  bytesBase64,
  mediaType,
  name,
}: WireInlineMaterial): InlineMaterial {
  const bytes = Buffer.from(bytesBase64, "base64");
  if (bytes.toString("base64") !== bytesBase64)
    throw appError("input.invalid", {
      details: {
        issues: [
          { path: ["bytesBase64"], reason: "Expected canonical base64" },
        ],
      },
    });
  return { bytes, mediaType, ...(name === undefined ? {} : { name }) };
}

function encodeInline(value: InlineMaterial) {
  return {
    bytesBase64: Buffer.from(value.bytes).toString("base64"),
    mediaType: value.mediaType,
    ...(value.name === undefined ? {} : { name: value.name }),
  };
}

export function createWireCodec(
  results: Pick<Results, "read">,
  options?: CallOptions,
): WireCodec & {
  decodeCompleted(value: WireCompleted): Promise<Completed>;
  decodeTask(value: WireRunTaskInput): Promise<RunTaskInput>;
} {
  const saved = new Map<string, ReturnType<Results["read"]>>();
  async function decodeMaterial(input: WireMaterial): Promise<Material> {
    if ("ref" in input) return input;
    if ("bytesBase64" in input) return decodeInline(input);
    const { result, output } = input;
    if ("ref" in result) {
      let found = saved.get(result.ref);
      if (!found) {
        found = results.read(result.ref, options);
        saved.set(result.ref, found);
      }
      return {
        result: await found,
        ...(output === undefined ? {} : { output }),
      };
    }
    return {
      result: await decodeCompleted(result),
      ...(output === undefined ? {} : { output }),
    };
  }
  async function decodeCompleted(data: WireCompleted): Promise<Completed> {
    const { inputs, files, ...value } = data;
    const uses: InputUse[] = [];
    for (const input of inputs) {
      uses.push({
        role: input.role,
        source: await decodeMaterial(input.source),
        delivered: await Promise.all(input.delivered.map(decodeMaterial)),
      });
    }
    return {
      ...value,
      inputs: uses,
      files: files.map((file) => ({
        ...file,
        material:
          "ref" in file.material ? file.material : decodeInline(file.material),
      })),
    };
  }
  function encodeCompleted(data: Completed): WireCompleted {
    const visited = new Set<Completed>();
    function item(input: Material): WireMaterial {
      if ("ref" in input) return input;
      if ("bytes" in input) return encodeInline(input);
      return {
        result:
          "ref" in input.result
            ? { ref: input.result.ref }
            : encode(input.result),
        ...(input.output === undefined ? {} : { output: input.output }),
      };
    }
    function encode(result: Completed): WireCompleted {
      if (visited.has(result))
        throw appError("content.schema_invalid", {
          details: {
            issues: [
              { path: ["inputs"], reason: "Completed results contain a cycle" },
            ],
          },
        });
      visited.add(result);
      try {
        return {
          ...result,
          inputs: result.inputs.map(({ source, delivered, role }) => ({
            source: item(source),
            delivered: delivered.map(item),
            role,
          })),
          files: result.files.map((file) => ({
            ...file,
            material:
              "ref" in file.material
                ? file.material
                : encodeInline(file.material),
          })),
        };
      } finally {
        visited.delete(result);
      }
    }
    return encode(data);
  }
  function encodePreview(value: Preview): WirePreview {
    return { ...value, sources: { entries: value.sources.entries } };
  }
  return {
    encodeCompleted,
    encodePreview,
    decodeMaterial,
    decodeCompleted,
    async decodeTask(payload) {
      const { materials, ...rest } = payload;
      return {
        ...rest,
        materials: await Promise.all(
          materials.map(async (item) => ({
            ...item,
            source: await decodeMaterial(item.source),
          })),
        ),
      };
    },
  };
}

export function parseWireInline(
  input: unknown,
): InlineMaterial & { origin?: Origin } {
  const { origin, bytesBase64, mediaType, name } = parseValue(
    wireAcceptSchema,
    input,
    "input.invalid",
  );
  return {
    ...decodeInline({
      bytesBase64,
      mediaType,
      ...(name === undefined ? {} : { name }),
    }),
    ...(origin === undefined ? {} : { origin }),
  };
}
