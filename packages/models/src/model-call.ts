import { setTimeout as delay } from "node:timers/promises";
import {
  AppError,
  appError,
  openCall,
  type CallOptions,
  type CallScope,
  type StreamUpdate,
  throwIfAborted,
  toAppError,
} from "@themelios/core";
import {
  APICallError,
  InvalidResponseDataError,
  JSONParseError,
  NoObjectGeneratedError,
  TypeValidationError,
} from "ai";
import PQueue from "p-queue";
import type { Diagnostics } from "@themelios/runtime/diagnostics";
import type {
  ModelIdentity,
  ModelNotice,
  ModelDefaults,
  Usage,
} from "./types.js";
import {
  logDiagnostic,
  type ModelReply,
  type ModelTelemetry,
} from "./model-telemetry.js";

/** Track actual permits through finally, including while a consumer pauses an upstream reader. */
export class ModelCalls {
  readonly #queue: PQueue;
  readonly #shutdown = new AbortController();
  readonly #defaultTimeout: number;
  readonly attempts: number;

  constructor(
    defaults: ModelDefaults,
    private readonly diagnostics?: Diagnostics,
  ) {
    this.#queue = new PQueue({ concurrency: defaults.concurrency });
    this.#defaultTimeout = defaults.timeoutMs;
    this.attempts = defaults.maxAttempts;
  }

