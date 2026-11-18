import { appError, parseJson, parseValue, type Json } from "@themelios/core";
import { z } from "zod";
import {
  mimePatternSchema,
  modalityNeedSchema,
  modelNameSchema,
} from "./schema.js";
import type {
  SourceDirectory,
  SourceEntry,
  TaskDefinition,
  TaskRequirements,
} from "./task-contracts.js";

export type {
  OutputIssue,
  PreparedInput,
  Preview,
  SourceDirectory,
  SourceEntry,
  TaskDefinition,
  TaskDescription,
  TaskExample,
  TaskItemResult,
  TaskMaterial,
  TaskRequest,
  TaskRequirements,
  Tasks,
} from "./task-contracts.js";

const sourceSchema = z.strictObject({
  key: z
    .string()
    .regex(/^S[1-9]\d*$/)
    .describe("Short key for a material in this call."),
  mediaType: mimePatternSchema.describe("Media type of the original material."),
  name: z
    .string()
    .optional()
    .describe("Display name of the original material, when known."),
  originalExtent: z
    .string()
    .describe("Range of the original material selected for this call."),
  deliveredExtent: z
    .array(z.string())
    .describe("Actual representations or ranges passed to the task."),
  role: z
    .enum(["primary", "context"])
    .describe("Material being processed or auxiliary context."),
});
export const sourceEntrySchema = sourceSchema as z.ZodType<SourceEntry>;
export const taskExampleSourceSchema = sourceSchema.extend({
  text: z.string().optional(),
});

const directorySchema = z.array(sourceEntrySchema);
export const taskRequirementsSchema = z
  .strictObject({
    inputs: z.array(
      z.strictObject({
        mediaType: mimePatternSchema,
        needs: z.array(modalityNeedSchema).min(1),
      }),
    ),
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
  ) as z.ZodType<TaskRequirements>;

export function createSourceDirectory(
  input: readonly SourceEntry[],
): SourceDirectory {
  const entries = Object.freeze(
    parseValue(directorySchema, input, "input.invalid").map((entry) => {
      return Object.freeze({
        ...entry,
        deliveredExtent: Object.freeze(entry.deliveredExtent),
      });
    }),
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

export function taskInputJsonSchema(schema: z.ZodType): Json {
  return parseJson(z.toJSONSchema(schema, { io: "input" }));
}

export function inputVariables<I extends Json, O extends Json, RawI>(
  task: TaskDefinition<I, O, RawI>,
  input: unknown,
): I {
  parseJson(input);
  const variables = parseValue(task.input, input, "input.invalid");
  if (
    variables === null ||
    typeof variables !== "object" ||
    Array.isArray(variables) ||
    Object.hasOwn(variables, "sources")
  ) {
    throw appError("input.invalid", {
      details: {
        issues: [
          {
            path: ["variables"],
            reason: "Expected an object without the reserved sources field",
          },
        ],
      },
    });
  }
  parseJson(variables);
  return variables;
}

export function defineTask<I extends Json, O extends Json, RawI = I>(
  definition: TaskDefinition<I, O, RawI>,
): TaskDefinition<I, O, RawI> {
  parseValue(modelNameSchema, definition.id, "input.invalid");
  const requirements = parseValue(
    taskRequirementsSchema,
    definition.requirements,
    "input.invalid",
  );
  const input = taskInputJsonSchema(definition.input);
  const properties =
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    input.properties;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    input.type !== "object" ||
    (properties &&
      typeof properties === "object" &&
      Object.hasOwn(properties, "sources"))
  ) {
    throw appError("input.invalid", {
      details: {
        issues: [
          {
            path: [definition.id, "input"],
            reason: "Expected task variables with no sources field",
          },
        ],
      },
    });
  }
  if (definition.output !== "text") {
    const shape = z.toJSONSchema(definition.output);
    if (
      shape.type !== "object" ||
      Object.keys(shape.properties ?? {}).some(
        (key) => !shape.required?.includes(key),
      )
    ) {
      throw appError("input.invalid", {
        details: {
          issues: [
            {
              path: [definition.id, "output"],
              reason: "Structured tasks require an object with required fields",
            },
          ],
        },
      });
    }
  }
  if (definition.validateOutput && !definition.outputRuleKeys?.length)
    throw appError("input.invalid", {
      details: {
        issues: [
          {
            path: [definition.id, "outputRuleKeys"],
            reason: "Document the dynamic output rules",
          },
        ],
      },
    });
  validateTaskExamples(definition);
  return Object.freeze({
    ...definition,
    requirements: Object.freeze(requirements),
    templates: Object.freeze({ ...definition.templates }),
    examples: Object.freeze(structuredClone(definition.examples)),
  });
}

function validateTaskExamples<I extends Json, O extends Json, RawI>(
  definition: TaskDefinition<I, O, RawI>,
): void {
  for (const example of definition.examples) {
    const { sources, variables, output } = example;
    const directory = createSourceDirectory(
      sources.map(({ text: _text, ...entry }) => entry),
    );
    const args = inputVariables(definition, variables);
    const value =
      definition.output === "text"
        ? parseValue(z.string(), output, "input.invalid")
        : parseValue(definition.output, output, "input.invalid");
    const issues =
      definition.validateOutput?.(value as O, directory, args) ?? [];
    if (issues.length)
      throw appError("input.invalid", {
        details: { issues: parseJson(issues) },
      });
  }
}
