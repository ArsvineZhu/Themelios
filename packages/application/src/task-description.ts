import { parseJson, type Json } from "@themelios/core";
import type { Prompts } from "@themelios/models/prompts";
import {
  sourcesJsonSchema,
  type TaskDefinition,
  type TaskDescription,
} from "@themelios/models/tasks";

function localizedSchema(
  schema: Json,
  translate: (key: string) => string,
): Json {
  if (Array.isArray(schema))
    return schema.map((value) => localizedSchema(value, translate));
  if (schema === null || typeof schema !== "object") return schema;
  const { descriptionKey, ...fields } = schema;
  const values = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      localizedSchema(value, translate),
    ]),
  );
  if (typeof descriptionKey === "string")
    values.description = translate(descriptionKey);
  return values;
}

export async function describeTask<I extends Json, O extends Json, RawI>(
  task: TaskDefinition<I, O, RawI>,
  prompts: Prompts,
  translate: (key: string) => string,
): Promise<TaskDescription> {
  const description = await prompts.describe(task);
  return {
    id: task.id,
    title: translate(task.titleKey),
    purpose: translate(task.purposeKey),
    inputSchema: localizedSchema(description.variablesSchema, translate),
    sourcesSchema: sourcesJsonSchema(),
    output: description.outputSchema
      ? {
          kind: "json",
          schema: localizedSchema(description.outputSchema, translate),
        }
      : { kind: "text" },
    requirements: task.requirements,
    templates: description.files,
    examples: task.examples.map((example) => ({
      ...example,
      variables: parseJson(example.variables),
      output: parseJson(example.output),
    })),
    outputRules: task.outputRuleKeys?.map(translate) ?? [],
  };
}
