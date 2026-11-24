import { createCohere } from "@ai-sdk/cohere";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { appError, type Json, type CallScope } from "@themelios/core";
import {
  wrapEmbeddingModel,
  type EmbeddingModel,
  type LanguageModel,
  type ModelMessage as SdkMessage,
  type RerankingModel,
  type TranscriptionModel,
} from "ai";
import type {
  Connection,
  FetchFunction,
  ModelBinding,
  ModelIdentity,
  ModelMessage,
  ModelOperation,
  ModelParameters,
  ModelPart,
  ModelsOptions,
} from "./types.js";
import { matchesMime } from "./schema.js";
import type { ModelTelemetry } from "./model-telemetry.js";

type ProviderOptions = Record<string, Record<string, Json>>;
type Protocol = Connection["protocol"];

const supported: Record<Protocol, readonly ModelOperation[]> = {
  "openai-compatible": ["generate", "embed"],
  openai: ["generate", "embed", "transcribe"],
  google: ["generate", "embed"],
  cohere: ["rank"],
};

export interface BoundModel {
  binding: ModelBinding;
  connection: Connection;
  identity: ModelIdentity;
}

export function requireCapability(model: BoundModel, required: string): never {
  throw appError("model.capability_missing", {
    details: { binding: model.identity.binding, required },
  });
}

export function checkOperation(
  model: BoundModel,
  operation: ModelOperation,
): void {
  if (
    !model.binding.capabilities.operations.includes(operation) ||
    !supported[model.connection.protocol].includes(operation)
  ) {
    requireCapability(model, operation);
  }
}

function adapterAccepts(
  protocol: Protocol,
  operation: ModelOperation,
  mediaType: string,
): boolean {
  if (operation === "transcribe") return mediaType.startsWith("audio/");
  if (mediaType === "text/plain") return true;
  if (operation === "embed") return protocol === "google";
  if (protocol === "openai-compatible") return mediaType.startsWith("image/");
  return operation === "generate";
}

/** Capture each external bytes object once in a call, even if it appears in several message parts. */
export function captureParts(
  parts: readonly ModelPart[],
  captured = new WeakMap<Uint8Array, Uint8Array>(),
): ModelPart[] {
  return parts.map((part) => {
    if (part.kind === "text") return { kind: "text", text: part.text };
    let bytes = captured.get(part.bytes);
    if (!bytes) {
      bytes = new Uint8Array(part.bytes);
      captured.set(part.bytes, bytes);
    }
    return { ...part, bytes };
  });
}

export function checkParts(
  model: BoundModel,
  operation: ModelOperation,
  parts: Iterable<ModelPart>,
): void {
  const { inputMimeTypes, limits } = model.binding.capabilities;
  let size = 0;
  let images = 0;
  for (const part of parts) {
    const mime = part.kind === "text" ? "text/plain" : part.mediaType;
    if (
      !inputMimeTypes.some((pattern) => matchesMime(pattern, mime)) ||
      !adapterAccepts(model.connection.protocol, operation, mime)
    )
      requireCapability(model, operation + ":" + mime);
    size +=
      part.kind === "text"
        ? Buffer.byteLength(part.text)
        : part.bytes.byteLength;
    if (mime.startsWith("image/")) images++;
  }
  if (limits?.maxInputBytes !== undefined && size > limits.maxInputBytes) {
    throw appError("model.input_too_large", {
      details: { actualBytes: size, maxBytes: limits.maxInputBytes },
    });
  }
  if (limits?.maxImages !== undefined && images > limits.maxImages) {
    throw appError("model.invalid_request", {
      details: {
        binding: model.identity.binding,
        issues: [
          {
            path: ["messages"],
            reason: "Image count exceeds " + limits.maxImages,
          },
        ],
      },
    });
  }
}

export function sdkMessages(messages: readonly ModelMessage[]): SdkMessage[] {
  return messages.map((message) => {
    if (message.role === "system") {
      const content = message.parts
        .map((part) => {
          if (part.kind !== "text")
            throw appError("model.invalid_request", {
              details: {
                issues: [
                  {
                    path: ["messages"],
                    reason: "System messages require text parts",
                  },
                ],
              },
            });
          return part.text;
        })
        .join("\n");
      return { role: "system", content };
    }
    const content = message.parts.map((part) =>
      part.kind === "text"
        ? { type: "text" as const, text: part.text }
        : {
            type: "file" as const,
            data: part.bytes,
            mediaType: part.mediaType,
            ...(part.name === undefined ? {} : { filename: part.name }),
          },
    );
    if (message.role === "assistant") return { role: "assistant", content };
    return { role: "user", content };
  });
}

export function mergeModelParameters(
  base?: ModelParameters,
  override?: ModelParameters,
): ModelParameters | undefined {
  if (!base || !override) return override ?? base;
  const providerOptions = new Map(Object.entries(base.providerOptions ?? {}));
  for (const [provider, fields] of Object.entries(
    override.providerOptions ?? {},
  )) {
    providerOptions.set(provider, {
      ...providerOptions.get(provider),
      ...fields,
    });
  }
  return {
    ...base,
    ...override,
    ...(providerOptions.size
      ? { providerOptions: Object.fromEntries(providerOptions) }
      : {}),
  };
}

