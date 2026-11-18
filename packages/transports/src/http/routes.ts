import type { Context } from "hono";
import { MIMEType } from "node:util";
import type { OperationContext } from "@themelios/application";
import { readJson } from "../json.js";
import { transportError } from "../errors.js";

export type HttpEnvironment = {
  Bindings: { operation: OperationContext & { maxJsonBytes: number } };
};
type Ctx = Context<HttpEnvironment>;
type Route = {
  method: "GET" | "POST";
  path: string;
  id: string;
  input: (context: Ctx) => unknown;
  status?: number;
  kind?: "binary" | "stream";
};

const body = (ctx: Ctx) => {
  const { options, maxJsonBytes } = ctx.env.operation;
  const type = ctx.req.header("content-type");
  if (type && !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(type)) {
    throw transportError("transport.unsupported_media_type");
  }
  return readJson(ctx.req.raw, maxJsonBytes, options.signal!);
};
const ref = (ctx: Ctx) => ({ ref: ctx.req.param("ref") });
const task = (ctx: Ctx) => ({ task: ctx.req.param("id") });
const empty = () => ({});
const taskBody = async (ctx: Ctx) => {
  const value = await body(ctx);
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.hasOwn(value, "task")
  ) {
    throw transportError("transport.invalid_request", {
      reason: "task_path_identity",
    });
  }
  return { ...value, ...task(ctx) };
};
function numericQuery(value: string | undefined, key: string) {
  if (value === undefined) return {};
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number))
    throw transportError("transport.invalid_request", { reason: key });
  return { [key]: number };
}
function textQuery(value: string | undefined, key: string) {
  return value === undefined ? {} : { [key]: value };
}

export const routes: readonly Route[] = [
  { method: "GET", path: "/v1/instance", id: "instance.info", input: empty },
  {
    method: "POST",
    path: "/v1/materials",
    id: "materials.accept",
    status: 201,
    input(ctx) {
      if (!ctx.req.raw.body)
        throw transportError("transport.invalid_request", {
          reason: "body_required",
        });
      return {
        body: ctx.req.raw.body,
        mediaType: mediaType(ctx.req.header("content-type")),
        ...textQuery(ctx.req.query("name"), "name"),
      };
    },
  },
  {
    method: "POST",
    path: "/v1/materials/accept",
    id: "materials.accept",
    input: body,
    status: 201,
  },
  {
    method: "GET",
    path: "/v1/materials/:ref",
    id: "materials.inspect",
    input: ref,
  },
  {
    method: "GET",
    path: "/v1/materials/:ref/content",
    id: "materials.read",
    input: ref,
    kind: "binary",
  },
  {
    method: "POST",
    path: "/v1/materials/text",
    id: "materials.text",
    input: body,
  },
  {
    method: "GET",
    path: "/v1/materials/:ref/structure",
    id: "materials.structure",
    input: ref,
  },
  {
    method: "GET",
    path: "/v1/materials/:ref/sources",
    id: "materials.sources",
    input: (ctx) => ({
      ...ref(ctx),
      ...numericQuery(ctx.req.query("depth"), "depth"),
    }),
  },
  {
    method: "GET",
    path: "/v1/materials",
    id: "materials.list",
    input: (ctx) => ({
      ...textQuery(ctx.req.query("at"), "at"),
      ...textQuery(ctx.req.query("after"), "after"),
      ...numericQuery(ctx.req.query("limit"), "limit"),
    }),
  },
  {
    method: "POST",
    path: "/v1/materials/:ref/retain",
    id: "materials.retain",
    input: ref,
    status: 204,
  },
  {
    method: "POST",
    path: "/v1/materials/:ref/release",
    id: "materials.release",
    input: ref,
    status: 204,
  },
  { method: "GET", path: "/v1/results/:ref", id: "results.read", input: ref },
  {
    method: "POST",
    path: "/v1/results",
    id: "results.save",
    input: body,
    status: 201,
  },
  { method: "GET", path: "/v1/tasks", id: "tasks.list", input: empty },
  { method: "GET", path: "/v1/tasks/:id", id: "tasks.describe", input: task },
  {
    method: "POST",
    path: "/v1/tasks/:id/preview",
    id: "tasks.preview",
    input: taskBody,
  },
  {
    method: "POST",
    path: "/v1/tasks/:id/run",
    id: "tasks.run",
    input: taskBody,
  },
  {
    method: "POST",
    path: "/v1/tasks/:id/stream",
    id: "tasks.stream",
    input: taskBody,
    kind: "stream",
  },
  {
    method: "POST",
    path: "/v1/tasks/run-many",
    id: "tasks.runMany",
    input: body,
  },
  {
    method: "GET",
    path: "/v1/tasks/:id/prompts",
    id: "prompts.read",
    input: task,
  },
  {
    method: "GET",
    path: "/v1/tasks/:id/prompts/describe",
    id: "prompts.describe",
    input: task,
  },
  {
    method: "GET",
    path: "/v1/tasks/:id/prompts/diff",
    id: "prompts.diff",
    input: task,
  },
  {
    method: "POST",
    path: "/v1/tasks/:id/prompts/override",
    id: "prompts.setOverride",
    input: taskBody,
  },
  {
    method: "POST",
    path: "/v1/tasks/:id/prompts/reset",
    id: "prompts.reset",
    input: taskBody,
  },
  {
    method: "GET",
    path: "/v1/configuration",
    id: "configuration.describe",
    input: (ctx) => textQuery(ctx.req.query("path"), "path"),
  },
  {
    method: "POST",
    path: "/v1/configuration/explain",
    id: "configuration.explain",
    input: body,
  },
  {
    method: "POST",
    path: "/v1/configuration/set",
    id: "configuration.set",
    input: body,
  },
  {
    method: "POST",
    path: "/v1/configuration/unset",
    id: "configuration.unset",
    input: body,
  },
  {
    method: "POST",
    path: "/v1/configuration/reload",
    id: "configuration.reload",
    input: body,
  },
];

function mediaType(header: string | undefined): string {
  if (!header) return "application/octet-stream";
  try {
    return new MIMEType(header).essence;
  } catch (cause) {
    throw transportError("transport.unsupported_media_type", undefined, cause);
  }
}
