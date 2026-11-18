import { appError, type CallScope } from "@themelios/core";
import { embedMany, rerank, transcribe } from "ai";
import type {
  Embedded,
  EmbedRequest,
  Ranked,
  RankRequest,
  Transcript,
  TranscribeRequest,
} from "./types.js";
import { modelNotices, modelUsage, retryModel } from "./model-call.js";
import type { ModelTelemetry } from "./model-telemetry.js";
import {
  type BoundModel,
  checkParts,
  requestParameters,
  requireCapability,
  type createProvider,
} from "./providers.js";

type Client = Awaited<ReturnType<typeof createProvider>>;

export async function embed(
  bound: BoundModel,
  request: EmbedRequest,
  call: CallScope,
  attempts: number,
  telemetry: ModelTelemetry,
  client: () => Promise<Client>,
): Promise<Embedded> {
  const { binding, identity } = bound;
  const space = binding.embeddingSpace;
  if (!space || !space.purposes.includes(request.purpose))
    requireCapability(bound, "embedding:" + request.purpose);
  if (!request.inputs.length) return { space, model: identity, vectors: [] };
  if (request.inputs.some((input) => input.length === 0)) {
    throw appError("model.invalid_request", {
      details: {
        binding: identity.binding,
        issues: [
          {
            path: ["inputs"],
            reason: "Each embedding input needs at least one part",
          },
        ],
      },
    });
  }
  checkParts(bound, "embed", request.inputs.flat());
  const values = request.inputs.map((parts) =>
    parts.some((part) => part.kind === "media")
      ? "" // Google receives these complete, ordered parts through its content option.
      : parts
          .flatMap((part) => (part.kind === "text" ? [part.text] : []))
          .join("\n"),
  );
  const providerOptions = embeddingOptions(bound, request, space.dimensions);
  const result = await retryModel(
    call,
    identity,
    attempts,
    telemetry,
    async (reply) => {
      const sdk =
        (await client()).embedding?.(identity.providerModel) ??
        requireCapability(bound, "embed");
      const response = await embedMany({
        model: sdk,
        values,
        dimensions: space.dimensions,
        maxRetries: 0,
        maxParallelCalls: 1,
        abortSignal: call.signal,
        providerOptions,
      });
      const usage = modelUsage({ inputTokens: response.usage.tokens }).usage;
      if (usage) reply.tokens = usage;
      return response;
    },
  );
  call.throwIfAborted("output");
  if (result.embeddings.length !== values.length)
    throw appError("model.output_invalid", {
      details: { binding: identity.binding },
    });
  const vectors = result.embeddings.map((vector) => {
    if (
      vector.length !== space.dimensions ||
      vector.some((value) => !Number.isFinite(value))
    ) {
      throw appError("model.output_invalid", {
        details: { binding: identity.binding },
      });
    }
    if (space.normalization === "none") return vector;
    const norm = Math.hypot(...vector);
    if (!Number.isFinite(norm) || norm === 0)
      throw appError("model.output_invalid", {
        details: { binding: identity.binding },
      });
    return vector.map((value) => value / norm);
  });
  return {
    space,
    vectors,
    model: identity,
    ...modelUsage({ inputTokens: result.usage.tokens }),
  };
}

export async function rank(
  bound: BoundModel,
  request: RankRequest,
  call: CallScope,
  attempts: number,
  telemetry: ModelTelemetry,
  client: () => Promise<Client>,
): Promise<Ranked> {
  const { identity } = bound;
  if (!request.documents.length) return { ranking: [], model: identity };
  const topN = request.topN ?? request.documents.length;
  if (
    !Number.isSafeInteger(topN) ||
    topN < 1 ||
    topN > request.documents.length
  ) {
    throw appError("model.invalid_request", {
      details: {
        binding: identity.binding,
        issues: [
          {
            path: ["topN"],
            reason: "Expected an integer within the document count",
          },
        ],
      },
    });
  }
  checkParts(
    bound,
    "rank",
    [request.query, ...request.documents].map((text) => ({
      kind: "text",
      text,
    })),
  );
  const result = await retryModel(
    call,
    identity,
    attempts,
    telemetry,
    async () => {
      const sdk =
        (await client()).reranking?.(identity.providerModel) ??
        requireCapability(bound, "rank");
      return rerank({
        model: sdk,
        query: request.query,
        documents: [...request.documents],
        topN,
        maxRetries: 0,
        abortSignal: call.signal,
        providerOptions: requestParameters(bound).providerOptions,
      });
    },
  );
  call.throwIfAborted("output");
  const ranking = result.ranking.map((item) => ({
    index: item.originalIndex,
    score: item.score,
  }));
  const indices = new Set(ranking.map((item) => item.index));
  if (
    ranking.length !== topN ||
    indices.size !== ranking.length ||
    ranking.some(
      ({ index, score }) =>
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= request.documents.length ||
        !Number.isFinite(score),
    )
  ) {
    throw appError("model.output_invalid", {
      details: { binding: identity.binding },
    });
  }
  return {
    ranking: ranking.sort((a, b) => b.score - a.score || a.index - b.index),
    model: { ...identity, returnedModel: result.response.modelId },
  };
}

