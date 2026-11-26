import {
  appError,
  createFlow,
  parseJson,
  parseValue,
  type CallScope,
  type Json,
} from "@themelios/core";
import { createHash } from "node:crypto";
import { createNetwork, type Network } from "@themelios/runtime/network";
import { createSecrets } from "@themelios/runtime/secrets";
import {
  modelConfigurationIssues,
  modelConfigurationSchema,
  type ModelConfiguration,
  type ModelConfigurationInput,
} from "./configuration.js";
import {
  prepareGeneration,
  prepareStreamingGeneration,
  providerOutputSchema,
  validateGeneration,
} from "./generation.js";
import { ModelCalls, queuedStream } from "./model-call.js";
import { ModelTelemetry } from "./model-telemetry.js";
import { embed, rank, transcript } from "./other-model-operations.js";
import { createPreparation, createPreparationEngine } from "./preparation.js";
import { createPrompts } from "./prompts.js";
import {
  type BoundModel,
  type OpenAiEndpoint,
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
  mimePatternSchema,
  modelParametersSchema,
} from "./schema.js";
import {
  defineTask,
  describeTask,
  mediaDescription,
  presentTask,
} from "./task-definition.js";
import { createTasks } from "./task-execution.js";
import type {
  GenerationCallOptions,
  GenerateRequest,
  Models,
  ModelsOptions,
  Tasks,
} from "./types.js";

export * from "./types.js";
export { speechTranscriptionRecipe } from "./representation-route.js";
export {
  modelConfigurationIssues,
  modelConfigurationSchema,
  type ModelConfiguration,
  type ModelConfigurationInput,
};
export {
  previewSchema,
  promptDescriptionSchema,
  promptDiffSchema,
  promptRoleSchema,
  promptTemplatesSchema,
  sourceDirectoryFromInputs,
  taskDescriptionSchema,
  taskRepresentationSchema,
  taskRequirementsSchema,
  taskRouteSchema,
  textOutput,
} from "./schema.js";
export {
  connectionSchema,
  modelBindingSchema,
  modelDefaultsSchema,
  modelNameSchema,
  modelParametersSchema,
  mimePatternSchema,
  providerOutputSchema,
  createPreparation,
  createPrompts,
  defineTask,
  describeTask,
  mediaDescription,
  presentTask,
};

export function createModels(
  config: ModelConfigurationInput,
  options: ModelsOptions = {},
): Models {
  const configuration = parseValue(
    modelConfigurationSchema,
    config,
    "config.invalid",
  );
  const issues = modelConfigurationIssues(configuration);
  if (issues.length)
    throw appError("config.invalid", {
      details: { issues: parseJson(issues) },
    });
  const bound = bindModels(configuration);
  const { timeoutMs, maxAttempts, concurrency } = configuration;
  const defaults = Object.freeze({ timeoutMs, maxAttempts, concurrency });
  const calls = new ModelCalls(defaults, options.diagnostics);
  let network: Promise<Network> | undefined;
  const fetch: Network["fetch"] =
    options.fetch ??
    (async (request) => {
      const delegate = await (network ??= createNetwork());
      return delegate.fetch(request);
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
    api?: OpenAiEndpoint,
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
  const routes = configuration.tasks;
  const configuredRoute = (id: string) =>
    Object.hasOwn(routes, id) ? routes[id] : undefined;
  const taskRoute = (id: string) =>
    configuredRoute(id) ??
    (soleBinding === undefined ? undefined : { model: soleBinding });

  function taskExecutor() {
    const prompts =
      options.prompts ??
      createPrompts(
        options.resourceRoot === undefined
          ? {}
          : { resourceRoot: options.resourceRoot },
      );
    const preparation = createPreparationEngine(
      {
        ...options.preparation,
        ...(options.adapters === undefined
          ? {}
          : { adapters: options.adapters }),
      },
      { models, prompts, taskRoute },
    );
    return createTasks({
      models,
      prompts,
      preparation,
      taskRoute,
      defaults,
      ...(options.diagnostics === undefined
        ? {}
        : { diagnostics: options.diagnostics }),
    });
  }

  const models: Models = {
    get tasks() {
      return (defaultTasks ??= taskExecutor());
    },
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
      const generate = prepareGeneration(model, request);
      const attempts = attemptsFor(callOptions);
      return calls.run(
        "models.generate",
        model.identity,
        callOptions,
        (call) => {
          const telemetry = observe(model);
          return generate(call, attempts, telemetry, (api) =>
            language(model, call, telemetry, api),
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
            generate: prepareStreamingGeneration(model, request),
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
          const { model, generate, attempts } = captured;
          const telemetry = observe(model);
          return yield* queuedStream(calls, call, model.identity, () =>
            generate(call, attempts, telemetry, (api) =>
              language(model, call, telemetry, api),
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
  connections,
  bindings,
}: ModelConfiguration): ReadonlyMap<string, BoundModel> {
  const bound = new Map<string, BoundModel>();
  for (const [binding, attributes] of Object.entries(bindings)) {
    const key = attributes.connection;
    const connection = connections[key]!;
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
