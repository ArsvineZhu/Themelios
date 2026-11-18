import { AppError, type Json } from "@themelios/core";

export function failure(
  code: string,
  details?: Json,
  cause?: unknown,
  retryable = false,
): AppError {
  return new AppError({
    code,
    messageKey: code,
    ...(details === undefined ? {} : { details }),
    cause,
    retryable,
  });
}

export function errno(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
