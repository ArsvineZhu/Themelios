import { AsyncLocalStorage } from "node:async_hooks";
import {
  AppError,
  attachTraceId,
  createFlow,
  openCall,
  toAppError,
  type CallOptions,
  type CallScope,
  type Flow,
  type FlowEvent,
  type Json,
} from "@themelios/core";
import {
  newSpanId,
  newTraceId,
  type RuntimeDiagnostics,
  type TraceFrame,
} from "./diagnostics.js";
import { failure } from "./failure.js";
import type { Network } from "./network.js";
import type { Secrets } from "./secrets.js";
import type { RuntimeSettings } from "./settings.js";

export interface Closable {
  close(): void | Promise<void>;
}

export interface TaskHandle<T> {
  readonly result: Promise<T>;
  cancel(reason?: string): void;
}

export interface Execution {
  run<T>(
    name: string,
    work: (signal: AbortSignal) => Promise<T>,
    options?: CallOptions,
  ): Promise<T>;
  start<T>(
    name: string,
    work: (signal: AbortSignal) => Promise<T>,
    options?: CallOptions,
  ): TaskHandle<T>;
  flow<T>(
    name: string,
    create: (signal: AbortSignal) => Flow<T>,
    options?: CallOptions,
  ): Flow<T>;
}

export interface ResourceSlot<T extends Closable> {
  get(): T;
}

export interface ResourceContext<S> {
  readonly settings: Readonly<S>;
  readonly runtime: Readonly<RuntimeSettings>;
  readonly network: Network;
  readonly secrets: Secrets;
  readonly diagnostics: RuntimeDiagnostics;
}

export interface OperationResources<S> extends ResourceContext<S> {
  hold(): () => void;
}

type FrameStore<S> = {
  call?: CallScope;
  resources?: OperationResources<S>;
  active?: boolean;
  trace: TraceFrame;
};

interface ActiveOperation {
  name: string;
  call: CallScope;
  done: Promise<void>;
}

interface OperationLease {
  call: CallScope;
  withContext<T>(work: () => T): T;
  end(error?: unknown): void;
  failure(error: unknown): AppError;
}

/** Captures resources, budget, and trace context in a single AsyncLocalStorage across async calls and streams. */
export class SessionExecution<S> implements Execution {
  readonly #local = new AsyncLocalStorage<FrameStore<S>>();
  readonly #operations = new Set<ActiveOperation>();
  #closing = false;

  constructor(readonly getResources: () => OperationResources<S>) {}

  current():
    | {
        call: CallScope;
        resources: OperationResources<S>;
        active: boolean;
        trace: TraceFrame;
      }
    | undefined {
    const context = this.#local.getStore();
    return context?.active && context.call && context.resources
      ? {
          call: context.call,
          resources: context.resources,
          active: true,
          trace: context.trace,
        }
      : undefined;
  }

  currentTrace(): TraceFrame | undefined {
    return this.#local.getStore()?.trace;
  }

