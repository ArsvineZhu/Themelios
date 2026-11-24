import {
  AppError,
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
import type { Diagnostics } from "@themelios/runtime/diagnostics";
import PQueue from "p-queue";
import { providerOutputSchema } from "./generation.js";
import { mergeModelParameters } from "./providers.js";
import {
  createSourceDirectory,
  outputSchema,
  sourceEntrySchema,
  sourcesJsonSchema,
} from "./schema.js";
import { inputVariables, messagesWithParts } from "./task-definition.js";
import type {
  CompiledPrompt,
  Generated,
  GenerateRequest,
  ModelPart,
  ModelParameters,
  GenerationCallOptions,
  Models,
  Preparation,
  PreparedInput,
  Preview,
  Prompts,
  TaskDefinition,
  TaskItemResult,
  TaskRequest,
  TaskRoute,
  Tasks,
} from "./types.js";

export * from "./types.js";
export { createSourceDirectory, sourceEntrySchema, sourcesJsonSchema };
export { createPreparation } from "./preparation.js";
export {
  defineTask,
  describeTask,
  inputVariables,
  mediaDescription,
  taskExampleSourceSchema,
  taskInputJsonSchema,
  taskRequirementsSchema,
} from "./task-definition.js";

export interface TaskExecutionOptions {
  readonly models: Models;
  readonly prompts: Prompts;
  readonly preparation: Preparation;
  readonly routes: Readonly<Record<string, TaskRoute>>;
  readonly diagnostics?: Diagnostics;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
}

const fallbackErrors = new Set([
  "model.rate_limited",
  "model.unavailable",
  "network.failed",
  "network.timeout",
]);

function fallbackProgress(
  error: unknown,
  call: CallScope,
  completed: number,
  total: number,
  visible = false,
) {
  call.throwIfAborted();
  if (
    visible ||
    completed >= total ||
    !(error instanceof AppError) ||
    !error.retryable ||
    !fallbackErrors.has(error.code)
  )
    throw error;
  return { stage: "model-fallback", completed, total, unit: "bindings" };
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

  function candidates(id: string, override?: string): readonly string[] {
    if (override !== undefined) return [override];
    const route = Object.hasOwn(routes, id) ? routes[id] : undefined;
    if (!route)
      throw appError("model.binding_not_found", { details: { binding: id } });
    return [...new Set([route.model, ...(route.fallback ?? [])])];
  }
  const budget = (task: string, options?: CallOptions): CallOptions => ({
    timeoutMs: routes[task]?.timeoutMs ?? resources.timeoutMs ?? 120_000,
    ...options,
  });

  function generationBudget(
    call: CallScope,
    taskBudget: Pick<TaskRoute, "timeoutMs" | "maxAttempts">,
    options?: CallOptions,
  ): GenerationCallOptions {
    const { timeoutMs, maxAttempts } = taskBudget;
    return {
      signal: call.signal,
      ...(timeoutMs === undefined && options?.timeoutMs === undefined
        ? {}
        : { timeoutMs: call.remainingMs() }),
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
    };
  }

  function generationRequest<O extends Json>(
    route: Pick<TaskRoute, "model" | "parameters">,
    output: GenerateRequest<O>["output"],
    prompt: CompiledPrompt,
    parts: readonly ModelPart[],
    override?: ModelParameters,
  ): GenerateRequest<O> {
    const parameters = mergeModelParameters(route.parameters, override);
    return {
      model: route.model,
      messages: messagesWithParts(prompt, parts),
      output,
      ...(parameters === undefined ? {} : { parameters }),
    };
  }

  async function prepare<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
    request: TaskRequest<RawI>,
    call: CallScope,
    model: string,
  ) {
    call.throwIfAborted("input");
    const route = modelFor(task.id, model);
    const variables = inputVariables(task, request.variables, route.variables);
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
      route,
      request: generationRequest(
        route,
        task.output,
        prompt,
        prepared.parts,
        request.parameters,
      ),
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
      const modelsToTry = candidates(task.id, request.model);
      const fixed = modelsToTry.length > 1 ? structuredClone(request) : request;
      const call = openCall(task.id, budget(task.id, options));
      try {
        for (const [index, model] of modelsToTry.entries()) {
          const prepared = await prepare(task, fixed, call, model);
          try {
            const generated = await models.generate(prepared.request, {
              ...generationBudget(call, prepared.route, options),
              onProgress: (update) => call.progress(update),
            });
            return complete(
              task,
              prepared.prepared,
              prepared.variables,
              prepared.prompt,
              generated,
            );
          } catch (cause) {
            call.progress(
              fallbackProgress(cause, call, index + 1, modelsToTry.length),
            );
          }
        }
        throw appError("model.incomplete", { details: { task: task.id } });
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
          const modelsToTry = candidates(task.id, fixed.model);
          for (const [index, model] of modelsToTry.entries()) {
            const prepared = await prepare(task, fixed, call, model);
            let visibleOutput = false;
            try {
              const generated = models.stream(
                prepared.request,
                generationBudget(call, prepared.route, options),
              );
              for await (const event of generated) {
                if (event.type === "result")
                  return complete(
                    task,
                    prepared.prepared,
                    prepared.variables,
                    prepared.prompt,
                    event.value,
                  );
                if (event.type === "text-delta" && event.text.length)
                  visibleOutput = true;
                yield event;
              }
              throw appError("model.incomplete", {
                details: { binding: model },
              });
            } catch (cause) {
              yield {
                type: "progress",
                progress: fallbackProgress(
                  cause,
                  call,
                  index + 1,
                  modelsToTry.length,
                  visibleOutput,
                ),
              };
            }
          }
          throw appError("model.incomplete", { details: { task: task.id } });
        },
        budget(task.id, options),
      );
    },
    async runMany<I extends Json, O extends Json, RawI>(
      task: TaskDefinition<I, O, RawI>,
      requests: readonly TaskRequest<RawI>[],
      options?: CallOptions,
    ): Promise<readonly TaskItemResult<O>[]> {
      const scope = openCall(task.id + ".many", budget(task.id, options));
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
      const call = openCall(task.id + ".preview", budget(task.id, options));
      try {
        call.throwIfAborted("input");
        const route = modelFor(task.id, request.model);
        const variables = inputVariables(
          task,
          request.variables,
          route.variables,
        );
        const { capabilities } = route;
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
        const generation = generationRequest(
          route,
          task.output,
          prompt,
          plan.readyParts,
          request.parameters,
        );
        if (!plan.pending.length) models.validateGeneration(generation);
        const messages = generation.messages.map((message) => ({
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
        }));
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
