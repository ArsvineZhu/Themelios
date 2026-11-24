import {
  appError,
  createFlow,
  parseValue,
  type CallOptions,
  type CallScope,
  type Completed,
  type Json,
} from "@themelios/core";
import { createHash } from "node:crypto";
import { createNetwork, type Network } from "@themelios/runtime/network";
import { createSecrets } from "@themelios/runtime/secrets";
import { z } from "zod";
import {
  generate,
  prepareGeneration,
  providerOutputSchema,
  streamGeneration,
  validateGeneration,
} from "./generation.js";
import { ModelCalls, queuedStream } from "./model-call.js";
import { ModelTelemetry } from "./model-telemetry.js";
import { embed, rank, transcript } from "./other-model-operations.js";
import { createPreparation } from "./preparation.js";
import { createPrompts } from "./prompts.js";
import {
  type BoundModel,
  captureParts,
  checkOperation,
  createProvider,
  requireCapability,
} from "./providers.js";
import {
  connectionSchema,
  modelBindingSchema,
  modelAttemptsSchema,
  modelDefaultsSchema,
  modelNameSchema,
  matchesMime,
  mimePatternSchema,
  modelParametersSchema,
} from "./schema.js";
import {
  createTasks,
  defineTask,
  describeTask,
  mediaDescription,
} from "./tasks.js";
import type {
  FetchFunction,
  GenerationCallOptions,
  GenerateRequest,
  Models,
  ModelsOptions,
  TaskDefinition,
  TaskRequest,
  Tasks,
} from "./types.js";

export * from "./types.js";
export { taskRouteSchema } from "./schema.js";
export {
  connectionSchema,
  modelBindingSchema,
  modelDefaultsSchema,
  modelNameSchema,
  modelParametersSchema,
  matchesMime,
  mimePatternSchema,
  providerOutputSchema,
  createPreparation,
  createPrompts,
  createTasks,
  defineTask,
  describeTask,
  mediaDescription,
};

