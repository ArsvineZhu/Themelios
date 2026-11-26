import {
  mapFlowResult,
  errorInfoSchema,
  type CallOptions,
  type Completed,
  type ErrorInfo,
  type Flow,
  type Json,
  type SavedResult,
} from "@themelios/core";
import {
  modelNameSchema,
  previewSchema,
  promptRoleSchema,
  promptTemplatesSchema,
  promptDescriptionSchema,
  promptDiffSchema,
  taskDescriptionSchema,
  type ApplicationPrompts,
  type Preview,
  type TaskDescription,
  type TaskRequest,
} from "@themelios/models";
import { z } from "zod";
import {
  defineOperation,
  standardPermission,
  type AnyOperation,
} from "@themelios/runtime/operations";
import {
  encodeCompleted,
  decodeTaskMaterials,
  wirePreviewInputSchema,
  wireResultSchema,
  wireRunTaskSchema,
  type WireBatchItemResult,
  type WireRunTaskInput,
  type WireTaskResult,
} from "./wire.js";

export type TaskResult = SavedResult | Completed;

export type BatchItemResult =
  | { readonly ok: true; readonly result: TaskResult }
  | { readonly ok: false; readonly error: ErrorInfo };

export interface RunTaskInput extends TaskRequest<Json> {
  readonly task: string;
}

export interface BatchTaskInput extends RunTaskInput {
  readonly persist?: boolean;
}

export interface ApplicationTasks {
  run(input: RunTaskInput, options?: CallOptions): Promise<Completed>;
  runAndSave(input: RunTaskInput, options?: CallOptions): Promise<SavedResult>;
  stream(input: RunTaskInput, options?: CallOptions): Flow<Completed>;
  streamAndSave(input: RunTaskInput, options?: CallOptions): Flow<SavedResult>;
  runMany(
    inputs: readonly BatchTaskInput[],
    options?: CallOptions,
  ): Promise<readonly BatchItemResult[]>;
  preview(input: RunTaskInput, options?: CallOptions): Promise<Preview>;
  describe(task: string, locale?: string): Promise<TaskDescription>;
  list(locale?: string): readonly {
    readonly id: string;
    readonly title: string;
    readonly purpose: string;
  }[];
  present?(
    task: string,
    result: Pick<TaskResult | WireTaskResult, "value" | "inputs">,
    locale?: string,
  ): string;
}

export interface TaskOperationTarget {
  readonly tasks: ApplicationTasks;
  readonly prompts: ApplicationPrompts;
}

export const taskOperationIds = {
  list: "tasks.list",
  describe: "tasks.describe",
  preview: "tasks.preview",
  run: "tasks.run",
  stream: "tasks.stream",
  runMany: "tasks.runMany",
} as const;

export const promptOperationIds = {
  read: "prompts.read",
  describe: "prompts.describe",
  diff: "prompts.diff",
  setOverride: "prompts.setOverride",
  reset: "prompts.reset",
} as const;

const emptySchema = z.strictObject({});
const taskIdSchema = z.strictObject({ task: modelNameSchema });
const batchSchema = z.array(
  z.union([
    z.strictObject({ ok: z.literal(true), result: wireResultSchema }),
    z.strictObject({
      ok: z.literal(false),
      error: errorInfoSchema,
    }),
  ]),
);

function encodeTaskResult(value: TaskResult): WireTaskResult {
  return "ref" in value ? value : encodeCompleted(value);
}

function decodeRunTask(wire: WireRunTaskInput): RunTaskInput {
  return {
    task: wire.task,
    variables: wire.variables ?? {},
    materials: decodeTaskMaterials(wire.materials),
    ...(wire.model === undefined ? {} : { model: wire.model }),
    ...(wire.parameters === undefined ? {} : { parameters: wire.parameters }),
  };
}

export function taskOperations<
  App extends TaskOperationTarget,
