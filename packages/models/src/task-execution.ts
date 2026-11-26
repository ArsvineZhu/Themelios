import {
  AppError,
  appError,
  createFlow,
  type CallOptions,
  type CallScope,
  type Completed,
  type Json,
  type Producer,
  type StreamUpdate,
  openCall,
  parseJson,
  toErrorInfo,
} from "@themelios/core";
import type { Diagnostics } from "@themelios/runtime/diagnostics";
import PQueue from "p-queue";
import { providerOutputSchema } from "./generation.js";
import { mergeModelParameters } from "./providers.js";
import { outputSchema } from "./schema.js";
import { inputVariables, messagesWithParts } from "./task-definition.js";
import type {
  CompiledPrompt,
  Generated,
  GenerateRequest,
  ModelPart,
  ModelParameters,
  ModelDefaults,
  GenerationCallOptions,
  Models,
  Preparation,
  PreparedInput,
  Preview,
  Prompts,
  SourceEntries,
  TaskDefinition,
  TaskItemResult,
  TaskRequest,
  TaskRoute,
  Tasks,
} from "./types.js";

interface TaskExecutionOptions {
  readonly models: Models;
  readonly prompts: Prompts;
  readonly preparation: Preparation;
  readonly taskRoute: (taskId: string) => TaskRoute | undefined;
  readonly defaults: ModelDefaults;
  readonly diagnostics?: Diagnostics;
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

interface TaskInvocation<I extends Json> {
  readonly route: TaskRoute | undefined;
  readonly bindings: readonly string[];
  readonly variables: I;
  readonly materials: TaskRequest<Json>["materials"];
  readonly parameters: ModelParameters | undefined;
}

export function taskGenerationInputs<I extends Json, O extends Json, RawI>(
  task: TaskDefinition<I, O, RawI>,
  request: Pick<TaskRequest<RawI>, "variables" | "parameters">,
  route: TaskRoute | undefined,
) {
  return {
    variables: inputVariables(task, request.variables, route?.variables),
    parameters: mergeModelParameters(route?.parameters, request.parameters),
  };
}

function taskInvocation<I extends Json, O extends Json, RawI>(
  task: TaskDefinition<I, O, RawI>,
  request: TaskRequest<RawI>,
  route: TaskRoute | undefined,
): TaskInvocation<I> {
  const model = request.model ?? route?.model;
  if (!model)
    throw appError("model.binding_not_found", {
      details: { binding: task.id },
    });
  return {
    route,
    bindings:
      request.model === undefined
        ? [...new Set([model, ...(route?.fallback ?? [])])]
        : [model],
    materials: request.materials,
    ...taskGenerationInputs(task, request, route),
  };
}

export function taskGenerationOptions(
  route: TaskRoute | undefined,
  options: CallOptions,
): GenerationCallOptions {
  const timeoutMs = options.timeoutMs ?? route?.timeoutMs;
  return {
    ...options,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(route?.maxAttempts === undefined
      ? {}
      : { maxAttempts: route.maxAttempts }),
  };
}

export function taskGenerationRequest<O extends Json>(
  model: string,
  output: GenerateRequest<O>["output"],
  prompt: CompiledPrompt,
  parts: readonly ModelPart[],
  parameters?: ModelParameters,
): GenerateRequest<O> {
  return {
    model,
    messages: messagesWithParts(prompt, parts),
    output,
    ...(parameters === undefined ? {} : { parameters }),
  };
}

export function taskProducer<O extends Json>(
  taskId: string,
  output: GenerateRequest<O>["output"],
  prompt: CompiledPrompt,
  generated: Generated<O>,
): Producer {
  return {
    kind: "model",
    name: taskId,
    details: parseJson({
      ...generated.model,
      ...(generated.usage === undefined ? {} : { usage: generated.usage }),
      prompts: prompt.files.map(({ role, source }) => ({ role, source })),
      ...(output.kind === "text"
        ? {}
        : { schema: providerOutputSchema(output.schema) }),
    }),
  };
}

export function createTasks(resources: TaskExecutionOptions): Tasks {
  const { models, prompts, preparation, diagnostics, taskRoute, defaults } =
    resources;
  const runSpan = <T>(name: string, work: () => Promise<T>): Promise<T> =>
    diagnostics ? diagnostics.span(name, work) : work();
  const timeoutMs = (id?: string) =>
    (id === undefined ? undefined : taskRoute(id)?.timeoutMs) ??
    defaults.timeoutMs;
  const budget = (id: string, options?: CallOptions): CallOptions => ({
    ...options,
    timeoutMs: options?.timeoutMs ?? timeoutMs(id),
  });

  function attempt<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
    work: TaskInvocation<I>,
    model: string,
    call: CallScope,
  ) {
    call.throwIfAborted("input");
    const inputArgs = [
      work.materials,
      task.requirements,
      models.describe(model).capabilities,
      {
        signal: call.signal,
        ...(work.route?.preparation === undefined
          ? {}
          : { preparation: work.route.preparation }),
        onProgress: call.progress,
      },
    ] as const;
    async function compile(input: {
      readonly sources: SourceEntries;
      readonly parts: readonly ModelPart[];
    }) {
      const prompt = await runSpan("prompt.render", () =>
        prompts.compile(task, work.variables, input.sources),
      );
      call.throwIfAborted("prompt");
      const request = taskGenerationRequest(
        model,
        task.output,
        prompt,
        input.parts,
        work.parameters,
      );
      return { request, prompt };
    }
    return { inputArgs, compile };
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
      producer: taskProducer(task.id, task.output, prompt, generated),
    };
  }

  async function* generateAttempt<O extends Json>(
    request: GenerateRequest<O>,
    options: GenerationCallOptions,
    stream: boolean,
    markOutput: () => void,
  ): AsyncGenerator<StreamUpdate, Generated<O>> {
    if (!stream) return models.generate(request, options);
    for await (const event of models.stream(request, options)) {
      if (event.type === "result") return event.value;
      if (event.type === "text-delta" && event.text.length) markOutput();
      yield event;
    }
    throw appError("model.incomplete", { details: { binding: request.model } });
  }

  function execute<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
    request: TaskRequest<RawI>,
    stream: boolean,
    options?: CallOptions,
  ) {
    parseJson(request.variables);
    const snapshot = structuredClone(request);
    return createFlow(
      task.id,
      async function* (call) {
        if (stream)
          yield { type: "progress", progress: { stage: "prepare" } } as const;
        const work = taskInvocation(task, snapshot, taskRoute(task.id));
        for (const [index, model] of work.bindings.entries()) {
          const { inputArgs, compile } = attempt(task, work, model, call);
          const prepared = await runSpan("input.prepare", () =>
            preparation.prepare(...inputArgs),
          );
          const { request, prompt } = await compile(prepared);
          const generation = taskGenerationOptions(work.route, {
            signal: call.signal,
            ...(stream ? {} : { onProgress: call.progress }),
            timeoutMs: call.remainingMs(),
          });
          let generated: Generated<O>;
          let outputStarted = false;
          try {
            generated = yield* generateAttempt(
              request,
              generation,
              stream,
              () => {
                outputStarted = true;
              },
            );
          } catch (error) {
            yield {
              type: "progress",
              progress: fallbackProgress(
                error,
                call,
                index + 1,
                work.bindings.length,
                outputStarted,
              ),
            } as const;
            continue;
          }
          return complete(task, prepared, work.variables, prompt, generated);
        }
        throw appError("model.incomplete", { details: { task: task.id } });
      },
      budget(task.id, options),
    );
  }

  async function run<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
    request: TaskRequest<RawI>,
    options?: CallOptions,
  ): Promise<Completed<O>> {
    for await (const event of execute(task, request, false, options))
      if (event.type === "result") return event.value;
    throw appError("model.incomplete", { details: { task: task.id } });
  }

  return {
    concurrency: defaults.concurrency,
    timeoutMs,
    run,
    stream(task, request, options) {
      return execute(task, request, true, options);
    },
    async runMany<I extends Json, O extends Json, RawI>(
      task: TaskDefinition<I, O, RawI>,
      requests: readonly TaskRequest<RawI>[],
      options?: CallOptions,
    ): Promise<readonly TaskItemResult<O>[]> {
      const scope = openCall(task.id + ".many", budget(task.id, options));
      const queue = new PQueue({ concurrency: defaults.concurrency });
      try {
        return await Promise.all(
          requests.map((request) =>
            queue.add(
              async (): Promise<TaskItemResult<O>> => {
                try {
                  return {
                    ok: true,
                    result: await run(task, request, {
                      signal: scope.signal,
                      onProgress: scope.progress,
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
        parseJson(request.variables);
        const work = taskInvocation(
          task,
          structuredClone(request),
          taskRoute(task.id),
        );
        const model = work.bindings[0]!;
        const { inputArgs, compile } = attempt(task, work, model, call);
        const plan = await runSpan("input.plan", () =>
          preparation.preview(...inputArgs),
        );
        const { request: generation } = await compile({
          sources: plan.sources,
          parts: plan.readyParts,
        });
        if (!plan.pending.length) models.validateGeneration(generation);
        return {
          model,
          messages: generation.messages.map(({ role, parts }) => ({
            role,
            parts: parts.map((part) =>
              part.kind === "text"
                ? part
                : {
                    kind: "media" as const,
                    mediaType: part.mediaType,
                    sizeBytes: part.bytes.byteLength,
                    ...(part.name === undefined ? {} : { name: part.name }),
                  },
            ),
          })),
          sources: plan.sources,
          pending: plan.pending,
          ...(task.output.kind === "text"
            ? {}
            : {
                taskSchema: outputSchema(task.output.schema),
                sentSchema: providerOutputSchema(task.output.schema),
              }),
        } satisfies Preview;
      } finally {
        call.close();
      }
    },
  };
}