  options(options: CallOptions = {}): CallOptions {
    return {
      ...options,
      timeoutMs: options.timeoutMs ?? this.#defaultTimeout,
      signal: options.signal
        ? AbortSignal.any([this.#shutdown.signal, options.signal])
        : this.#shutdown.signal,
    };
  }

  async run<T>(
    operation: string,
    model: ModelIdentity,
    options: CallOptions | undefined,
    work: (call: CallScope) => Promise<T>,
  ): Promise<T> {
    this.assertOpen();
    const call = openCall(operation, this.options(options), () =>
      logDiagnostic(() =>
        this.diagnostics?.log("warn", "observer.failed", { operation }),
      ),
    );
    try {
      using _slot = await this.acquire(call, model);
      return await work(call);
    } finally {
      call.close();
    }
  }

  assertOpen(): void {
    if (this.#shutdown.signal.aborted)
      throw appError("runtime.closed", { details: { state: "models closed" } });
  }

  async acquire(
    call: CallScope,
    { connection, binding }: ModelIdentity,
  ): Promise<Disposable> {
    call.throwIfAborted("queue");
    call.progress({ stage: "queue" });
    const queuedAt = performance.now();
    const acquired = Promise.withResolvers<Disposable>();
    const released = Promise.withResolvers<void>();
    const wait = new AbortController();
    const abortWaiting = () => wait.abort(call.signal.reason);
    call.signal.addEventListener("abort", abortWaiting, { once: true });
    const queued = this.#queue.add(
      () => {
        call.signal.removeEventListener("abort", abortWaiting);
        logDiagnostic(() =>
          this.diagnostics?.recordQueueWait?.(
            "model.request",
            performance.now() - queuedAt,
            { connection, binding },
          ),
        );
        acquired.resolve({ [Symbol.dispose]: released.resolve });
        return released.promise;
      },
      { signal: wait.signal },
    );
    void queued
      .catch(acquired.reject)
      .finally(() => call.signal.removeEventListener("abort", abortWaiting));
    const permit = await acquired.promise.catch((error) => {
      call.throwIfAborted("queue");
      throw error;
    });
    try {
      call.throwIfAborted("request");
      return permit;
    } catch (error) {
      permit[Symbol.dispose]();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#shutdown.abort("models closed");
    await this.#queue.onIdle();
  }
}

function retryAfter(headers?: Record<string, string>): number | undefined {
  const value = headers?.["retry-after"];
  if (!value) return;
  const ms = /^\d+(?:\.\d+)?$/.test(value)
    ? Number(value) * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

export function providerFailure(
  cause: unknown,
  model: ModelIdentity,
  call: CallScope,
): AppError {
  try {
    call.throwIfAborted();
  } catch (error) {
    return toAppError(error);
  }
  if (cause instanceof AppError) return cause;
  if (APICallError.isInstance(cause))
    return providerHttpFailure(cause, model.connection);
  if (
    NoObjectGeneratedError.isInstance(cause) &&
    cause.finishReason === "length"
  )
    return appError("model.output_truncated", {
      details: { binding: model.binding, finishReason: cause.finishReason },
      cause,
    });
  if (
    TypeValidationError.isInstance(cause) ||
    JSONParseError.isInstance(cause) ||
    NoObjectGeneratedError.isInstance(cause) ||
    InvalidResponseDataError.isInstance(cause)
  ) {
    return appError("model.output_invalid", {
      details: { binding: model.binding },
      cause,
    });
  }
  return appError("model.unavailable", {
    details: { connection: model.connection },
    cause,
  });
}

export async function waitForRetry(
  error: AppError,
  attempt: number,
  max: number,
  call: CallScope,
): Promise<boolean> {
  if (!error.retryable || attempt >= max) return false;
  const details = error.details;
  const requested =
    details &&
    typeof details === "object" &&
    !Array.isArray(details) &&
    details.retryAfterMs;
  const backoff =
    typeof requested === "number"
      ? requested
      : Math.min(2000, 250 * 2 ** (attempt - 1)) + Math.random() * 40;
  if (backoff >= call.remainingMs()) return false;
  call.progress({
    stage: "retry",
    completed: attempt,
    total: max,
    unit: "attempt",
  });
  try {
    await delay(backoff, undefined, { signal: call.signal });
  } catch (cause) {
    throwIfAborted(call.signal);
    throw cause;
  }
  return true;
}

export async function retryModel<T>(
  call: CallScope,
  model: ModelIdentity,
  max: number,
  telemetry: ModelTelemetry,
  attemptWork: (reply: ModelReply) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    call.throwIfAborted("request");
    const reply: ModelReply = {};
    try {
      const result = await attemptWork(reply);
      await telemetry.finish(reply);
      return result;
    } catch (cause) {
      const error = providerFailure(cause, model, call);
      await telemetry.finish({
        ...reply,
        error,
        cancelled: call.signal.aborted,
      });
      if (!(await waitForRetry(error, attempt, max, call))) throw error;
    }
  }
}

export function modelUsage(value: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
}): { usage?: Usage } {
  const usage = Object.fromEntries(
    Object.entries(value).filter(
      ([, tokens]) =>
        tokens !== undefined && Number.isSafeInteger(tokens) && tokens >= 0,
    ),
  );
  return Object.keys(usage).length ? { usage } : {};
}

export function modelNotices(
  warnings: readonly { type: string }[],
): ModelNotice[] {
  return warnings.map((warning) => ({
    code: "model.provider_notice",
    messageKey: "model.provider_notice",
    params: { type: warning.type },
  }));
}

export async function* queuedStream<T>(
  calls: ModelCalls,
  call: CallScope,
  model: ModelIdentity,
  work: () => AsyncGenerator<StreamUpdate, T>,
): AsyncGenerator<StreamUpdate, T> {
  calls.assertOpen();
  yield { type: "progress", progress: { stage: "queue" } };
  using _slot = await calls.acquire(call, model);
  return yield* work();
}

function providerHttpFailure(
  cause: APICallError,
  connection: string,
): AppError {
  const { statusCode } = cause;
  const details = {
    connection: connection,
    ...(statusCode === undefined ? {} : { providerStatus: statusCode }),
  };
  if (statusCode === 401 || statusCode === 403)
    return appError("model.authentication_failed", { details, cause });
  if (statusCode === 429) {
    const retryAfterMs = retryAfter(cause.responseHeaders);
    return appError("model.rate_limited", {
      cause,
      retryable: true,
      details: {
        ...details,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    });
  }
  return appError("model.unavailable", {
    cause,
    details,
    retryable:
      statusCode === undefined
        ? cause.isRetryable
        : [408, 500, 502, 503, 504].includes(statusCode),
  });
}
