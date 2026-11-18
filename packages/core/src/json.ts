import { z } from "zod";
import { appError } from "./errors.js";

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

type Issue = { path: (string | number)[]; reason: string };

function scalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function members(
  value: object,
): Iterable<readonly [string | number, unknown]> | undefined {
  if (Array.isArray(value)) return value.entries();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === null || prototype === Object.prototype)
    return Object.entries(value);
}

function invalidJson(
  value: unknown,
  path: Issue["path"],
  ancestors: Set<object>,
): Issue | undefined {
  if (value === null || typeof value !== "object") {
    return scalar(value)
      ? undefined
      : { path, reason: "Expected a JSON value" };
  }
  if (ancestors.has(value))
    return { path, reason: "JSON cannot contain a reference cycle" };
  const children = members(value);
  if (!children) {
    return { path, reason: "Expected a plain JSON object" };
  }
  ancestors.add(value);
  try {
    for (const [key, child] of children) {
      const issue = invalidJson(child, [...path, key], ancestors);
      if (issue) return issue;
    }
  } finally {
    ancestors.delete(value);
  }
}

/** Validate the JS value without coercing special objects or discarding JSON object keys. */
export const jsonSchema = z.unknown().superRefine((value, ctx) => {
  const issue = invalidJson(value, [], new Set());
  if (issue)
    ctx.addIssue({ code: "custom", path: issue.path, message: issue.reason });
}) as z.ZodType<Json>;

export function parseJson(value: unknown): Json {
  return parseValue(jsonSchema, value);
}

export function parseValue<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code = "content.schema_invalid",
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw appError(code, {
      details: {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.map((key) =>
            typeof key === "number" ? key : String(key),
          ),
          reason: issue.message,
        })),
      },
    });
  }
  return result.data;
}
