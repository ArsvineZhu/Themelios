import {
  appError,
  parseJson,
  parseValue,
  plainTextMediaType,
  type InputUse,
  type Json,
} from "@themelios/core";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { mediaDescriptionRecipe } from "./representation-route.js";
import {
  createSourceDirectory,
  modelNameSchema,
  outputSchema,
  sourceDirectoryFromInputs,
  sourcesJsonSchema,
  taskRequirementsSchema,
  textOutput,
} from "./schema.js";
import type {
  CompiledPrompt,
  ModelMessage,
  ModelPart,
  ModelOutput,
  Prompts,
  TaskDefinition,
  TaskDefinitionInput,
  TaskDescription,
} from "./types.js";

export function taskInputJsonSchema(schema: z.ZodType): Json {
  return parseJson(z.toJSONSchema(schema, { io: "input" }));
}

export function inputVariables<I extends Json, O extends Json, RawI>(
  task: TaskDefinition<I, O, RawI>,
  input: unknown,
  defaults?: Readonly<Record<string, Json>>,
): I {
  const json = parseJson(input);
  const supplied =
    defaults &&
    json !== null &&
    typeof json === "object" &&
    !Array.isArray(json)
      ? { ...defaults, ...json }
      : json;
  const variables = parseValue(task.input, supplied, "input.invalid");
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
  definition: TaskDefinitionInput<I, O, RawI>,
): TaskDefinition<I, O, RawI> {
  parseValue(modelNameSchema, definition.id, "input.invalid");
  const requirements = parseValue(
    taskRequirementsSchema,
    definition.requirements,
    "input.invalid",
  );
  validateTaskInput(definition.id, definition.input);
  validateTaskOutput(definition.id, definition.output);
  const normalized: TaskDefinition<I, O, RawI> = {
    ...definition,
    title: definition.title ?? definition.titleKey ?? definition.id,
    purpose: definition.purpose ?? definition.purposeKey ?? definition.id,
    titleKey: definition.titleKey ?? definition.title ?? definition.id,
    purposeKey: definition.purposeKey ?? definition.purpose ?? definition.id,
    output: Object.freeze({ ...definition.output }),
    requirements: Object.freeze(requirements),
    templates: Object.freeze({ ...definition.templates }),
    examples: Object.freeze(structuredClone(definition.examples ?? [])),
    outputRuleKeys: Object.freeze([...(definition.outputRuleKeys ?? [])]),
  };
  validateTaskExamples(normalized);
  return Object.freeze(normalized);
}

function validateTaskInput(id: string, schema: z.ZodType) {
  const input = taskInputJsonSchema(schema);
  if (
    !isJsonObject(input) ||
    input.type !== "object" ||
    (isJsonObject(input.properties) &&
      Object.hasOwn(input.properties, "sources"))
  ) {
    throw appError("input.invalid", {
      details: {
        issues: [
          {
            path: [id, "input"],
            reason: "Expected task variables with no sources field",
          },
        ],
      },
    });
  }
}

function validateTaskOutput(id: string, output: ModelOutput<Json>) {
  if (output.kind === "json") {
    const shape = z.toJSONSchema(output.schema);
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
              path: [id, "output"],
              reason: "Structured tasks require an object with required fields",
            },
          ],
        },
      });
    }
  }
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
    const value = parseValue(definition.output.schema, output, "input.invalid");
    const issues = definition.validateOutput?.(value, directory, args) ?? [];
    if (issues.length)
      throw appError("input.invalid", {
        details: { issues: parseJson(issues) },
      });
  }
}

export async function describeTask<I extends Json, O extends Json, RawI>(
  task: TaskDefinition<I, O, RawI>,
  prompts: Prompts,
  translate: (key: string) => string = (key) => key,
): Promise<TaskDescription> {
  const { files } = await prompts.read(task);
  const inputSchema = taskInputJsonSchema(task.input);
  const resolvedTitle =
    task.titleKey !== task.id ? translate(task.titleKey) : task.title;
  const resolvedPurpose =
    task.purposeKey !== task.id ? translate(task.purposeKey) : task.purpose;
  const title = resolvedTitle === task.titleKey ? task.title : resolvedTitle;
  const purpose =
    resolvedPurpose === task.purposeKey ? task.purpose : resolvedPurpose;
  return {
    id: task.id,
    title,
    purpose,
    inputSchema: withDescriptions(inputSchema, task.input, translate),
    sourcesSchema: sourcesJsonSchema(),
    output:
      task.output.kind === "text"
        ? { kind: "text" }
        : {
            kind: "json",
            schema: withDescriptions(
              outputSchema(task.output.schema),
              task.output.schema,
              translate,
            ),
          },
    requirements: task.requirements,
    templates: files,
    examples: [...task.examples],
    outputRules: (task.outputRuleKeys ?? []).map((key) => translate(key)),
  };
}

