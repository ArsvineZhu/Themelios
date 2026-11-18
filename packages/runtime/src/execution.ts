import { AsyncLocalStorage } from "node:async_hooks";
import {
  AppError,
  createFlow,
  openCall,
  toAppError,
  type CallOptions,
  type CallScope,
  type Flow,
  type FlowEvent,
} from "@themelios/core";
import type { Execution, ResourceContext, TaskHandle } from "./contracts.js";
import { diagnoseError, type RuntimeDiagnostics } from "./diagnostics.js";
import { failure } from "./failure.js";

export interface OperationResources<S> extends ResourceContext<S> {
  readonly diagnostics: RuntimeDiagnostics;
  hold(): () => void;
}

type Context<S> = {
  call: CallScope;
  resources: OperationResources<S>;
  active: boolean;
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

/** Captures resources and budget at operation admission and retains them until real work exits. */
export class SessionExecution<S> implements Execution {
  readonly #local = new AsyncLocalStorage<Context<S>>();
  readonly #operations = new Set<ActiveOperation>();
  #closing = false;

  constructor(readonly getResources: () => OperationResources<S>) {}

  current(): Context<S> | undefined {
    const context = this.#local.getStore();
    return context?.active ? context : undefined;
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
    const context: Context<S> = { call, resources, active: true };
    const release = resources.hold();
    const workDone = Promise.withResolvers<void>();
    const diagnosticDone = Promise.withResolvers<void>();
    const item = { name, call, done: workDone.promise };
    this.#operations.add(item);
    let inside = <T>(work: () => T) => this.#local.run(context, work);
    let complete = () => {
      call.close();
      context.active = false;
      release();
      this.#operations.delete(item);
      workDone.resolve();
    };
    if (!parent) {
      const span = resources.diagnostics.operation(name, () => {
        const runWithSpan = AsyncLocalStorage.snapshot();
        inside = (work) => runWithSpan(() => this.#local.run(context, work));
        return diagnosticDone.promise;
      });
      const finish = complete;
      complete = () => {
        void span.catch(() => undefined).finally(finish);
      };
    }
    return {
      call,
      withContext(work) {
        return inside(work);
      },
      end(error) {
        if (!parent) {
          if (error === undefined) diagnosticDone.resolve();
          else diagnosticDone.reject(error);
        }
        complete();
      },
      failure(error) {
        const mapped = toAppError(error);
        const traceId = inside(() => resources.diagnostics.correlate().traceId);
        diagnoseError(mapped, traceId);
        return mapped;
      },
    };
  }
}
