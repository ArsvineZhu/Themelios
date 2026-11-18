import { AppError, type Json } from "@themelios/core";

export function storageError(
  code: string,
  details: Json,
  cause?: unknown,
): AppError {
  return new AppError({ code, messageKey: code, details, cause });
}

export function fileErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}
