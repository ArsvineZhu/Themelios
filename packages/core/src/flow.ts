import { AppError, appError, toAppError } from "./errors.js";

export interface Progress {
  stage: string;
  completed?: number;
  total?: number;
  unit?: string;
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (progress: Progress) => void;
}

export type StreamUpdate =
  | { type: "progress"; progress: Progress }
  | { type: "text-delta"; text: string };
export type FlowEvent<T> = StreamUpdate | { type: "result"; value: T };

export interface Flow<T> extends AsyncIterable<FlowEvent<T>> {
  cancel(reason?: string): void;
}

/** Transforms the final value without starting a second call or owning the source's deadline. */
export function mapFlowResult<T, U>(
  source: Flow<T>,
  map: (value: T) => U | Promise<U>,
): Flow<U> {
  return {
    cancel: (reason) => source.cancel(reason),
    async *[Symbol.asyncIterator]() {
      for await (const event of source) {
        if (event.type === "result") {
          yield { type: "result", value: await map(event.value) };
          return;
        }
        yield event;
      }
    },
  };
}

export interface CallScope {
  readonly signal: AbortSignal;
  remainingMs(): number;
  throwIfAborted(stage?: string): void;
  progress(update: Progress): void;
  cancel(reason?: string): void;
  close(): void;
}

function cancelled(reason?: unknown): AppError {
  return appError("call.cancelled", {
    ...(typeof reason === "string" &&
    reason.length <= 120 &&
    !/[\r\n]/.test(reason)
      ? { details: { reason } }
      : {}),
  });
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason: unknown = signal.reason;
  if (
    reason instanceof AppError &&
    (reason.code === "call.cancelled" || reason.code === "call.timeout")
  )
    throw reason;
  throw cancelled(reason);
}

/** Owns one monotonic budget and detaches from the caller once real work has finished. */
export function openCall(
  operation: string,
  options: CallOptions = {},
  observerFailed?: (error: unknown) => void,
  enteredAt = performance.now(),
): CallScope {
  const { timeoutMs, signal: parent, onProgress } = options;
  if (
    timeoutMs !== undefined &&
    (!Number.isFinite(timeoutMs) || timeoutMs < 0)
  ) {
    throw appError("input.invalid", {
      details: {
        issues: [
          { path: ["timeoutMs"], reason: "Expected nonnegative milliseconds" },
        ],
      },
    });
  }
  const controller = new AbortController();
  const { signal } = controller;
  const deadline = timeoutMs === undefined ? Infinity : enteredAt + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stage = "entry";
  let observer = onProgress;
  const remainingMs = () => Math.max(0, deadline - performance.now());
  const inheritAbort = () => controller.abort(parent?.reason);
  const expire = () => {
    if (signal.aborted || timeoutMs === undefined) return;
    const remaining = remainingMs();
    if (remaining > 0) {
      timer = setTimeout(expire, Math.min(remaining + 1, 2_147_483_647));
      return;
    }
    controller.abort(
      appError("call.timeout", {
        retryable: true,
        details: { operation, timeoutMs, stage },
      }),
    );
  };
  if (parent?.aborted) inheritAbort();
  else parent?.addEventListener("abort", inheritAbort, { once: true });
  expire();
  return {
    signal,
    remainingMs,
    throwIfAborted(nextStage = stage) {
      stage = nextStage;
      if (!signal.aborted && remainingMs() === 0) expire();
      throwIfAborted(signal);
    },
    progress(update) {
      stage = update.stage;
      try {
        observer?.(update);
      } catch (error) {
        observer = undefined;
        observerFailed?.(error);
      }
    },
    cancel(reason) {
      controller.abort(cancelled(reason));
    },
    close() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", inheritAbort);
    },
  };
}

/** Start on first next. Abort before requesting generator return, which may wait behind a pending next. */
export function createFlow<T>(
  operation: string,
  produce: (call: CallScope) => AsyncGenerator<StreamUpdate, T>,
  options: CallOptions = {},
): Flow<T> {
  const enteredAt = performance.now();
  const own = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([own.signal, options.signal])
    : own.signal;
  let claimed = false;
  return {
    cancel(reason) {
      own.abort(cancelled(reason));
    },
    [Symbol.asyncIterator](): AsyncIterator<FlowEvent<T>> {
      if (claimed)
        throw appError("call.stream_consumed", { details: { operation } });
      claimed = true;
      let active: CallScope | undefined;
      let generator: AsyncGenerator<StreamUpdate, T> | undefined;
      let stopping: Promise<void> | undefined;
      let done = false;
      let pulling = false;
      function close(): void {
        active?.signal.removeEventListener("abort", requestStop);
        active?.close();
      }
      function requestStop(): void {
        if (!generator || stopping) return;
        stopping = generator
          .return(undefined as T)
          .then(() => undefined)
          .finally(close);
        void stopping.catch(() => undefined);
      }
      function start(): {
        call: CallScope;
        iterator: AsyncGenerator<StreamUpdate, T>;
      } {
        const call = (active ??= openCall(
          operation,
          { ...options, signal },
          undefined,
          enteredAt,
        ));
        call.throwIfAborted();
        if (!generator) {
          generator = produce(call);
          call.signal.addEventListener("abort", requestStop, { once: true });
        }
        return { call, iterator: generator };
      }
      async function stop(): Promise<void> {
        if (done) return;
        done = true;
        own.abort(cancelled("consumer closed the flow"));
        try {
          await stopping;
        } finally {
          close();
        }
      }
      return {
        async next() {
          if (done) return { done: true, value: undefined };
          if (pulling)
            throw appError("call.invalid_state", {
              details: { operation, state: "pulling" },
            });
          pulling = true;
          try {
            const { call, iterator } = start();
            const step = await iterator.next();
            if (done) return { done: true, value: undefined };
            if (step.done) {
              done = true;
              close();
              return {
                done: false,
                value: { type: "result", value: step.value },
              };
            }
            call.throwIfAborted();
            if (step.value.type === "progress")
              call.progress(step.value.progress);
            return { done: false, value: step.value };
          } catch (cause) {
            done = true;
            await stopping?.catch(() => undefined);
            close();
            active?.throwIfAborted();
            throw toAppError(cause);
          } finally {
            pulling = false;
          }
        },
        async return() {
          await stop();
          return { done: true, value: undefined };
        },
        async throw(error: unknown) {
          await stop();
          throw error;
        },
      };
    },
  };
}

/** Iterates input bytes and releases the owned stream reader on completion or cancellation. */
export async function* streamChunks(
  source: Uint8Array | ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    throwIfAborted(signal);
    yield source;
    return;
  }
  const reader = source.getReader();
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let done = false;
  try {
    while (!done) {
      throwIfAborted(signal);
      const next = await reader.read();
      done = next.done;
      throwIfAborted(signal);
      if (!next.done) yield next.value;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!done) cancel();
    await cancellation;
    reader.releaseLock();
  }
}