/** Renders a task result using the original source directory recorded at execution. */
export function presentTask<I extends Json, O extends Json, RawI>(
  task: TaskDefinition<I, O, RawI>,
  result: {
    readonly value: O;
    readonly inputs: readonly Pick<
      InputUse,
      "key" | "original" | "coverage" | "role"
    >[];
  },
  locale?: string,
): string {
  return task.present
    ? task.present(
        result.value,
        sourceDirectoryFromInputs(result.inputs),
        locale,
      )
    : JSON.stringify(result, null, 2);
}

function isJsonObject(value: Json | undefined): value is Record<string, Json> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function withDescriptions(
  schema: Json,
  zodSchema: z.ZodType,
  translate: (key: string) => string,
): Json {
  if (!isJsonObject(schema)) return schema;
  const unwrapped = unwrap(zodSchema);
  const next: Record<string, Json> = { ...schema };
  const key = zodSchema.meta()?.descriptionKey;
  if (typeof key === "string") next.description = translate(key);
  if (unwrapped instanceof z.ZodObject && isJsonObject(next.properties)) {
    const props = { ...next.properties };
    for (const [field, child] of Object.entries(unwrapped.shape)) {
      if (Object.hasOwn(props, field))
        props[field] = withDescriptions(
          props[field]!,
          child as z.ZodType,
          translate,
        );
    }
    next.properties = props;
  }
  if (unwrapped instanceof z.ZodArray && next.items !== undefined) {
    next.items = withDescriptions(
      next.items,
      unwrapped.element as z.ZodType,
      translate,
    );
  }
  return next;
}

function unwrap(schema: z.ZodType): z.ZodType {
  let current: unknown = schema;
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable ||
    current instanceof z.ZodDefault
  ) {
    current = (current as z.ZodOptional<z.ZodType>).unwrap();
  }
  return current as z.ZodType;
}

export function messagesWithParts(
  prompt: CompiledPrompt,
  parts: readonly ModelPart[],
): readonly ModelMessage[] {
  return prompt.messages.map((message) =>
    message.role === "user"
      ? { ...message, parts: [...message.parts, ...parts] }
      : message,
  );
}

const mediaDescriptionInput = z
  .object({
    language: z
      .string()
      .trim()
      .min(1)
      .default("zh-CN")
      .meta({ descriptionKey: "tasks.mediaDescription.fields.language" }),
    instructions: z
      .string()
      .nullable()
      .default(null)
      .meta({ descriptionKey: "tasks.mediaDescription.fields.instructions" }),
  })
  .strict();

export const mediaDescription = defineTask<
  z.output<typeof mediaDescriptionInput>,
  string,
  z.input<typeof mediaDescriptionInput>
>({
  id: mediaDescriptionRecipe,
  titleKey: "tasks.mediaDescription.title",
  purposeKey: "tasks.mediaDescription.purpose",
  input: mediaDescriptionInput,
  output: textOutput,
  requirements: {
    minMaterials: 1,
    maxMaterials: 1,
    inputs: [
      { mediaType: "text/*", accepts: [["text"]] },
      { mediaType: "application/json", accepts: [["text"]] },
      { mediaType: "image/*", accepts: [["visual"]] },
      { mediaType: "application/pdf", accepts: [["text", "visual"]] },
      { mediaType: "audio/*", accepts: [["speech"]] },
      { mediaType: "video/*", accepts: [["visual", "speech", "motion"]] },
    ],
  },
  templates: {
    resourceRoot: fileURLToPath(
      new URL("../resources/tasks/", import.meta.url),
    ),
    system: "system.md.liquid",
    user: "user.md.liquid",
  },
  examples: [
    {
      name: "short-note",
      variables: { language: "zh-CN", instructions: null },
      sources: [
        {
          key: "S1",
          mediaType: plainTextMediaType,
          role: "primary",
          originalExtent: {
            kind: "text",
            bytes: Buffer.byteLength("下午三点在图书馆讨论接口设计。"),
          },
          requestedRange: null,
          delivered: [
            {
              mediaType: plainTextMediaType,
              sourceRange: null,
              extent: {
                kind: "text",
                bytes: Buffer.byteLength("下午三点在图书馆讨论接口设计。"),
              },
            },
          ],
          text: "下午三点在图书馆讨论接口设计。",
        },
      ],
      output:
        "这是一条安排讨论的文字通知：时间为下午三点，地点为图书馆，主题为接口设计。",
    },
  ],
});
