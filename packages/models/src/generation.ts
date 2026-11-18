import {
  appError,
  type CallScope,
  type Json,
  parseJson,
  parseValue,
  type StreamUpdate,
  toAppError,
} from "@themelios/core";
import {
  generateText,
  type JSONSchema7,
  jsonSchema,
  Output,
  streamText,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type CallWarning,
} from "ai";
import { z } from "zod";
import type { Generated, GenerateRequest, ModelIdentity } from "./contracts.js";
import {
  modelNotices,
  modelUsage,
  providerFailure,
  retryModel,
  waitForRetry,
} from "./model-call.js";
import { countTokens, type ModelTelemetry } from "./model-telemetry.js";
import {
  type BoundModel,
  captureParts,
  checkOperation,
  checkParts,
  requestParameters,
  requireCapability,
  sdkMessages,
} from "./providers.js";
import {
  mimePatternSchema,
  modelParametersSchema,
  outputSchema,
  validateOutput,
} from "./schema.js";

const messagesSchema = z
  .array(
    z.strictObject({
      role: z.enum(["system", "user", "assistant"]),
      parts: z
        .array(
          z.discriminatedUnion("kind", [
            z.strictObject({ kind: z.literal("text"), text: z.string() }),
            z.strictObject({
              kind: z.literal("media"),
              mediaType: mimePatternSchema,
              bytes: z.instanceof(Uint8Array),
              name: z.string().optional(),
            }),
          ]),
        )
        .min(1),
    }),
  )
  .min(1);

export function providerOutputSchema(schema: z.ZodType<Json>): Json {
  const result = outputSchema(schema);
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    result.type !== "object"
  ) {
    throw appError("model.invalid_request", {
      details: {
        issues: [{ path: ["output"], reason: "Expected an object schema" }],
      },
    });
  }
  // Schema dialect and local constraints are owned by the task. It still validates the final value.
  const { $schema: _dialect, ...sent } = result;
  return sent;
}

export function prepareGeneration<O extends Json>(
  model: BoundModel,
  request: GenerateRequest<O>,
  streaming = false,
) {
  checkOperation(model, "generate");
  if (streaming && !model.binding.capabilities.streaming)
    requireCapability(model, "streaming");
  if (request.output !== "text" && !model.binding.capabilities.structuredOutput)
    requireCapability(model, "structuredOutput");
  parseValue(messagesSchema, request.messages, "model.invalid_request");
  checkParts(
    model,
    "generate",
    request.messages.flatMap((message) => message.parts),
  );
  const captured = new WeakMap<Uint8Array, Uint8Array>();
  const messages = sdkMessages(
    request.messages.map((message) => ({
      role: message.role,
      parts: captureParts(message.parts, captured),
    })),
  );
  const { openaiApi, ...parameters } = requestParameters(
    model,
    request.parameters === undefined
      ? undefined
      : parseValue(
          modelParametersSchema,
          request.parameters,
          "model.invalid_request",
        ),
  );
  const schema = request.output;
  const sentSchema =
    schema === "text" ? undefined : providerOutputSchema(schema);
  const output =
    sentSchema === undefined
      ? Output.text()
      : Output.object({ schema: jsonSchema(sentSchema as JSONSchema7) });
  return { messages, parameters, schema, sentSchema, output, openaiApi };
}

type Generation<O extends Json> = ReturnType<typeof prepareGeneration<O>>;

function finish<O extends Json>(
  prepared: Generation<O>,
  model: ModelIdentity,
  text: string,
  reason: FinishReason,
  usage: LanguageModelUsage,
  warnings: readonly CallWarning[],
): Generated<O> {
  const measured = modelUsage(usage);
  if (reason !== "stop") {
    const code =
      reason === "length"
        ? "model.output_truncated"
        : reason === "content-filter"
          ? "model.refused"
          : "model.incomplete";
    throw appError(code, {
      details: parseJson({
        binding: model.binding,
        finishReason: reason,
        ...measured,
      }),
    });
  }
  if (prepared.schema === "text")
    return {
      value: text as O,
      model,
      ...measured,
      notices: modelNotices(warnings),
    };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw appError("model.output_invalid", {
      details: parseJson({ binding: model.binding, ...measured }),
      cause,
    });
  }
  return {
    value: validateOutput(prepared.schema, value, model.binding),
    model,
    ...measured,
    notices: modelNotices(warnings),
  };
}

function sdkGeneration<O extends Json>(
  prepared: Generation<O>,
  call: CallScope,
  model: LanguageModel,
) {
  return {
    model,
    messages: prepared.messages,
    allowSystemInMessages: true,
    output: prepared.output,
    abortSignal: call.signal,
    maxRetries: 0,
    ...prepared.parameters,
  };
}