function providerOptions(
  model: BoundModel,
  options: ModelParameters["providerOptions"],
): ProviderOptions {
  const key = model.connection.protocol;
  const result: ProviderOptions = {};
  for (const [name, value] of Object.entries(options ?? {})) {
    if (name !== key) {
      throw appError("model.invalid_request", {
        details: {
          binding: model.identity.binding,
          issues: [
            {
              path: ["providerOptions", name],
              reason: "Expected options for " + key,
            },
          ],
        },
      });
    }
    result[name] = { ...value };
  }
  return result;
}

interface ClientOptions {
  baseURL: string;
  headers?: Record<string, string>;
  apiKey?: string;
  fetch: typeof globalThis.fetch;
}

type ResolveCredential = NonNullable<ModelsOptions["resolveCredential"]>;
type Provider = {
  language?: (model: string, openaiApi?: "chat" | "responses") => LanguageModel;
  embedding?: (model: string) => EmbeddingModel;
  reranking?: (model: string) => RerankingModel;
  transcription?: (model: string) => TranscriptionModel;
};

export async function createProvider(
  model: BoundModel,
  call: CallScope,
  fetch: FetchFunction,
  resolveCredential: ResolveCredential,
  telemetry: ModelTelemetry,
): Promise<Provider> {
  const { connection } = model;
  call.throwIfAborted("credential");
  const credential = connection.credential
    ? await resolveCredential(connection.credential)
    : undefined;
  call.throwIfAborted("request");
  const options: ClientOptions = {
    // Provider types inherit Bun's preconnect property; providers only call this function as fetch.
    baseURL: connection.baseURL,
    fetch: telemetry.observeFetch(fetch, credential) as typeof globalThis.fetch,
    ...(connection.headers === undefined
      ? {}
      : { headers: { ...connection.headers } }),
    ...(credential === undefined ? {} : { apiKey: credential }),
  };
  if (connection.protocol !== "openai-compatible" && !credential) {
    throw appError("secret.unavailable", {
      details: {
        reference: model.identity.connection,
        reason: "credential is required",
      },
    });
  }
  switch (connection.protocol) {
    case "openai-compatible": {
      const client = createOpenAICompatible({
        ...options,
        name: "openai-compatible",
        supportsStructuredOutputs: model.binding.capabilities.structuredOutput,
        includeUsage: true,
      });
      return {
        language: client.chatModel,
        embedding: (name) =>
          indexedEmbedding(client.embeddingModel(name), model.identity.binding),
      };
    }
    case "openai": {
      const client = createOpenAI(options);
      return {
        language(name, explicit) {
          return explicit === "chat"
            ? client.chat(name)
            : client.responses(name);
        },
        embedding: (name) =>
          indexedEmbedding(client.embedding(name), model.identity.binding),
        transcription: client.transcription,
      };
    }
    case "google": {
      const client = createGoogleGenerativeAI(options);
      return { language: client.languageModel, embedding: client.embedding };
    }
    case "cohere":
      return { reranking: createCohere(options).reranking };
  }
}

function indexedEmbedding(
  model: Extract<EmbeddingModel, { specificationVersion: "v3" | "v4" }>,
  binding: string,
): EmbeddingModel {
  return wrapEmbeddingModel({
    model,
    middleware: {
      async wrapEmbed({ doEmbed, params }) {
        const result = await doEmbed();
        // The SDK returns vectors in response-array order and exposes the original indices in the response body.
        const data = (
          result.response?.body as { data?: { index?: unknown }[] } | undefined
        )?.data;
        if (
          !Array.isArray(data) ||
          data.every((entry) => entry.index === undefined)
        )
          return result;
        const embeddings: number[][] = [];
        for (const [position, { index }] of data.entries()) {
          const vector = result.embeddings[position];
          if (
            typeof index !== "number" ||
            !Number.isInteger(index) ||
            index < 0 ||
            index >= params.values.length ||
            embeddings[index] ||
            !vector
          ) {
            throw appError("model.output_invalid", {
              details: { binding, reason: "invalid_embedding_index" },
            });
          }
          embeddings[index] = vector;
        }
        return { ...result, embeddings };
      },
    },
  });
}

export function requestParameters(
  model: BoundModel,
  override?: ModelParameters,
) {
  const {
    temperature,
    topP,
    maxOutputTokens,
    seed,
    providerOptions: options,
  } = mergeModelParameters(model.binding.parameters, override) ?? {};
  const max = model.binding.capabilities.limits?.maxOutputTokens;
  if (
    max !== undefined &&
    maxOutputTokens !== undefined &&
    maxOutputTokens > max
  ) {
    throw appError("model.invalid_request", {
      details: {
        binding: model.identity.binding,
        issues: [
          {
            path: ["maxOutputTokens"],
            reason: "Output token count exceeds " + max,
          },
        ],
      },
    });
  }
  const provider = providerOptions(model, options);
  const openaiApi = provider.openai?.api;
  if (
    openaiApi !== undefined &&
    openaiApi !== "chat" &&
    openaiApi !== "responses"
  ) {
    throw appError("model.invalid_request", {
      details: {
        binding: model.identity.binding,
        issues: [
          {
            path: ["providerOptions", "openai", "api"],
            reason: "Expected chat or responses",
          },
        ],
      },
    });
  }
  if (provider.openai) delete provider.openai.api;
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(topP === undefined ? {} : { topP }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(seed === undefined ? {} : { seed }),
    providerOptions: provider,
    openaiApi:
      openaiApi === "chat"
        ? ("chat" as const)
        : openaiApi === "responses"
          ? ("responses" as const)
          : undefined,
  };
}
