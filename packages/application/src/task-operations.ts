import type { Materials, Results } from "@themelios/content";
import {
  appError,
  createFlow,
  jsonSchema,
  toErrorInfo,
  type ArtifactRef,
  type CallOptions,
  type Completed,
  type ErrorInfo,
  type Flow,
  type Json,
  type SavedResult,
} from "@themelios/core";
import {
  modelNameSchema,
  type ApplicationPrompts,
  type Preview,
  type TaskDescription,
  type TaskRequest,
} from "@themelios/models";
import { taskExampleSourceSchema } from "@themelios/models/tasks";
import { z } from "zod";
import {
  defineOperation,
  type AnyOperation,
} from "@themelios/runtime/operations";
import {
  createWireCodec,
  decodeTaskMaterials,
  wirePreviewInputSchema,
  wirePreviewSchema,
  wireResultSchema,
  wireRunTaskSchema,
  type WireBatchItemResult,
  type WireCodec,
  type WireRunTaskInput,
  type WireTaskResult,
} from "./wire.js";

export type TaskResult = SavedResult | Completed;

export type BatchItemResult =
  | { readonly ok: true; readonly result: TaskResult }
  | { readonly ok: false; readonly error: ErrorInfo };

export interface RunTaskInput extends TaskRequest<Json> {
  readonly task: string;
  readonly persist?: boolean;
}

export interface ApplicationTasks {
  run(input: RunTaskInput, options?: CallOptions): Promise<TaskResult>;
  stream(input: RunTaskInput, options?: CallOptions): Flow<TaskResult>;
  runMany(
    inputs: readonly RunTaskInput[],
    options?: CallOptions,
  ): Promise<readonly BatchItemResult[]>;
  preview(
    input: TaskRequest<Json> & { readonly task: string },
    options?: CallOptions,
  ): Promise<Preview>;
  describe(task: string): Promise<TaskDescription>;
  list(): readonly {
    readonly id: string;
    readonly title: string;
    readonly purpose: string;
  }[];
  present?(task: string, result: Pick<Completed, "value" | "inputs">): string;
}

export interface TaskOperationTarget {
  readonly materials: Materials;
  readonly results: Results;
  readonly tasks: ApplicationTasks;
  readonly prompts: ApplicationPrompts;
}

const emptySchema = z.strictObject({});
const taskIdSchema = z.strictObject({ task: modelNameSchema });
const promptPartSchema = z.enum(["system", "user"]);

const promptFileInfoSchema = z.strictObject({
  role: promptPartSchema,
  path: z.string(),
  source: z.enum(["builtin", "override", "inline"]),
});

const promptTemplatesSchema = z.strictObject({
  system: z.string(),
  user: z.string(),
  files: z.array(promptFileInfoSchema),
});

const promptDescriptionSchema = z.strictObject({
  files: z.array(promptFileInfoSchema),
  variablesSchema: jsonSchema,
  outputSchema: jsonSchema.optional(),
  requirements: jsonSchema,
});

const promptDiffSchema = z.strictObject({
  role: promptPartSchema,
  builtin: z.string(),
  override: z.string().optional(),
});

const taskDescriptionSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  purpose: z.string(),
  inputSchema: jsonSchema,
  sourcesSchema: jsonSchema,
  output: z.union([
    z.strictObject({ kind: z.literal("text") }),
    z.strictObject({ kind: z.literal("json"), schema: jsonSchema }),
  ]),
  requirements: jsonSchema,
  templates: z.array(promptFileInfoSchema),
  examples: z.array(
    z.strictObject({
      name: z.string(),
      variables: jsonSchema,
      sources: z.array(taskExampleSourceSchema),
      output: jsonSchema,
    }),
  ),
  outputRules: z.array(z.string()),
});

const batchSchema = z.array(
  z.union([
    z.strictObject({ ok: z.literal(true), result: wireResultSchema }),
    z.strictObject({
      ok: z.literal(false),
      error: z.strictObject({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
        details: jsonSchema.optional(),
        traceId: z.string().optional(),
      }),
    }),
  ]),
);

function encodeTaskResult(codec: WireCodec, value: TaskResult): WireTaskResult {
  return "ref" in value ? value : codec.encodeCompleted(value);
}

