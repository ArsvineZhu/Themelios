import {
  appError,
  createFlow,
  type CallOptions,
  type CallScope,
  type Completed,
  type Json,
  openCall,
  parseJson,
  parseValue,
  toErrorInfo,
} from "@themelios/core";
import type { Diagnostics } from "@themelios/runtime/diagnostics";
import PQueue from "p-queue";
import { z } from "zod";
import { providerOutputSchema } from "./generation.js";
import {
  createSourceDirectory,
  mimePatternSchema,
  modalityNeedSchema,
  modelNameSchema,
  outputSchema,
  sourceEntrySchema,
  sourcesJsonSchema,
} from "./schema.js";
import type {
  CompiledPrompt,
  Generated,
  ModelMessage,
  ModelPart,
  Models,
  Preparation,
  PreparedInput,
  Preview,
  Prompts,
  TaskDefinition,
  TaskDefinitionInput,
  TaskDescription,
  TaskItemResult,
  TaskRequest,
  TaskRequirements,
  TaskRoute,
  Tasks,
} from "./types.js";

export * from "./types.js";
export { createSourceDirectory, sourceEntrySchema, sourcesJsonSchema };
export {
  createPreparation,
  rangeDescription,
  readMediaBytes,
} from "./preparation.js";

export const taskExampleSourceSchema = z.strictObject({
  key: z.string().regex(/^S[1-9]\d*$/),
  mediaType: mimePatternSchema,
  name: z.string().optional(),
  originalExtent: z.string(),
  deliveredExtent: z.array(z.string()),
  role: z.enum(["primary", "context"]),
  text: z.string().optional(),
});

export const taskRequirementsSchema: z.ZodType<TaskRequirements> = z
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
            path: [id, "input"],
            reason: "Expected task variables with no sources field",
          },
        ],
      },
    });
  }
}