export async function transcript(
  bound: BoundModel,
  request: TranscribeRequest,
  call: CallScope,
  attempts: number,
  telemetry: ModelTelemetry,
  client: () => Promise<Client>,
): Promise<Transcript> {
  const { identity, binding } = bound;
  const granularity = request.timestamps ?? "none";
  if (
    granularity !== "none" &&
    !binding.capabilities.transcriptionTimestamps?.includes(granularity)
  ) {
    requireCapability(bound, "transcribe:" + granularity);
  }
  checkParts(bound, "transcribe", [{ kind: "media", ...request.audio }]);
  const { providerOptions } = requestParameters(bound);
  if (request.language)
    providerOptions.openai = {
      ...providerOptions.openai,
      language: request.language,
    };
  const result = await retryModel(
    call,
    identity,
    attempts,
    telemetry,
    async (reply) => {
      const sdk =
        (await client()).transcription?.(identity.providerModel) ??
        requireCapability(bound, "transcribe");
      const response = await transcribe({
        model: sdk,
        audio: request.audio.bytes,
        providerOptions,
        maxRetries: 0,
        abortSignal: call.signal,
        timestampGranularities: granularity === "none" ? [] : [granularity],
      });
      if (telemetry.capturesContent) reply.response = response.text;
      return response;
    },
  );
  call.throwIfAborted("output");
  // The SDK aliases words to segments when no segment intervals were returned.
  const reported =
    granularity === "word"
      ? result.words
      : result.segments === result.words
        ? undefined
        : result.segments;
  if (granularity !== "none" && !reported?.length && result.text.trim())
    requireCapability(bound, "transcribe:" + granularity);
  const milliseconds = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0)
      throw appError("model.output_invalid", {
        details: { binding: identity.binding },
      });
    return Math.round(seconds * 1000);
  };
  const segments =
    granularity === "none"
      ? undefined
      : reported?.map((part) => {
          if (part.startSecond > part.endSecond)
            throw appError("model.output_invalid", {
              details: { binding: identity.binding },
            });
          return {
            startMs: milliseconds(part.startSecond),
            endMs: milliseconds(part.endSecond),
            text: part.text,
            granularity,
          };
        });
  const returnedModel = result.responses.at(-1)?.modelId;
  return {
    text: result.text,
    model: {
      ...identity,
      ...(returnedModel === undefined ? {} : { returnedModel }),
    },
    notices: modelNotices(result.warnings),
    ...(segments === undefined ? {} : { segments }),
    ...(result.language === undefined ? {} : { language: result.language }),
    ...(result.durationInSeconds === undefined
      ? {}
      : { durationMs: milliseconds(result.durationInSeconds) }),
  };
}

function embeddingOptions(
  bound: BoundModel,
  request: EmbedRequest,
  dimensions: number,
) {
  const { providerOptions } = requestParameters(bound);
  const protocol = bound.connection.protocol;
  if (protocol === "openai" || protocol === "openai-compatible") {
    const options = providerOptions[protocol];
    if (
      options?.dimensions !== undefined &&
      options.dimensions !== dimensions
    ) {
      throw appError("model.invalid_request", {
        details: {
          binding: bound.identity.binding,
          issues: [
            {
              path: ["providerOptions", protocol, "dimensions"],
              reason: "Dimensions conflict with the embedding space",
            },
          ],
        },
      });
    }
    if (protocol === "openai-compatible" && options) {
      providerOptions.openaiCompatible = options;
      delete providerOptions[protocol];
    }
  }
  if (protocol === "google") {
    providerOptions.google = googleEmbeddingOptions(
      bound,
      request,
      dimensions,
      providerOptions.google,
    );
  }
  return providerOptions;
}

function googleEmbeddingOptions(
  bound: BoundModel,
  request: EmbedRequest,
  dimensions: number,
  google?: ReturnType<typeof requestParameters>["providerOptions"][string],
) {
  const taskType =
    request.purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
  if (
    (google?.taskType !== undefined && google.taskType !== taskType) ||
    (google?.outputDimensionality !== undefined &&
      google.outputDimensionality !== dimensions) ||
    google?.content !== undefined
  ) {
    throw appError("model.invalid_request", {
      details: {
        binding: bound.identity.binding,
        issues: [
          {
            path: ["providerOptions", "google"],
            reason: "Options conflict with the embedding space or input",
          },
        ],
      },
    });
  }
  return {
    ...google,
    taskType,
    outputDimensionality: dimensions,
    content: request.inputs.map((parts) =>
      parts.some((part) => part.kind === "media")
        ? parts.map((part) =>
            part.kind === "text"
              ? { text: part.text }
              : {
                  inlineData: {
                    mimeType: part.mediaType,
                    data: Buffer.from(part.bytes).toString("base64"),
                  },
                },
          )
        : null,
    ),
  };
}