  enterTrace<T>(frame: TraceFrame, work: () => Promise<T>): Promise<T> {
    const store = this.#local.getStore();
    return this.#local.run(
      store ? { ...store, trace: frame } : { trace: frame },
      work,
    );
  }

  run<T>(
    name: string,
    work: (signal: AbortSignal) => Promise<T>,
    options?: CallOptions,
  ): Promise<T> {
    return this.start(name, work, options).result;
  }

  start<T>(
    name: string,
    work: (signal: AbortSignal) => Promise<T>,
    options?: CallOptions,
  ): TaskHandle<T> {
    let context: OperationLease;
    try {
      context = this.#begin(name, options);
    } catch (error) {
      return { result: Promise.reject(error), cancel() {} };
    }
    const result = context
      .withContext(async () => {
        try {
          context.call.throwIfAborted();
          return await work(context.call.signal);
        } catch (error) {
          throw context.failure(error);
        }
      })
      .then(
        (value) => {
          context.end();
          return value;
        },
        (error: unknown) => {
          context.end(error);
          throw error;
        },
      );
    return { result, cancel: (reason) => context.call.cancel(reason) };
  }

  flow<T>(
    name: string,
    create: (signal: AbortSignal) => Flow<T>,
    options: CallOptions = {},
  ): Flow<T> {
    const begin = this.#begin.bind(this);
    const { onProgress, ...request } = options;
    const enteredAt = performance.now();
    const stop = new AbortController();
    const signal = request.signal
      ? AbortSignal.any([request.signal, stop.signal])
      : stop.signal;
    return createFlow<T>(
      name,
      async function* (flowCall) {
        const timeoutMs =
          request.timeoutMs === undefined
            ? undefined
            : Math.max(0, request.timeoutMs - (performance.now() - enteredAt));
        const context = begin(name, {
          signal: flowCall.signal,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(onProgress ? { onProgress } : {}),
        });
        const abort = () => stop.abort(context.call.signal.reason);
        context.call.signal.addEventListener("abort", abort, { once: true });
        let inner: Flow<T> | undefined;
        let iterator: AsyncIterator<FlowEvent<T>> | undefined;
        let finished = false;
        let cause: unknown;
        try {
          context.call.throwIfAborted();
          inner = context.withContext(() => create(context.call.signal));
          iterator = context.withContext(() => inner![Symbol.asyncIterator]());
          while (true) {
            const next = await context.withContext(() => iterator!.next());
            if (next.done)
              throw failure("call.invalid_state", {
                operation: name,
                state: "missing_result",
              });
            if (next.value.type === "result") {
              finished = true;
              return next.value.value;
            }
            context.call.throwIfAborted();
            if (next.value.type === "progress")
              context.call.progress(next.value.progress);
            yield next.value;
          }
        } catch (error) {
          cause = context.failure(error);
          throw cause;
        } finally {
          context.call.signal.removeEventListener("abort", abort);
          if (!finished) inner?.cancel("operation cancelled");
          try {
            await context.withContext(() => iterator?.return?.());
          } finally {
            context.end(
              cause ??
                (context.call.signal.aborted
                  ? context.call.signal.reason
                  : undefined),
            );
          }
        }
      },
      { ...request, signal },
    );
  }

  stop(): void {
    this.#closing = true;
  }

  async drain(graceMs: number): Promise<void> {
    const wait = Promise.all([...this.#operations].map((item) => item.done));
    if (graceMs > 0 && this.#operations.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        wait,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, graceMs);
        }),
      ]);
      clearTimeout(timer);
    }
    while (this.#operations.size) {
      const pending = [...this.#operations];
      for (const item of pending) {
        this.getResources().diagnostics.log(
          "warn",
          "runtime.operation_cancelling",
          {
            operation: item.name,
            graceMs,
            remainingMs: Number.isFinite(item.call.remainingMs())
              ? item.call.remainingMs()
              : null,
          },
        );
        item.call.cancel("session closing");
      }
      await Promise.all(pending.map((item) => item.done));
    }
  }

  #begin(
    name: string,
    options: CallOptions = {},
    parent = this.current(),
  ): OperationLease {
    if (!parent && this.#closing)
      throw failure("runtime.closed", { state: "closing" });
    const resources = parent?.resources ?? this.getResources();
    const budget = Math.min(
      options.timeoutMs ?? Infinity,
      parent?.call.remainingMs() ?? Infinity,
    );
    const signals = [parent?.call.signal, options.signal].filter(
      (signal) => signal !== undefined,
    );
    const signal = signals.length ? AbortSignal.any(signals) : undefined;
    const call = openCall(
      name,
      {
        ...options,
        ...(signal ? { signal } : {}),
        ...(Number.isFinite(budget) ? { timeoutMs: budget } : {}),
      },
      () =>
        resources.diagnostics.log("warn", "observer.failed", {
          operation: name,
        }),
    );
    const parentTrace = parent?.trace ?? this.currentTrace();
    const trace: TraceFrame = {
      traceId: parentTrace?.traceId ?? newTraceId(),
      spanId: newSpanId(),
      ...(parentTrace ? { parentSpanId: parentTrace.spanId } : {}),
      operation: parentTrace?.operation ?? name,
    };
    const isRoot = !parentTrace;
    const startedAt = performance.now();
    const context: FrameStore<S> = {
      call,
      resources,
      active: true,
      trace,
    };
    const release = resources.hold();
    const workDone = Promise.withResolvers<void>();
    const item: ActiveOperation = { name, call, done: workDone.promise };
    this.#operations.add(item);

    return {
      call,
      withContext: <T>(work: () => T) => this.#local.run(context, work),
      end: (error) => {
        try {
          if (isRoot) {
            const durationMs = Math.round(performance.now() - startedAt);
            const outcome: Json = error === undefined ? "success" : "failure";
            const code =
              error instanceof AppError
                ? error.code
                : error !== undefined
                  ? "internal.unexpected"
                  : undefined;
            resources.diagnostics.log(
              error === undefined ? "info" : "warn",
              "operation.completed",
              {
                stage: name,
                durationMs,
                outcome,
                ...(code ? { code } : {}),
              },
              trace,
            );
          }
        } finally {
          call.close();
          context.active = false;
          release();
          this.#operations.delete(item);
          workDone.resolve();
        }
      },
      failure: (error) => {
        const mapped = toAppError(error);
        attachTraceId(mapped, trace.traceId);
        return mapped;
      },
    };
  }
}