function validateTaskOutput(id: string, schema: "text" | z.ZodType) {
  if (schema !== "text") {
    const shape = z.toJSONSchema(schema);
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

export async function describeTask<I extends Json, O extends Json, RawI>(
  task: TaskDefinition<I, O, RawI>,
  prompts: Prompts,
  translate: (key: string) => string = (key) => key,
): Promise<TaskDescription> {
  const description = await prompts.describe(task);
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
      task.output === "text"
        ? { kind: "text" }
        : {
            kind: "json",
            schema: withDescriptions(
              outputSchema(task.output),
              task.output,
              translate,
            ),
          },
    requirements: task.requirements,
    templates: description.files,
    examples: [...task.examples],
    outputRules: (task.outputRuleKeys ?? []).map((key) => translate(key)),
  };
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

function messagesWithParts(
  prompt: CompiledPrompt,
  parts: readonly ModelPart[],
): readonly ModelMessage[] {
  return prompt.messages.map((message) =>
    message.role === "user"
      ? { ...message, parts: [...message.parts, ...parts] }
      : message,
  );
}

export interface TaskExecutionOptions {
  readonly models: Models;
  readonly prompts: Prompts;
  readonly preparation: Preparation;
  readonly routes: Readonly<Record<string, TaskRoute>>;
  readonly diagnostics?: Diagnostics;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
}

export function createTasks(resources: TaskExecutionOptions): Tasks {
  const { models, prompts, preparation, routes, diagnostics } = resources;
  const runSpan = <T>(name: string, work: () => Promise<T>): Promise<T> =>
    diagnostics ? diagnostics.span(name, work) : work();

  function modelFor(id: string, override?: string) {
    const route = Object.hasOwn(routes, id) ? routes[id] : undefined;
    const model = override ?? route?.model;
    if (!model)
      throw appError("model.binding_not_found", { details: { binding: id } });
    return {
      ...route,
      model,
      capabilities: models.describe(model).capabilities,
    };
  }
  const budget = (options?: CallOptions): CallOptions => ({
    timeoutMs: resources.timeoutMs ?? 120_000,
    ...options,
  });

  async function prepare<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
    request: TaskRequest<RawI>,
    call: CallScope,
  ) {
    call.throwIfAborted("input");
    const variables = inputVariables(task, request.variables);
    const route = modelFor(task.id, request.model);
    const parameters =
      route.parameters || request.parameters
        ? {
            ...route.parameters,
            ...request.parameters,
            ...(route.parameters?.providerOptions ||
            request.parameters?.providerOptions
              ? {
                  providerOptions: {
                    ...route.parameters?.providerOptions,
                    ...request.parameters?.providerOptions,
                  },
                }
              : {}),
          }
        : undefined;
    const prepared = await runSpan("input.prepare", () =>
      preparation.forModel(
        request.materials,
        task.requirements,
        route.capabilities,
        {
          signal: call.signal,
          ...(route.preparation === undefined
            ? {}
            : { preparation: route.preparation }),
          onProgress: (update) => call.progress(update),
        },
      ),
    );
    const prompt = await runSpan("prompt.render", () =>
      prompts.compile(task, variables, prepared.sources),
    );
    call.throwIfAborted("prompt");
    return {
      prepared,
      prompt,
      variables,
      request: {
        model: route.model,
        messages: messagesWithParts(prompt, prepared.parts),
        output: task.output,
        ...(parameters === undefined ? {} : { parameters }),
      },
    };
  }

  function complete<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
    prepared: PreparedInput,
    variables: I,
    prompt: CompiledPrompt,
    generated: Generated<O>,
  ): Completed<O> {
    const issues =
      task.validateOutput?.(generated.value, prepared.sources, variables) ?? [];
    if (issues.length)
      throw appError("model.output_invalid", {
        details: {
          binding: generated.model.binding,
          issues: parseJson(issues),
        },
      });
    return {
      value: generated.value,
      inputs: prepared.uses,
      files: [],
      producer: {
        kind: "model",
        name: task.id,
        details: parseJson({
          ...generated.model,
          ...(generated.usage === undefined ? {} : { usage: generated.usage }),
          prompts: prompt.files.map((file) => ({
            role: file.role,
            source: file.source,
          })),
          ...(task.output === "text"
            ? {}
            : { schema: providerOutputSchema(task.output) }),
        }),
      },
    };
  }

  return {
    async run(task, request, options) {
      const call = openCall(task.id, budget(options));
      try {
        const prepared = await prepare(task, request, call);
        const generated = await models.generate(prepared.request, {
          signal: call.signal,
          onProgress: (update) => call.progress(update),
        });
        return complete(
          task,
          prepared.prepared,
          prepared.variables,
          prepared.prompt,
          generated,
        );
      } finally {
        call.close();
      }
    },
    stream(task, request, options) {
      parseJson(request.variables);
      const fixed = structuredClone(request);
      return createFlow(
        task.id,
        async function* (call) {
          yield { type: "progress", progress: { stage: "prepare" } };
          const prepared = await prepare(task, fixed, call);
          const generated = models.stream(prepared.request, {
            signal: call.signal,
          });
          let bytes = 0;
          for await (const event of generated) {
            if (event.type === "result")
              return complete(
                task,
                prepared.prepared,
                prepared.variables,
                prepared.prompt,
                event.value,
              );
            if (event.type === "text-delta") {
              bytes += Buffer.byteLength(event.text);
              if (bytes > 10 * 1024 * 1024)
                throw appError("model.output_invalid", {
                  details: {
                    binding: prepared.request.model,
                    issues: [
                      {
                        path: ["output"],
                        reason: "Stream output exceeds limit",
                      },
                    ],
                  },
                });
            }
            yield event;
          }
          throw appError("model.incomplete", {
            details: { binding: prepared.request.model },
          });
        },
        budget(options),
      );
    },
    async runMany<I extends Json, O extends Json, RawI>(
      task: TaskDefinition<I, O, RawI>,
      requests: readonly TaskRequest<RawI>[],
      options?: CallOptions,
    ): Promise<readonly TaskItemResult<O>[]> {
      const scope = openCall(task.id + ".many", budget(options));
      const queue = new PQueue({ concurrency: resources.concurrency ?? 4 });
      try {
        return await Promise.all(
          requests.map((request) =>
            queue.add(
              async (): Promise<TaskItemResult<O>> => {
                try {
                  return {
                    ok: true,
                    result: await this.run(task, request, {
                      signal: scope.signal,
                    }),
                  };
                } catch (error) {
                  return { ok: false, error: toErrorInfo(error) };
                }
              },
              { signal: scope.signal },
            ),
          ),
        );
      } finally {
        queue.pause();
        queue.clear();
        scope.close();
      }
    },
    async preview(task, request, options) {
      const call = openCall(task.id + ".preview", budget(options));
      try {
        call.throwIfAborted("input");
        const variables = inputVariables(task, request.variables);
        const route = modelFor(task.id, request.model);
        const { capabilities } = models.describe(route.model);
        const plan = await preparation.plan(
          request.materials,
          task.requirements,
          capabilities,
          {
            signal: call.signal,
            ...(route.preparation === undefined
              ? {}
              : { preparation: route.preparation }),
          },
        );
        const prompt = await prompts.compile(task, variables, plan.sources);
        const messages = messagesWithParts(prompt, plan.readyParts).map(
          (message) => ({
            role: message.role,
            parts: message.parts.map((part) =>
              part.kind === "text"
                ? part
                : {
                    kind: "media" as const,
                    mediaType: part.mediaType,
                    ...(part.name === undefined ? {} : { name: part.name }),
                    sizeBytes: part.bytes.byteLength,
                  },
            ),
          }),
        );
        return {
          model: route.model,
          messages,
          sources: plan.sources,
          pending: plan.pending,
          ...(task.output === "text"
            ? {}
            : {
                taskSchema: outputSchema(task.output),
                sentSchema: providerOutputSchema(task.output),
              }),
        } satisfies Preview;
      } finally {
        call.close();
      }
    },
  };
}

const mediaDescriptionInput = z
  .object({
    language: z
      .enum(["zh-CN", "en"])
      .default("zh-CN")
      .meta({ descriptionKey: "tasks.mediaDescription.fields.language" }),
    instructions: z
      .string()
      .max(4000)
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
  id: "media.describe",
  titleKey: "tasks.mediaDescription.title",
  purposeKey: "tasks.mediaDescription.purpose",
  input: mediaDescriptionInput,
  output: "text",
  requirements: {
    minMaterials: 1,
    maxMaterials: 1,
    inputs: [
      { mediaType: "text/plain", needs: ["text"] },
      { mediaType: "text/markdown", needs: ["text"] },
      { mediaType: "image/*", needs: ["visual"] },
      { mediaType: "application/pdf", needs: ["text", "visual"] },
      { mediaType: "audio/*", needs: ["speech"] },
      { mediaType: "video/*", needs: ["visual", "speech", "motion"] },
    ],
  },
  templates: { system: "system.md.liquid", user: "user.md.liquid" },
  examples: [
    {
      name: "short-note",
      variables: { language: "zh-CN", instructions: null },
      sources: [
        {
          key: "S1",
          mediaType: "text/plain",
          role: "primary",
          originalExtent: "全文",
          deliveredExtent: ["全文"],
          text: "下午三点在图书馆讨论接口设计。",
        },
      ],
      output:
        "这是一条安排讨论的文字通知：时间为下午三点，地点为图书馆，主题为接口设计。",
    },
  ],
});
