import type { Context } from "hono";
import { MIMEType } from "node:util";
import type {
  AnyOperation,
  HttpMethod,
  HttpRouteSpec,
  OperationContext,
} from "@themelios/runtime/operations";
import { transportError } from "../errors.js";
import { readJson } from "../json.js";

export type HttpEnvironment = {
  Bindings: {
    operation: OperationContext & { maxJsonBytes: number };
    setIdleTimeout?: (seconds: number) => void;
  };
};
export type HttpContext = Context<HttpEnvironment>;

function jsonBody(ctx: HttpContext) {
  const { options, maxJsonBytes } = ctx.env.operation;
  const type = ctx.req.header("content-type");
  if (type && !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(type)) {
    throw transportError("transport.unsupported_media_type");
  }
  return readJson(ctx.req.raw, maxJsonBytes, options.signal!);
}

function mappedParams(
  ctx: HttpContext,
  paramMap?: Readonly<Record<string, string>>,
) {
  if (!paramMap) return {};
  const result: Record<string, string> = {};
  for (const [paramName, fieldName] of Object.entries(paramMap)) {
    const value = ctx.req.param(paramName);
    if (value !== undefined) result[fieldName] = value;
  }
  return result;
}

function numericQuery(ctx: HttpContext, keys?: readonly string[]) {
  const result: Record<string, number> = {};
  if (!keys) return result;
  for (const key of keys) {
    const value = ctx.req.query(key);
    if (value === undefined) continue;
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)) {
      throw transportError("transport.invalid_request", { reason: key });
    }
    result[key] = parsed;
  }
  return result;
}

function stringQuery(ctx: HttpContext, keys?: readonly string[]) {
  const result: Record<string, string> = {};
  if (!keys) return result;
  for (const key of keys) {
    const value = ctx.req.query(key);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function mediaType(header: string | undefined): string | undefined {
  if (!header) return undefined;
  try {
    return new MIMEType(header).essence;
  } catch (cause) {
    throw transportError("transport.unsupported_media_type", undefined, cause);
  }
}

export interface CompiledRoute<App = any> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly operation: AnyOperation<App>;
  readonly status?: number;
  readonly binaryBody?: boolean;
  extractInput(ctx: HttpContext): unknown | Promise<unknown>;
}

function routeFields(ctx: HttpContext, spec: HttpRouteSpec) {
  return {
    ...mappedParams(ctx, spec.paramMap),
    ...stringQuery(ctx, spec.queryStrings),
    ...numericQuery(ctx, spec.queryNumbers),
  };
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw transportError("transport.invalid_request", {
      reason: "object_body_required",
    });
  }
  return value as Record<string, unknown>;
}

function rawBody(ctx: HttpContext) {
  const { body } = ctx.req.raw;
  if (!body)
    throw transportError("transport.invalid_request", {
      reason: "body_required",
    });
  const declared = mediaType(ctx.req.header("content-type"));
  return { body, ...(declared === undefined ? {} : { mediaType: declared }) };
}

function assertPathIdentity(
  data: Record<string, unknown>,
  paramMap: HttpRouteSpec["paramMap"],
) {
  for (const target of Object.values(paramMap ?? {})) {
    if (Object.hasOwn(data, target))
      throw transportError("transport.invalid_request", {
        reason: `${target}_path_identity`,
      });
  }
}

async function readRoute(
  ctx: HttpContext,
  spec: HttpRouteSpec,
): Promise<unknown> {
  const fields = routeFields(ctx, spec);
  if (spec.binaryBody) return { ...fields, ...rawBody(ctx) };
  if (spec.method === "GET" || spec.method === "HEAD") return fields;
  const value = await jsonBody(ctx);
  if (!spec.mergeParamsIntoBody && !Object.keys(fields).length) return value;
  const data = objectBody(value);
  if (spec.mergeParamsIntoBody) assertPathIdentity(data, spec.paramMap);
  return { ...data, ...fields };
}

function fromSpec<App>(
  operation: AnyOperation<App>,
  spec: HttpRouteSpec,
): CompiledRoute<App> {
  return {
    method: spec.method,
    path: spec.path,
    operation,
    ...(spec.binaryBody ? { binaryBody: true } : {}),
    ...(spec.status === undefined ? {} : { status: spec.status }),
    extractInput: (ctx) => readRoute(ctx, spec),
  };
}

/** Resolves explicit and default routes for both registration and discovery. */
export function httpRouteSpecs(
  operation: Pick<AnyOperation, "id" | "http">,
): readonly HttpRouteSpec[] {
  return (
    operation.http ?? [{ method: "POST", path: `/operations/${operation.id}` }]
  );
}

export function compileHttpRoutes<App>(
  operations: Iterable<AnyOperation<App>>,
): CompiledRoute<App>[] {
  const compiled: CompiledRoute<App>[] = [];
  for (const operation of operations) {
    for (const spec of httpRouteSpecs(operation)) {
      compiled.push(fromSpec(operation, spec));
    }
  }
  return compiled;
}