>(): readonly AnyOperation<App>[] {
  return [
    defineOperation<App>()({
      id: taskOperationIds.list,
      description: "List registered tasks.",
      permission: standardPermission.read,
      input: emptySchema,
      output: z.array(
        z.strictObject({
          id: z.string(),
          title: z.string(),
          purpose: z.string(),
        }),
      ),
      mcp: { readOnlyHint: true, idempotentHint: true },
      http: [{ method: "GET", path: "/tasks" }],
      execute: (app, _input, context) => app.tasks.list(context.locale),
    }),
    defineOperation<App>()({
      id: taskOperationIds.describe,
      description:
        "Describe variables, output, requirements and templates of a task.",
      permission: standardPermission.read,
      input: taskIdSchema,
      output: taskDescriptionSchema,
      mcp: { readOnlyHint: true, idempotentHint: true },
      http: [{ method: "GET", path: "/tasks/:id", paramMap: { id: "task" } }],
      execute: (app, { task }, context) =>
        app.tasks.describe(task, context.locale),
    }),
    defineOperation<App>()({
      id: taskOperationIds.preview,
      description: "Compile the prompt and show planned media preparation.",
      permission: standardPermission.read,
      input: wirePreviewInputSchema,
      output: previewSchema,
      mcp: { readOnlyHint: true, idempotentHint: true },
      http: [
        {
          method: "POST",
          path: "/tasks/:id/preview",
          paramMap: { id: "task" },
          mergeParamsIntoBody: true,
        },
      ],
      execute: (app, wire, context) =>
        app.tasks.preview(decodeRunTask(wire), context.options),
    }),
    defineOperation<App>()({
      id: taskOperationIds.run,
      description: "Run a task on a group of materials; optionally save it.",
      permission: standardPermission.write,
      input: wireRunTaskSchema,
      output: wireResultSchema,
      http: [
        {
          method: "POST",
          path: "/tasks/:id/run",
          paramMap: { id: "task" },
          mergeParamsIntoBody: true,
        },
      ],
      present(output, app, context) {
        if (app.tasks.present) {
          return app.tasks.present(
            output.producer.name,
            output,
            context.locale,
          );
        }
        return JSON.stringify(output, null, 2);
      },
      async execute(app, wire, context) {
        return encodeTaskResult(
          await (wire.persist
            ? app.tasks.runAndSave(decodeRunTask(wire), context.options)
            : app.tasks.run(decodeRunTask(wire), context.options)),
        );
      },
    }),
    defineOperation<App>()({
      id: taskOperationIds.runMany,
      description: "Run independent requests in order, with item-level errors.",
      permission: standardPermission.write,
      input: z.strictObject({ inputs: z.array(wireRunTaskSchema) }),
      output: batchSchema,
      http: [{ method: "POST", path: "/tasks/run-many" }],
      async execute(app, { inputs }, context) {
        const outcomes = await app.tasks.runMany(
          inputs.map((wire) => ({
            ...decodeRunTask(wire),
            ...(wire.persist === undefined ? {} : { persist: wire.persist }),
          })),
          context.options,
        );
        return outcomes.map((outcome): WireBatchItemResult => {
          return outcome.ok
            ? {
                ok: true,
                result: encodeTaskResult(outcome.result),
              }
            : outcome;
        });
      },
    }),
    defineOperation<App>()({
      id: taskOperationIds.stream,
      description: "Stream progress, text and the final task result.",
      permission: standardPermission.write,
      kind: "stream",
      input: wireRunTaskSchema,
      output: wireResultSchema,
      mcp: { expose: false },
      http: [
        {
          method: "POST",
          path: "/tasks/:id/stream",
          paramMap: { id: "task" },
          mergeParamsIntoBody: true,
        },
      ],
      execute(app, wire, context) {
        return mapFlowResult(
          wire.persist
            ? app.tasks.streamAndSave(decodeRunTask(wire), context.options)
            : app.tasks.stream(decodeRunTask(wire), context.options),
          encodeTaskResult,
        );
      },
    }),
    defineOperation<App>()({
      id: promptOperationIds.read,
      description: "Read the active system and user templates.",
      permission: standardPermission.read,
      input: taskIdSchema,
      output: promptTemplatesSchema,
      mcp: { expose: false, readOnlyHint: true },
      http: [
        {
          method: "GET",
          path: "/tasks/:id/prompts",
          paramMap: { id: "task" },
        },
      ],
      execute: (app, { task }) => app.prompts.read(task),
    }),
    defineOperation<App>()({
      id: promptOperationIds.describe,
      description: "Describe prompt variables, output and template sources.",
      permission: standardPermission.read,
      input: taskIdSchema,
      output: promptDescriptionSchema,
      mcp: { expose: false, readOnlyHint: true },
      http: [
        {
          method: "GET",
          path: "/tasks/:id/prompts/describe",
          paramMap: { id: "task" },
        },
      ],
      execute: (app, { task }) => app.prompts.describe(task),
    }),
    defineOperation<App>()({
      id: promptOperationIds.diff,
      description: "Get builtin and instance override templates.",
      permission: standardPermission.read,
      input: taskIdSchema,
      output: z.array(promptDiffSchema),
      mcp: { expose: false, readOnlyHint: true },
      http: [
        {
          method: "GET",
          path: "/tasks/:id/prompts/diff",
          paramMap: { id: "task" },
        },
      ],
      execute: (app, { task }) => app.prompts.diff(task),
    }),
    defineOperation<App>()({
      id: promptOperationIds.setOverride,
      description: "Compile and save an instance template override.",
      permission: standardPermission.admin,
      input: taskIdSchema.extend({
        role: promptRoleSchema,
        template: z.string(),
      }),
      output: promptDescriptionSchema,
      mcp: { expose: false, destructiveHint: true },
      http: [
        {
          method: "POST",
          path: "/tasks/:id/prompts/override",
          paramMap: { id: "task" },
          mergeParamsIntoBody: true,
        },
      ],
      execute: (app, { task, role, template }) =>
        app.prompts.setOverride(task, { role, template }),
    }),
    defineOperation<App>()({
      id: promptOperationIds.reset,
      description: "Reset one or both templates to builtin values.",
      permission: standardPermission.admin,
      input: taskIdSchema.extend({ role: promptRoleSchema.optional() }),
      output: promptDescriptionSchema,
      mcp: { expose: false, destructiveHint: true },
      http: [
        {
          method: "POST",
          path: "/tasks/:id/prompts/reset",
          paramMap: { id: "task" },
          mergeParamsIntoBody: true,
        },
      ],
      execute: (app, { task, role }) => app.prompts.reset(task, role),
    }),
  ];
}
