import { z } from "zod";
import { jsonSchema, type Json } from "./json.js";
import type { ErrorInfo } from "./errors.js";
import {
  artifactRefSchema,
  inlineMaterialSchema,
  selectionSchema,
  type ArtifactRef,
  type InlineMaterial,
  type Selection,
} from "./selection.js";

export interface ResultOutput {
  result: Completed | SavedResult;
  output?: string;
}

export type Material = Selection | InlineMaterial | ResultOutput;

export interface InputUse<S = Material> {
  source: S;
  delivered: readonly S[];
  role: "primary" | "context";
}

export interface Producer {
  kind: "model" | "transform" | "application";
  name: string;
  version?: string;
  details?: Json;
}

export interface ProducedFile {
  name: string;
  material: InlineMaterial | Selection;
  sourceIndices: readonly number[];
}

export const preparedRepresentationSchema = z.strictObject({
  source: selectionSchema,
  recipe: z.string().min(1),
  outputs: z.array(z.string().min(1)).min(1),
});
export type PreparedRepresentationIndex = z.infer<
  typeof preparedRepresentationSchema
>;

export interface Completed<T extends Json = Json> {
  value: T;
  inputs: readonly InputUse[];
  files: readonly ProducedFile[];
  representation?: PreparedRepresentationIndex | undefined;
  producer: Producer;
}

export interface SavedFile {
  material: Selection;
  sourceIndices: readonly number[];
}

export interface SavedResult<T extends Json = Json> {
  ref: ArtifactRef;
  value: T;
  inputs: readonly InputUse<Selection>[];
  files: Readonly<Record<string, SavedFile>>;
  producer: Producer;
}

const fileName = z
  .string()
  .min(1)
  .refine(
    (name) =>
      !name.includes("\0") &&
      !/[/\\]/.test(name) &&
      ![".", "..", "$value"].includes(name),
    "Expected a file name",
  );
const sourceIndices = z.array(z.int().nonnegative());

export const producerSchema: z.ZodType<Producer> = z
  .strictObject({
    kind: z.enum(["model", "transform", "application"]),
    name: z.string().min(1),
    version: z.string().min(1).optional(),
    details: jsonSchema.optional(),
  })
  .transform(({ version, details, ...data }): Producer => ({
    ...data,
    ...(version === undefined ? {} : { version }),
    ...(details === undefined ? {} : { details }),
  }));

// Content resolves and validates each referenced node during the graph walk, preserving object identity.
const resultHandle = z.custom<ResultOutput["result"]>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "value") &&
    Object.hasOwn(value, "files"),
);

export const resultOutputSchema: z.ZodType<ResultOutput> = z
  .strictObject({
    result: resultHandle,
    output: z.union([z.literal("$value"), fileName]).optional(),
  })
  .transform(({ result, output }): ResultOutput =>
    output === undefined ? { result } : { result, output },
  );

export const materialSchema: z.ZodType<Material> = z.union([
  selectionSchema,
  inlineMaterialSchema,
  resultOutputSchema,
]);

function inputUseSchema<S>(schema: z.ZodType<S>) {
  return z.strictObject({
    source: schema,
    delivered: z.array(schema).min(1),
    role: z.enum(["primary", "context"]),
  });
}

const manifest = {
  value: jsonSchema,
  producer: producerSchema,
};
const producedFileSchema = z.strictObject({
  name: fileName,
  material: z.union([inlineMaterialSchema, selectionSchema]),
  sourceIndices,
});

const savedFileSchema = z.strictObject({
  material: selectionSchema,
  sourceIndices,
});
const savedFilesSchema = z
  .custom<Record<string, unknown>>((value) => {
    if (typeof value !== "object" || value === null) return false;
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === null || prototype === Object.prototype;
  })
  .transform((files, ctx): Readonly<Record<string, SavedFile>> => {
    // Filenames are data. Generic record parsing drops the valid filename "__proto__".
    const entries: [string, SavedFile][] = [];
    for (const [name, file] of Object.entries(files)) {
      const validName = fileName.safeParse(name);
      const validFile = savedFileSchema.safeParse(file);
      if (!validName.success)
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: "Expected a file name",
        });
      if (!validFile.success) {
        for (const issue of validFile.error.issues) {
          ctx.addIssue({
            code: "custom",
            path: [name, ...issue.path],
            message: issue.message,
          });
        }
      } else if (validName.success) entries.push([name, validFile.data]);
    }
    return Object.fromEntries(entries);
  });

function checkFiles(
  files: Iterable<readonly [string, { sourceIndices: readonly number[] }]>,
  inputCount: number,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [name, value] of files) {
    if (seen.has(name))
      ctx.addIssue({
        code: "custom",
        path: ["files", name],
        message: "Duplicate output name",
      });
    seen.add(name);
    if (value.sourceIndices.some((index) => index >= inputCount)) {
      ctx.addIssue({
        code: "custom",
        path: ["files", name, "sourceIndices"],
        message: "Invalid source index",
      });
    }
  }
}

export const completedSchema: z.ZodType<Completed> = z
  .strictObject({
    representation: preparedRepresentationSchema.optional(),
    ...manifest,
    inputs: z.array(inputUseSchema(materialSchema)),
    files: z.array(producedFileSchema),
  })
  .superRefine((data, ctx) => {
    checkFiles(
      data.files.map((file) => [file.name, file]),
      data.inputs.length,
      ctx,
    );
  });

export const savedResultSchema: z.ZodType<SavedResult> = z
  .strictObject({
    ...manifest,
    ref: artifactRefSchema,
    inputs: z.array(inputUseSchema(selectionSchema)),
    files: savedFilesSchema,
  })
  .superRefine((data, ctx) => {
    checkFiles(Object.entries(data.files), data.inputs.length, ctx);
  });

export const errorInfoSchema: z.ZodType<ErrorInfo> = z
  .strictObject({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    details: jsonSchema.optional(),
    traceId: z.string().optional(),
  })
  .transform(({ details, traceId, ...rest }): ErrorInfo => ({
    ...rest,
    ...(details === undefined ? {} : { details }),
    ...(traceId === undefined ? {} : { traceId }),
  }));
