import { z } from "zod";
import { jsonSchema, type Json } from "./json.js";
import { appError } from "./errors.js";
import { mediaTypeSchema } from "./media-type.js";
import {
  representationCoverageSchema,
  sourceCoverageSchema,
  type RepresentationCoverage,
  type SourceCoverage,
} from "./media.js";
import {
  artifactRefSchema,
  inlineMaterialSchema,
  selectionRangeKey,
  selectionSchema,
  type ArtifactRef,
  type InlineMaterial,
  type Selection,
} from "./selection.js";

export interface ResultOutput {
  result: ArtifactRef | Completed;
  output?: string;
}

export type Material = Selection | InlineMaterial | ResultOutput;

export const sourceKeySchema = z.string().regex(/^S[1-9]\d*$/);
export const inputRoleSchema = z.enum(["primary", "context"]);
export type InputRole = z.output<typeof inputRoleSchema>;
export const inputOriginalSchema = z.strictObject({
  mediaType: mediaTypeSchema,
  name: z.string().min(1).optional(),
});

export interface InputUse<S = Material> {
  /** Key assigned by a task to this original source. */
  key?: string | undefined;
  original?: z.output<typeof inputOriginalSchema> | undefined;
  source: S;
  delivered: readonly S[];
  role: InputRole;
  coverage?: SourceCoverage | undefined;
}

export const producerSchema = z.strictObject({
  kind: z.enum(["model", "transform", "application"]),
  name: z.string().min(1),
  version: z.string().min(1).optional(),
  details: jsonSchema.optional(),
});
export type Producer = z.infer<typeof producerSchema>;

export interface ProducedFile {
  name: string;
  material: InlineMaterial | Selection;
  sourceIndices: readonly number[];
  coverage?: RepresentationCoverage | undefined;
}

export interface Completed<T extends Json = Json> {
  value: T;
  inputs: readonly InputUse[];
  files: readonly ProducedFile[];
  representation?: PreparedRepresentationIndex | undefined;
  producer: Producer;
}

export interface SavedFile {
  name: string;
  material: Selection;
  sourceIndices: readonly number[];
  coverage?: RepresentationCoverage | undefined;
}

export interface SavedResult<T extends Json = Json> {
  ref: ArtifactRef;
  value: T;
  inputs: readonly InputUse<Selection>[];
  files: readonly SavedFile[];
  producer: Producer;
}

export const resultValueOutput = "$value";

export function resultValueSelection(ref: ArtifactRef): Selection {
  return { ref, range: { kind: "json", pointer: "/value" } };
}

export const resultFileNameSchema = z
  .string()
  .min(1)
  .refine(
    (name) =>
      !name.includes("\0") &&
      !/[/\\]/.test(name) &&
      ![".", "..", resultValueOutput].includes(name),
    "Expected a file name",
  );
const sourceIndices = z.array(z.int().nonnegative());
export const resultOutputNameSchema = z.union([
  z.literal(resultValueOutput),
  resultFileNameSchema,
]);
export const resultOutputNamesSchema = z
  .array(resultOutputNameSchema)
  .min(1)
  .readonly();

export const preparedRepresentationSchema = z.strictObject({
  source: selectionSchema,
  recipe: z.string().min(1),
  outputs: resultOutputNamesSchema,
});
export type PreparedRepresentationIndex = z.infer<
  typeof preparedRepresentationSchema
>;

export function resultFile<F extends { name: string }>(
  result: { files: readonly F[] },
  output: string,
): F {
  const file = result.files.find(({ name }) => name === output);
  if (!file)
    throw appError("content.output_not_found", {
      details: {
        output,
        availableNames: [
          resultValueOutput,
          ...result.files.map(({ name }) => name),
        ],
      },
    });
  return file;
}

/** Matches selections and validates that the saved outputs derive from that input. */
export function assertResultSource(
  result: SavedResult,
  source: Selection,
  outputs: readonly string[],
): readonly SavedFile[] {
  const key = selectionRangeKey(source.range);
  const selected = new Set<number>();
  for (const [index, use] of result.inputs.entries()) {
    if (
      use.source.ref === source.ref &&
      selectionRangeKey(use.source.range) === key
    )
      selected.add(index);
  }
  function mismatch(output?: string): never {
    throw appError("content.representation_mismatch", {
      details: {
        source: { ref: source.ref, range: source.range ?? null },
        result: result.ref,
        ...(output === undefined ? {} : { output }),
      },
    });
  }
  if (!selected.size) mismatch();
  return outputs
    .filter((name) => name !== resultValueOutput)
    .map((name) => {
      const file = resultFile(result, name);
      if (!file.sourceIndices.some((index) => selected.has(index)))
        mismatch(name);
      return file;
    });
}

// Content resolves and validates each referenced node during the graph walk, preserving object identity.
const completedHandle = z.custom<Completed>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, "value") &&
    Object.hasOwn(value, "files"),
);

export const resultOutputSchema: z.ZodType<ResultOutput> = z
  .strictObject({
    result: z.union([artifactRefSchema, completedHandle]),
    output: resultOutputNameSchema.optional(),
  })
  .transform(({ result, output }): ResultOutput =>
    output === undefined ? { result } : { result, output },
  );

export const materialSchema: z.ZodType<Material> = z.union([
  selectionSchema,
  inlineMaterialSchema,
  resultOutputSchema,
]);

export function inputUseSchema<S>(schema: z.ZodType<S>) {
  return z.strictObject({
    key: sourceKeySchema.optional(),
    original: inputOriginalSchema.optional(),
    source: schema,
    delivered: z.array(schema).min(1),
    role: inputRoleSchema,
    coverage: sourceCoverageSchema.optional(),
  });
}

const manifest = {
  value: jsonSchema,
  producer: producerSchema,
};
export function resultFileSchema<S>(material: z.ZodType<S>) {
  return z.strictObject({
    name: resultFileNameSchema,
    material,
    sourceIndices,
    coverage: representationCoverageSchema.optional(),
  });
}

function checkFiles(
  files: readonly { name: string; sourceIndices: readonly number[] }[],
  inputCount: number,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, file] of files.entries()) {
    if (seen.has(file.name))
      ctx.addIssue({
        code: "custom",
        path: ["files", index, "name"],
        message: "Duplicate output name",
      });
    seen.add(file.name);
    if (file.sourceIndices.some((source) => source >= inputCount))
      ctx.addIssue({
        code: "custom",
        path: ["files", index, "sourceIndices"],
        message: "Invalid source index",
      });
  }
}

export const completedSchema: z.ZodType<Completed> = z
  .strictObject({
    representation: preparedRepresentationSchema.optional(),
    ...manifest,
    inputs: z.array(inputUseSchema(materialSchema)),
    files: z.array(
      resultFileSchema(z.union([inlineMaterialSchema, selectionSchema])),
    ),
  })
  .superRefine((data, ctx) => checkFiles(data.files, data.inputs.length, ctx));

export const savedResultSchema: z.ZodType<SavedResult> = z
  .strictObject({
    ...manifest,
    ref: artifactRefSchema,
    inputs: z.array(inputUseSchema(selectionSchema)),
    files: z.array(resultFileSchema(selectionSchema)),
  })
  .superRefine((data, ctx) => checkFiles(data.files, data.inputs.length, ctx));
