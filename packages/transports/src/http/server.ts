import {
  assertOperationPermission,
  callOperation,
  type BinaryReadResult,
} from "@themelios/runtime/operations";
import type { Flow, FlowEvent } from "@themelios/core";
import { Hono } from "hono";
import { resolveDirectory } from "../directory.js";
import { localizedError, transportError } from "../errors.js";
import { checkJsonSize, jsonText } from "../json.js";
import { createMcpHandlerFor } from "../mcp/handler.js";
import { RequestTracker, runProtectedHttp } from "../request.js";
import type {
  HttpEndpoint,
  RemoteTransportOptions,
  Translate,
} from "../types.js";
import { compileHttpRoutes, type HttpEnvironment } from "./routes.js";

export { httpRouteSpecs } from "./routes.js";

const encoder = new TextEncoder();

export function createHttpHandler<App>(
  app: App,
  options: RemoteTransportOptions<App>,
): HttpEndpoint {
  const directory = resolveDirectory(
    options.operations,
    options.allowOperations,
  );
  const tracker = new RequestTracker();
  const router = new Hono<HttpEnvironment>();
  const mcpHandler = options.enableMcp
    ? createMcpHandlerFor(app, directory, tracker, {
        ...(options.name ? { name: options.name } : {}),
        ...(options.resource ? { resource: options.resource } : {}),
        ...(options.translate ? { translate: options.translate } : {}),
        ...(options.agentRefs ? { agentRefs: options.agentRefs } : {}),
      })
    : undefined;

  router.notFound(() => {
    throw transportError("transport.not_found");
  });
  router.onError((error) => {
    throw error;
  });

  const routes = compileHttpRoutes(directory.values());
  const methods = new Set(routes.map(({ method }) => method));
  if (methods.has("GET")) methods.add("HEAD");
  if (mcpHandler)
    for (const method of ["GET", "POST", "DELETE"] as const) {
      methods.add(method);
    }
  const corsMethods = [...methods, "OPTIONS"].join(", ");
  for (const route of routes) {
    router.on(route.method, route.path, async (ctx) => {
      const call = ctx.env.operation;
      assertOperationPermission(route.operation, call.principal);
      const outcome = callOperation(
        app,
        directory,
        route.operation.id,
        await route.extractInput(ctx),
        call,
        route.binaryBody ? { input: "binary" } : undefined,
      );
      if (outcome.kind === "stream") {
        ctx.env.setIdleTimeout?.(0);
        return eventStream(
          outcome.flow,
          call.maxJsonBytes,
          call.locale,
          options.translate,
        );
      }
      if (outcome.kind === "binary-read") {
        return download(await outcome.result);
      }
      const output = await outcome.result;
      if (route.status === 204) return new Response(null, { status: 204 });
      return new Response(jsonText(output, call.maxJsonBytes), {
        status: route.status ?? 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    });
  }

  return {
    fetch(request, setIdleTimeout) {
      const defaultLocale = options.locale?.();
      return runProtectedHttp(
        request,
        tracker,
        options,
        defaultLocale,
        corsMethods,
        (ctx) => {
          if (ctx.call.timeoutMs !== undefined) {
            setIdleTimeout?.(Math.ceil(ctx.call.timeoutMs / 1000) + 1);
          }
          if (mcpHandler && new URL(request.url).pathname === "/mcp") {
            if (request.method === "GET") setIdleTimeout?.(0);
            return mcpHandler(request, ctx);
          }
          return Promise.resolve(
            router.fetch(request, {
              operation: {
                principal: ctx.principal,
                locale: ctx.locale,
                options: ctx.call,
                maxJsonBytes: ctx.maxJsonBytes,
              },
              ...(setIdleTimeout ? { setIdleTimeout } : {}),
            }),
          );
        },
      );
    },
    close: () => tracker.close(),
  };
}

function download({ info, body }: BinaryReadResult) {
  const headers = new Headers({
    "content-type": info.mediaType,
    "x-content-type-options": "nosniff",
  });
  if (Number.isSafeInteger(info.sizeBytes)) {
    headers.set("content-length", String(info.sizeBytes));
  }
  if (info.name) {
    const name = encodeURIComponent(info.name.toWellFormed()).replace(
      /['()*]/g,
      (symbol) => "%" + symbol.charCodeAt(0).toString(16).toUpperCase(),
    );
    headers.set("content-disposition", "attachment; filename*=UTF-8''" + name);
  }
  return new Response(body, { headers });
}

async function eventStream(
  flow: Flow<unknown>,
  maximum: number,
  locale: string,
  translate?: Translate,
): Promise<Response> {
  if (!(Symbol.asyncIterator in flow)) {
    throw transportError("internal.unexpected");
  }
  const iterator = flow[Symbol.asyncIterator]();
  let ended = false;
  async function stop(cancel: boolean) {
    if (ended) return;
    ended = true;
    if (cancel) flow.cancel("request closed");
    await iterator.return?.();
  }
  function event(value: FlowEvent<unknown>) {
    const data =
      value.type === "progress"
        ? value.progress
        : value.type === "text-delta"
          ? { text: value.text }
          : value.value;
    return encoder.encode(
      `event: ${value.type}\ndata: ${checkJsonSize(data, maximum, "result")}\n\n`,
    );
  }
  let first: Uint8Array | undefined;
  try {
    const next = await iterator.next();
    if (next.done) throw transportError("internal.unexpected");
    first = event(next.value);
  } catch (error) {
    await stop(true).catch(() => undefined);
    throw error;
  }
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (first) {
          controller.enqueue(first);
          first = undefined;
          return;
        }
        try {
          const next = await iterator.next();
          if (!next.done) {
            controller.enqueue(event(next.value));
            return;
          }
          await stop(false);
          controller.close();
        } catch (error) {
          if (ended) return;
          await stop(true).catch(() => undefined);
          const info = localizedError(error, locale, translate);
          controller.enqueue(
            encoder.encode(
              "event: error\ndata: " + JSON.stringify(info) + "\n\n",
            ),
          );
          controller.close();
        }
      },
      cancel() {
        return stop(true);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}
