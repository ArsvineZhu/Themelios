import { AppError, formatJsonPointer, type Json } from "@themelios/core";
import type { z } from "zod";

export function contentError(
  code: string,
  details: Json,
  cause?: unknown,
): AppError {
  return new AppError({ code, messageKey: code, details, cause });
}

export function validated<T>(
  schema: z.ZodType<T>,
  value: unknown,
  path: readonly PropertyKey[] = [],
): T {
  const check = schema.safeParse(value);
  if (!check.success)
    throw contentError("content.schema_invalid", {
      issues: check.error.issues.map((issue) => ({
        path: formatJsonPointer([...path, ...issue.path]),
        constraint: issue.message,
      })),
    });
  return check.data;
}

export function jsonValue(text: string, ref: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw contentError(
      "content.decode_failed",
      { ref, reason: "invalid JSON" },
      error,
    );
  }
}