export function createModels(options: ModelsOptions): Models {
  const bound = bindModels(options);
  const defaults = parseValue(
    modelDefaultsSchema,
    options.defaults ?? {},
    "config.invalid",
  );
  const calls = new ModelCalls(defaults, options.diagnostics);
  let network: Promise<Network> | undefined;
  const fetch: FetchFunction =
    options.fetch ??
    (async (input, init) => {
      const delegate = await (network ??= createNetwork());
      return delegate.fetch(input, init);
    });
  const resolveCredential =
    options.resolveCredential ??
    createSecrets({ baseDir: process.cwd() }).resolve;
  function binding(name: string): BoundModel {
    const model = bound.get(name);
    if (!model)
      throw appError("model.binding_not_found", { details: { binding: name } });
    return model;
  }
  const describe = (name: string) => structuredClone(binding(name).binding);
  const client = (
    model: BoundModel,
    call: CallScope,
    telemetry: ModelTelemetry,
  ) => createProvider(model, call, fetch, resolveCredential, telemetry);
  const language = async (
    model: BoundModel,
    call: CallScope,
    telemetry: ModelTelemetry,
    api?: "chat" | "responses",
  ) =>
    (await client(model, call, telemetry)).language?.(
      model.identity.providerModel,
      api,
    ) ?? requireCapability(model, "generate");
  const observe = (model: BoundModel) =>
    new ModelTelemetry(model.identity, options.diagnostics);
  const attemptsFor = (options?: GenerationCallOptions) =>
    options?.maxAttempts === undefined
      ? calls.attempts
      : parseValue(modelAttemptsSchema, options.maxAttempts, "input.invalid");
  let closing: Promise<void> | undefined;
  let defaultTasks: Tasks | undefined;
  const soleBinding = bound.size === 1 ? bound.keys().next().value : undefined;
  const routes = options.routes ?? {};

  function taskExecutor() {
    const prompts =
      options.prompts ??
      createPrompts(
        options.resourceRoot === undefined
          ? {}
          : { resourceRoot: options.resourceRoot },
      );
    const mediaDescriptionDefaults = routes["media.describe"]?.variables;
    const preparation =
      options.preparation ??
      createPreparation({
        models,
        prompts,
        ...(mediaDescriptionDefaults === undefined
          ? {}
          : { mediaDescriptionDefaults }),
        ...(options.adapters === undefined
          ? {}
          : { adapters: options.adapters }),
      });
    return createTasks({
      models,
      prompts,
      preparation,
      routes,
      ...(options.diagnostics === undefined
        ? {}
        : { diagnostics: options.diagnostics }),
    });
  }

  const models: Models = {
    describe,
    validateGeneration(request) {
      calls.assertOpen();
      validateGeneration(binding(request.model), request);
    },
    fingerprint(name) {
      const { binding: configured, connection } = binding(name);
      return createHash("sha256")
        .update(JSON.stringify({ binding: configured, connection }))
        .digest("hex");
    },
    async generate<O extends Json>(
      request: GenerateRequest<O>,
      callOptions?: GenerationCallOptions,
    ) {
      calls.assertOpen();
      const model = binding(request.model);
      const prepared = prepareGeneration(model, request);
      const attempts = attemptsFor(callOptions);
      return calls.run(
        "models.generate",
        model.identity,
        callOptions,
        (call) => {
          const telemetry = observe(model);
          return generate(
            prepared,
            call,
            model.identity,
            attempts,
            telemetry,
            () => language(model, call, telemetry, prepared.openaiApi),
          );
        },
      );
    },
    stream<O extends Json>(
      request: GenerateRequest<O>,
      callOptions?: GenerationCallOptions,
    ) {
      const captured = (() => {
        try {
          const model = binding(request.model);
          return {
            model,
            prepared: prepareGeneration(model, request, true),
            attempts: attemptsFor(callOptions),
          };
        } catch (error) {
          return { error };
        }
      })();
      return createFlow(
        "models.stream",
        async function* (call) {
          if ("error" in captured) throw captured.error;
          const { model, prepared, attempts } = captured;
          const telemetry = observe(model);
          return yield* queuedStream(calls, call, model.identity, () =>
            streamGeneration(
              prepared,
              call,
              model.identity,
              attempts,
              telemetry,
              () => language(model, call, telemetry, prepared.openaiApi),
            ),
          );
        },
        calls.options(callOptions),
      );
    },
    async embed(request, callOptions) {
      const model = binding(request.model);
      checkOperation(model, "embed");
      const map = new WeakMap<Uint8Array, Uint8Array>();
      const fixed = {
        ...request,
        inputs: request.inputs.map((input) => captureParts(input, map)),
      };
      return calls.run("models.embed", model.identity, callOptions, (call) => {
        const telemetry = observe(model);
        return embed(model, fixed, call, calls.attempts, telemetry, () =>
          client(model, call, telemetry),
        );
      });
    },
    async rank(request, callOptions) {
      const model = binding(request.model);
      checkOperation(model, "rank");
      const fixed = { ...request, documents: [...request.documents] };
      return calls.run("models.rank", model.identity, callOptions, (call) => {
        const telemetry = observe(model);
        return rank(model, fixed, call, calls.attempts, telemetry, () =>
          client(model, call, telemetry),
        );
      });
    },
    async transcribe(request, callOptions) {
      const model = binding(request.model);
      checkOperation(model, "transcribe");
      const fixed = {
        ...request,
        audio: { ...request.audio, bytes: new Uint8Array(request.audio.bytes) },
      };
      return calls.run(
        "models.transcribe",
        model.identity,
        callOptions,
        (call) => {
          const telemetry = observe(model);
          return transcript(model, fixed, call, calls.attempts, telemetry, () =>
            client(model, call, telemetry),
          );
        },
      );
    },
    runTask<I extends Json, O extends Json, RawI>(
      task: TaskDefinition<I, O, RawI>,
      request: TaskRequest<RawI>,
      callOptions?: CallOptions,
    ): Promise<Completed<O>> {
      const selected =
        request.model === undefined &&
        !Object.hasOwn(routes, task.id) &&
        soleBinding !== undefined
          ? { ...request, model: soleBinding }
          : request;
      return (defaultTasks ??= taskExecutor()).run(task, selected, callOptions);
    },
    close() {
      return (closing ??= (async () => {
        await calls.close();
        if (network) await (await network.catch(() => undefined))?.close();
      })());
    },
  };
  return models;
}

function bindModels({
  connections: rawConnections,
  bindings,
}: ModelsOptions): ReadonlyMap<string, BoundModel> {
  const connections = parseValue(
    z.record(modelNameSchema, connectionSchema),
    rawConnections,
    "config.invalid",
  );
  const configured = parseValue(
    z.record(modelNameSchema, modelBindingSchema),
    bindings,
    "config.invalid",
  );
  const bound = new Map<string, BoundModel>();
  for (const [binding, attributes] of Object.entries(configured)) {
    const key = attributes.connection;
    const connection = Object.hasOwn(connections, key)
      ? connections[key]
      : undefined;
    if (
      !connection ||
      (attributes.capabilities.operations.includes("embed") &&
        !attributes.embeddingSpace)
    ) {
      throw appError("config.invalid", {
        details: {
          issues: [
            {
              path:
                "models.bindings." +
                binding +
                (connection ? ".embeddingSpace" : ".connection"),
              messageKey: connection
                ? "model.embedding_space_required"
                : "model.connection_not_found",
            },
          ],
        },
      });
    }
    bound.set(binding, {
      binding: structuredClone(attributes),
      connection: structuredClone(connection),
      identity: {
        binding,
        connection: key,
        providerModel: attributes.providerModel,
      },
    });
  }
  return bound;
}
export { z } from "zod";
