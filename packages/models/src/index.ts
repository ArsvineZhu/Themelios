import {
  appError,
  createFlow,
  parseValue,
  type CallOptions,
  type CallScope,
  type Json,
} from "@themelios/core";
import { createNetwork, type Network } from "@themelios/runtime/network";
import { createSecrets } from "@themelios/runtime/secrets";
import { z } from "zod";
import type {
  FetchFunction,
  GenerateRequest,
  Models,
  ModelsOptions,
} from "./contracts.js";
import {
  generate,
  prepareGeneration,
  providerOutputSchema,
  streamGeneration,
} from "./generation.js";
import { ModelCalls, queuedStream } from "./model-call.js";
import { ModelTelemetry } from "./model-telemetry.js";
import { embed, rank, transcript } from "./other-model-operations.js";
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
  modelDefaultsSchema,
  modelNameSchema,
} from "./schema.js";

export type {
  Connection,
  EmbedRequest,
  Embedded,
  EmbeddingSpace,
  FetchFunction,
  GenerateRequest,
  Generated,
  ModalityNeed,
  ModelBinding,
  ModelCapabilities,
  ModelIdentity,
  ModelMessage,
  ModelNotice,
  ModelOperation,
  ModelParameters,
  ModelPart,
  Models,
  ModelsOptions,
  RankRequest,
  Ranked,
  Transcript,
  TranscribeRequest,
  Usage,
} from "./contracts.js";
export {
  connectionSchema,
  modelBindingSchema,
  modelDefaultsSchema,
  modelNameSchema,
  modelParametersSchema,
  matchesMime,
  mimePatternSchema,
} from "./schema.js";
export { providerOutputSchema };

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
  let closing: Promise<void> | undefined;
  return {
    describe,
    async generate<O extends Json>(
      request: GenerateRequest<O>,
      options?: CallOptions,
    ) {
      calls.assertOpen();
      const model = binding(request.model);
      const prepared = prepareGeneration(model, request);
      return calls.run("models.generate", model.identity, options, (call) => {
        const telemetry = observe(model);
        return generate(
          prepared,
          call,
          model.identity,
          calls.attempts,
          telemetry,
          () => language(model, call, telemetry, prepared.openaiApi),
        );
      });
    },
    stream<O extends Json>(request: GenerateRequest<O>, options?: CallOptions) {
      const captured = (() => {
        try {
          const model = binding(request.model);
          return { model, prepared: prepareGeneration(model, request, true) };
        } catch (error) {
          return { error };
        }
      })();
      return createFlow(
        "models.stream",
        async function* (call) {
          if ("error" in captured) throw captured.error;
          const { model, prepared } = captured;
          const telemetry = observe(model);
          return yield* queuedStream(calls, call, model.identity, () =>
            streamGeneration(
              prepared,
              call,
              model.identity,
              calls.attempts,
              telemetry,
              () => language(model, call, telemetry, prepared.openaiApi),
            ),
          );
        },
        calls.options(options),
      );
    },
    async embed(request, options) {
      const model = binding(request.model);
      checkOperation(model, "embed");
      const map = new WeakMap<Uint8Array, Uint8Array>();
      const fixed = {
        ...request,
        inputs: request.inputs.map((input) => captureParts(input, map)),
      };
      return calls.run("models.embed", model.identity, options, (call) => {
        const telemetry = observe(model);
        return embed(model, fixed, call, calls.attempts, telemetry, () =>
          client(model, call, telemetry),
        );
      });
    },
    async rank(request, options) {
      const model = binding(request.model);
      checkOperation(model, "rank");
      const fixed = { ...request, documents: [...request.documents] };
      return calls.run("models.rank", model.identity, options, (call) => {
        const telemetry = observe(model);
        return rank(model, fixed, call, calls.attempts, telemetry, () =>
          client(model, call, telemetry),
        );
      });
    },
    async transcribe(request, options) {
      const model = binding(request.model);
      checkOperation(model, "transcribe");
      const fixed = {
        ...request,
        audio: { ...request.audio, bytes: new Uint8Array(request.audio.bytes) },
      };
      return calls.run("models.transcribe", model.identity, options, (call) => {
        const telemetry = observe(model);
        return transcript(model, fixed, call, calls.attempts, telemetry, () =>
          client(model, call, telemetry),
        );
      });
    },
    close() {
      return (closing ??= (async () => {
        await calls.close();
        if (network) await (await network.catch(() => undefined))?.close();
      })());
    },
  };
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
