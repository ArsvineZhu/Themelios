import {
  appError,
  createFlow,
  type CallOptions,
  type CallScope,
  type Completed,
  type Json,
  openCall,
  parseJson,
  toErrorInfo,
} from "@themelios/core";
import {
  providerOutputSchema,
  type Generated,
  type ModelMessage,
  type ModelPart,
  type Models,
} from "@themelios/models";
import type { CompiledPrompt, Prompts } from "@themelios/models/prompts";
import {
  inputVariables,
  type PreparedInput,
  type Preview,
  type TaskDefinition,
  type TaskItemResult,
  type TaskRequest,
  type Tasks,
} from "@themelios/models/tasks";
import type { Preparation } from "./input-contracts.js";
import type { TaskRoute } from "./task-route.js";
import PQueue from "p-queue";
import { z } from "zod";

export type { TaskRoute } from "./task-route.js";
export { mediaDescription } from "./media-description.js";

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
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  /** Wire entry points reserve space for the actual prepared inputs before starting the final model request. */
  readonly reserveResult?: (prepared: Completed) => number;
}

export function createTasks(resources: TaskExecutionOptions): Tasks {
  const { models, prompts, preparation, routes } = resources;
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
    const prepared = await preparation.forModel(
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
    );
    const prompt = await prompts.compile(task, variables, prepared.sources);
    call.throwIfAborted("prompt");
    const estimate = resources.reserveResult?.({
      value: null,
      inputs: prepared.uses,
      files: [],
      producer: {
        kind: "model",
        name: task.id,
        details: parseJson({
          binding: route.model,
          providerModel: models.describe(route.model).providerModel,
          prompts: prompt.files.map((file) => ({
            role: file.role,
            source: file.source,
          })),
          ...(task.output === "text"
            ? {}
            : { schema: providerOutputSchema(task.output) }),
        }),
      },
    });
    return {
      prepared,
      prompt,
      variables,
      estimate,
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
  const tasks: Tasks = {
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
      // Preserve the call's chosen bytes and variables even if the consumer starts later.
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
            if (
              event.type === "text-delta" &&
              prepared.estimate !== undefined
            ) {
              bytes += Buffer.byteLength(event.text);
              if (bytes > prepared.estimate)
                throw appError("transport.result_too_large", {
                  details: {
                    outputBytes: bytes,
                    availableOutputBytes: prepared.estimate,
                    solution: "Use a Selection and persist the result",
                  },
                });
            }
            yield event;
          }
          throw appError("model.incomplete", {
            details: { binding: prepared.request.model, stage: "stream" },
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
      const call = openCall(task.id + ".runMany", budget(options));
      const queue = new PQueue({ concurrency: resources.concurrency ?? 4 });
      try {
        const fixed = structuredClone(requests);
        return await Promise.all(
          fixed.map((request) =>
            queue.add(async (): Promise<TaskItemResult<O>> => {
              try {
                call.throwIfAborted("queue");
                return {
                  ok: true,
                  result: await tasks.run(task, request, {
                    signal: call.signal,
                  }),
                };
              } catch (error) {
                return { ok: false, error: toErrorInfo(error) };
              }
            }),
          ),
        );
      } finally {
        call.close();
      }
    },
    async preview(task, request, options) {
      const call = openCall(task.id + ".preview", budget(options));
      try {
        const variables = inputVariables(task, request.variables);
        const route = modelFor(task.id, request.model);
        const planned = await preparation.plan(
          request.materials,
          task.requirements,
          route.capabilities,
          {
            signal: call.signal,
            ...(route.preparation === undefined
              ? {}
              : { preparation: route.preparation }),
          },
        );
        const prompt = await prompts.compile(task, variables, planned.sources);
        const messages: Preview["messages"] = messagesWithParts(
          prompt,
          planned.readyParts,
        ).map(({ role, parts }) => ({
          role,
          parts: parts.map((part) =>
            part.kind === "text"
              ? part
              : {
                  kind: "media",
                  mediaType: part.mediaType,
                  sizeBytes: part.bytes.byteLength,
                  ...(part.name === undefined ? {} : { name: part.name }),
                },
          ),
        }));
        return {
          model: route.model,
          messages,
          sources: planned.sources,
          pending: planned.pending,
          ...(task.output === "text"
            ? {}
            : {
                taskSchema: parseJson(z.toJSONSchema(task.output)),
                sentSchema: providerOutputSchema(task.output),
              }),
        };
      } finally {
        call.close();
      }
    },
  };
  return tasks;
}
