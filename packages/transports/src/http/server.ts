import {
  callOperation,
  createOperations,
  type ApplicationApi,
} from "@themelios/application";
import type { MaterialRead } from "@themelios/content";
import type { Flow, FlowEvent } from "@themelios/core";
import { Hono } from "hono";
import {
  errorLocale,
  httpStatus,
  localizedError,
  transportError,
} from "../errors.js";
import { checkJsonSize, jsonText } from "../json.js";
import {
  authenticateRequest,
  callOptions,
  cors,
  RequestTracker,
  retainResponse,
  validateWebOrigin,
} from "../request.js";
import type {
  HttpEndpoint,
  RemoteTransportOptions,
  Translate,
} from "../types.js";
import { routes, type HttpEnvironment } from "./routes.js";

const encoder = new TextEncoder();

export function createHttpHandler<S>(
  api: ApplicationApi<S>,
  options: RemoteTransportOptions,
): HttpEndpoint {
  const directory = createOperations(api);
  const tracker = new RequestTracker();
  const app = new Hono<HttpEnvironment>();
  const allow = options.operations && new Set(options.operations);
  app.notFound(() => {
    throw transportError("transport.not_found");
  });
  app.onError((error) => {
    throw error;
  });
  for (const route of routes) {
    if (allow && !allow.has(route.id)) continue;
    app.on(route.method, route.path, async (ctx) => {
      const call = ctx.env.operation;
      const result = callOperation(
        directory,
        route.id,
        await route.input(ctx),
        call,
      );
      if (route.kind === "stream")
        return eventStream(
          result as Flow<unknown>,
          call.maxJsonBytes,
          call.locale,
          options.translate,
        );
      const output = await result;
      if (route.kind === "binary") return download(output as MaterialRead);
      if (route.status === 204) return new Response(null, { status: 204 });
      return new Response(jsonText(output, call.maxJsonBytes), {
        status: route.status ?? 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    });
  }
  return {
    async fetch(request) {
      let lease: ReturnType<RequestTracker["take"]> | undefined;
      let origin: string | null = null;
      const settings = api.configuration.snapshot() as {
        locale?: string;
      } | null;
      const locale = errorLocale(
        request.headers.get("accept-language"),
        settings?.locale,
      );
      try {
        lease = tracker.take(request.signal);
        const policy = options.policy();
        origin = validateWebOrigin(request, policy);
        if (request.method === "OPTIONS")
          return retainResponse(
            new Response(null, { status: 204 }),
            lease,
            cors(origin),
          );
        const principal = await authenticateRequest(
          request.headers,
          options,
          policy,
          lease.signal,
        );
        const context = {
          principal,
          locale,
          options: callOptions(request.headers, lease.signal),
          maxJsonBytes: policy.maxJsonBytes,
        };
        const response = await app.fetch(request, { operation: context });
        return retainResponse(response, lease, cors(origin));
      } catch (error) {
        lease?.close();
        const failure = localizedError(error, locale, options.translate);
        const headers = cors(origin);
        if (failure.code === "transport.auth_required")
          headers.set("www-authenticate", "Bearer");
        return Response.json(
          { error: failure },
          { status: httpStatus(failure.code), headers },
        );
      }
    },
    close: () => tracker.close(),
  };

  function download({ info, body }: MaterialRead) {
    const headers = new Headers({
      "content-type": info.mediaType,
      "x-content-type-options": "nosniff",
    });
    if (Number.isSafeInteger(info.sizeBytes))
      headers.set("content-length", String(info.sizeBytes));
    if (info.name) {
      const name = encodeURIComponent(info.name.toWellFormed()).replace(
        /['()*]/g,
        (symbol) => "%" + symbol.charCodeAt(0).toString(16).toUpperCase(),
      );
      headers.set(
        "content-disposition",
        "attachment; filename*=UTF-8''" + name,
      );
    }
    return new Response(body, { headers });
  }
}

async function eventStream(
  flow: Flow<unknown>,
  maximum: number,
  locale: string,
  translate?: Translate,
): Promise<Response> {
  if (!(Symbol.asyncIterator in flow))
    throw transportError("internal.unexpected");
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
