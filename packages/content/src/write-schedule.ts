import { openCall, type CallOptions } from "@themelios/core";

/** Captures input synchronously within the call scope before scheduling its I/O. */
export type ScheduleContentWrite = <T>(
  operation: string,
  capture: () => (signal: AbortSignal) => Promise<T>,
  options?: CallOptions,
) => Promise<T>;

export const runContentWrite: ScheduleContentWrite = async (
  operation,
  capture,
  options,
) => {
  const scope = openCall(operation, options);
  try {
    scope.throwIfAborted();
    const work = capture();
    scope.throwIfAborted();
    return await work(scope.signal);
  } finally {
    scope.close();
  }
};