async function decodeRunTask(
  app: TaskOperationTarget,
  wire: WireRunTaskInput,
  options?: CallOptions,
): Promise<{ codec: WireCodec; input: RunTaskInput }> {
  const codec = createWireCodec(
    {
      resolve: (ref) => app.materials.resolve(ref),
      readResult: (ref: ArtifactRef, opts?: CallOptions) =>
        app.results.read(ref, opts),
    },
    options,
  );
  const materials = await decodeTaskMaterials(codec, wire.materials);
  return {
    codec,
    input: {
      task: wire.task,
      variables: wire.variables ?? {},
      materials,
      ...(wire.model === undefined ? {} : { model: wire.model }),
      ...(wire.parameters === undefined ? {} : { parameters: wire.parameters }),
      ...(wire.persist === undefined ? {} : { persist: wire.persist }),
    },
  };
}

export function taskOperations<
  App extends TaskOperationTarget,
>(): readonly AnyOperation<App>[] {
  return [
    defineOperation<App, Record<string, never>, unknown>({
      id: "tasks.list",
      description: "List registered tasks.",
      permission: "read",
      input: emptySchema,
      output: z.array(
        z.strictObject({
          id: z.string(),
          title: z.string(),
          purpose: z.string(),
        }),
      ),
      mcp: { readOnlyHint: true, idempotentHint: true },
      http: { method: "GET", path: "/tasks" },
      execute: (app) => app.tasks.list(),
    }),
    defineOperation<App, { task: string }, unknown>({
      id: "tasks.describe",
      description:
        "Describe variables, output, requirements and templates of a task.",
      permission: "read",
      input: taskIdSchema,
      output: taskDescriptionSchema,
      mcp: { readOnlyHint: true, idempotentHint: true },
      http: { method: "GET", path: "/tasks/:id", paramMap: { id: "task" } },
      execute: (app, { task }) => app.tasks.describe(task),
    }),
    defineOperation<App, z.infer<typeof wirePreviewInputSchema>, unknown>({
      id: "tasks.preview",
      description: "Compile the prompt and show planned media preparation.",
      permission: "read",
      input: wirePreviewInputSchema,
      output: wirePreviewSchema,
      mcp: { readOnlyHint: true, idempotentHint: true },
      http: {
        method: "POST",
        path: "/tasks/:id/preview",
        paramMap: { id: "task" },
        mergeParamsIntoBody: true,
      },
      async execute(app, wire, context) {
        const { codec, input } = await decodeRunTask(
          app,
          wire,
          context.options,
        );
        return codec.encodePreview(
          await app.tasks.preview(input, context.options),
        );
      },
    }),
    defineOperation<App, WireRunTaskInput, WireTaskResult>({
      id: "tasks.run",
      description: "Run a task on a group of materials; optionally save it.",
      permission: "write",
      input: wireRunTaskSchema,
      output: wireResultSchema,
      http: {
        method: "POST",
        path: "/tasks/:id/run",
        paramMap: { id: "task" },
        mergeParamsIntoBody: true,
      },
      present(output, app) {
        if (app.tasks.present) {
          return app.tasks.present(
            output.producer.name,
            output as Pick<Completed, "value" | "inputs">,
          );
        }
        return JSON.stringify(output, null, 2);
      },
      async execute(app, wire, context) {
        const { codec, input } = await decodeRunTask(
          app,
          wire,
          context.options,
        );
        return encodeTaskResult(
          codec,
          await app.tasks.run(input, context.options),
        );
      },
    }),
    defineOperation<App, { inputs: WireRunTaskInput[] }, WireBatchItemResult[]>(
      {
        id: "tasks.runMany",
        description:
          "Run independent requests in order, with item-level errors.",
        permission: "write",
        input: z.strictObject({ inputs: z.array(wireRunTaskSchema) }),
        output: batchSchema,
        http: { method: "POST", path: "/tasks/run-many" },
        async execute(app, { inputs }, context) {
          const decoded = await Promise.all(
            inputs.map(async (wire) => {
              try {
                return await decodeRunTask(app, wire, context.options);
              } catch (error) {
                return { error: toErrorInfo(error) };
              }
            }),
          );
          const valid = decoded.flatMap((item) =>
            "input" in item ? [item] : [],
          );
          const outcomes = (
            await app.tasks.runMany(
              valid.map((item) => item.input),
              context.options,
            )
          )[Symbol.iterator]();
          return decoded.map((item): WireBatchItemResult => {
            if ("error" in item) return { ok: false, error: item.error };
            const outcome = outcomes.next().value!;
            return outcome.ok
              ? {
                  ok: true,
                  result: encodeTaskResult(item.codec, outcome.result),
                }
              : outcome;
          });
        },
      },
    ),
    defineOperation<App, WireRunTaskInput, WireTaskResult>({
      id: "tasks.stream",
      description: "Stream progress, text and the final task result.",
      permission: "write",
      kind: "stream",
      input: wireRunTaskSchema,
      output: wireResultSchema,
      mcp: { expose: false },
      http: {
        method: "POST",
        path: "/tasks/:id/stream",
        paramMap: { id: "task" },
        mergeParamsIntoBody: true,
      },
      execute(app, wire, context) {
        return createFlow(
          "tasks.stream",
          async function* (call) {
            const options = { signal: call.signal };
            const { codec, input } = await decodeRunTask(app, wire, options);
            for await (const event of app.tasks.stream(input, options)) {
              if (event.type === "result") {
                const output = encodeTaskResult(codec, event.value);
                return output;
              }
              yield event;
            }
            throw appError("model.incomplete", {
              details: { stage: "stream" },
            });
          },
          context.options,
        );
      },
    }),
    defineOperation<App, { task: string }, unknown>({
      id: "prompts.read",
      description: "Read the active system and user templates.",
      permission: "read",
      input: taskIdSchema,
      output: promptTemplatesSchema,
      mcp: { expose: false, readOnlyHint: true },
      http: {
        method: "GET",
        path: "/tasks/:id/prompts",
        paramMap: { id: "task" },
      },
      execute: (app, { task }) => app.prompts.read(task),
    }),
    defineOperation<App, { task: string }, unknown>({
      id: "prompts.describe",
      description: "Describe prompt variables, output and template sources.",
      permission: "read",
      input: taskIdSchema,
      output: promptDescriptionSchema,
      mcp: { expose: false, readOnlyHint: true },
      http: {
        method: "GET",
        path: "/tasks/:id/prompts/describe",
        paramMap: { id: "task" },
      },
      execute: (app, { task }) => app.prompts.describe(task),
    }),
    defineOperation<App, { task: string }, unknown>({
      id: "prompts.diff",
      description: "Get builtin and instance override templates.",
      permission: "read",
      input: taskIdSchema,
      output: z.array(promptDiffSchema),
      mcp: { expose: false, readOnlyHint: true },
      http: {
        method: "GET",
        path: "/tasks/:id/prompts/diff",
        paramMap: { id: "task" },
      },
      execute: (app, { task }) => app.prompts.diff(task),
    }),
    defineOperation<
      App,
      { task: string; role: "system" | "user"; template: string },
      unknown
    >({
      id: "prompts.setOverride",
      description: "Compile and save an instance template override.",
      permission: "admin",
      input: taskIdSchema.extend({
        role: promptPartSchema,
        template: z.string(),
      }),
      output: promptDescriptionSchema,
      mcp: { expose: false, destructiveHint: true },
      http: {
        method: "POST",
        path: "/tasks/:id/prompts/override",
        paramMap: { id: "task" },
        mergeParamsIntoBody: true,
      },
      execute: (app, { task, role, template }) =>
        app.prompts.setOverride(task, { role, template }),
    }),
    defineOperation<
      App,
      { task: string; role?: "system" | "user" | undefined },
      unknown
    >({
      id: "prompts.reset",
      description: "Reset one or both templates to builtin values.",
      permission: "admin",
      input: taskIdSchema.extend({ role: promptPartSchema.optional() }),
      output: promptDescriptionSchema,
      mcp: { expose: false, destructiveHint: true },
      http: {
        method: "POST",
        path: "/tasks/:id/prompts/reset",
        paramMap: { id: "task" },
        mergeParamsIntoBody: true,
      },
      execute: (app, { task, role }) => app.prompts.reset(task, role),
    }),
  ];
}