export async function generate<O extends Json>(
  prepared: Generation<O>,
  call: CallScope,
  identity: ModelIdentity,
  attempts: number,
  telemetry: ModelTelemetry,
  client: () => Promise<LanguageModel>,
): Promise<Generated<O>> {
  return retryModel(call, identity, attempts, telemetry, async (reply) => {
    call.progress({ stage: "model" });
    const schema = captureSchema(prepared, telemetry);
    if (schema) reply.schema = schema;
    const result = await generateText(
      sdkGeneration(prepared, call, await client()),
    );
    reply.tokens = countTokens(result.totalUsage);
    if (telemetry.capturesContent) reply.response = result.text;
    call.throwIfAborted("output");
    const model = { ...identity, returnedModel: result.response.modelId };
    return finish(
      prepared,
      model,
      result.text,
      result.finishReason,
      result.totalUsage,
      result.warnings ?? [],
    );
  });
}

export async function* streamGeneration<O extends Json>(
  prepared: Generation<O>,
  call: CallScope,
  identity: ModelIdentity,
  attempts: number,
  telemetry: ModelTelemetry,
  client: () => Promise<LanguageModel>,
): AsyncGenerator<StreamUpdate, Generated<O>> {
  for (let attempt = 1; ; attempt++) {
    const response: StreamResponse = {
      model: identity,
      deltas: [],
      warnings: [],
    };
    try {
      yield {
        type: "progress",
        progress: {
          stage: "model",
          completed: attempt,
          total: attempts,
          unit: "attempt",
        },
      };
      return yield* streamAttempt(
        prepared,
        call,
        identity,
        telemetry,
        client,
        response,
      );
    } catch (cause) {
      const error = toAppError(cause);
      if (
        response.deltas.length ||
        !(await waitForRetry(error, attempt, attempts, call))
      )
        throw error;
    }
  }
}

async function* streamAttempt<O extends Json>(
  prepared: Generation<O>,
  call: CallScope,
  identity: ModelIdentity,
  telemetry: ModelTelemetry,
  client: () => Promise<LanguageModel>,
  response: StreamResponse,
): AsyncGenerator<StreamUpdate, Generated<O>> {
  let reply: string | undefined;
  let failure: ReturnType<typeof providerFailure> | undefined;
  let succeeded = false;
  const schema = captureSchema(prepared, telemetry);
  try {
    const result = streamText({
      ...sdkGeneration(prepared, call, await client()),
      streamRetries: 0,
      onError() {},
    });
    yield* readModelStream(result.stream, call, identity, response);
    call.throwIfAborted("output");
    const { complete, deltas, model, warnings } = response;
    if (!complete)
      throw appError("model.incomplete", {
        details: { binding: identity.binding, stage: "output" },
      });
    reply = deltas.join("");
    const generated = finish(
      prepared,
      model,
      reply,
      complete.finishReason,
      complete.totalUsage,
      warnings,
    );
    succeeded = true;
    return generated;
  } catch (cause) {
    failure = providerFailure(cause, identity, call);
    throw failure;
  } finally {
    const cancelled = !succeeded && (call.signal.aborted || !failure);
    if (cancelled && !failure)
      failure = providerFailure(appError("call.cancelled"), identity, call);
    await telemetry.finish({
      ...(failure ? { error: failure } : {}),
      ...(response.complete
        ? { tokens: countTokens(response.complete.totalUsage) }
        : {}),
      ...(telemetry.capturesContent
        ? { response: reply ?? response.deltas.join("") }
        : {}),
      ...(schema ? { schema } : {}),
      cancelled,
    });
  }
}

function captureSchema<O extends Json>(
  prepared: Generation<O>,
  telemetry: ModelTelemetry,
): Json | undefined {
  if (
    !telemetry.capturesContent ||
    prepared.schema === "text" ||
    !prepared.sentSchema
  )
    return undefined;
  return { task: outputSchema(prepared.schema), sent: prepared.sentSchema };
}

type StreamResponse = {
  model: ModelIdentity;
  deltas: string[];
  warnings: CallWarning[];
  complete?: { finishReason: FinishReason; totalUsage: LanguageModelUsage };
};

async function* readModelStream(
  stream: ReturnType<typeof streamText>["stream"],
  call: CallScope,
  identity: ModelIdentity,
  response: StreamResponse,
): AsyncGenerator<StreamUpdate> {
  const reader = stream.getReader();
  try {
    while (true) {
      call.throwIfAborted("model");
      const part = await reader.read();
      if (part.done) break;
      const event = part.value;
      switch (event.type) {
        case "start-step":
          response.warnings.push(...event.warnings);
          break;
        case "finish-step":
          response.model = {
            ...identity,
            returnedModel: event.response.modelId,
          };
          break;
        case "text-delta":
          response.deltas.push(event.text);
          yield { type: "text-delta", text: event.text };
          break;
        case "finish":
          response.complete = event;
          break;
        case "error":
          throw event.error;
        case "abort":
          call.throwIfAborted("model");
          throw appError("model.incomplete", {
            details: { binding: identity.binding, stage: "model" },
          });
      }
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
