import { appError, type MessageParams } from "@themelios/core";
import type {
  EndpointPublication,
  Endpoints,
  Session,
} from "@themelios/runtime";
import { z } from "zod";
import { startGrpcServer } from "./grpc/index.js";
import { createHttpHandler } from "./http/server.js";
import { serveMcpStdio } from "./mcp/server.js";
import type {
  GrpcListener,
  McpStdioOptions,
  RemoteOperationOptions,
  RemoteTransportOptions,
} from "./types.js";

const maxHttpIdleTimeoutSeconds = 255;
export const httpIdleTimeoutSecondsSchema = z
  .int()
  .min(0)
  .max(maxHttpIdleTimeoutSeconds)
  .default(180);

export interface ApplicationListeners<App> {
  signal?: AbortSignal;
  http?: {
    address: { host: string; port: number };
    options: RemoteTransportOptions<App>;
    idleTimeoutSeconds?: number;
  };
  grpc?: GrpcListener & { options: RemoteOperationOptions<App> };
  stdio?: McpStdioOptions<App>;
  ready?: (endpoints: Endpoints) => void;
}

async function openHttp<App>(
  app: App,
  listener: NonNullable<ApplicationListeners<App>["http"]>,
  defaults: Pick<
    RemoteTransportOptions<App>,
    "translate" | "languages" | "locale"
  >,
) {
  const { address, options } = listener;
  const idle = httpIdleTimeoutSecondsSchema.parse(listener.idleTimeoutSeconds);
  const handler = createHttpHandler(app, { ...defaults, ...options });
  try {
    const server = Bun.serve({
      hostname: address.host,
      port: address.port,
      idleTimeout: idle,
      maxRequestBodySize: Number.MAX_SAFE_INTEGER,
      fetch(request, server) {
        return handler.fetch(request, (seconds) => {
          if (idle > 0 && (seconds === 0 || seconds > idle))
            server.timeout(
              request,
              seconds > maxHttpIdleTimeoutSeconds ? 0 : seconds,
            );
        });
      },
    });
    const endpoints = {
      http: server.url.href,
      ...(options.enableMcp ? { mcp: new URL("/mcp", server.url).href } : {}),
    };
    return {
      endpoints,
      async close() {
        await Promise.all([server.stop(true), handler.close()]);
      },
    };
  } catch (error) {
    await handler.close();
    throw error;
  }
}

interface OpenListener {
  readonly endpoints: Endpoints;
  readonly closed?: Promise<void>;
  close(): void | Promise<void>;
}

/** Opens transports one at a time so the host can own each before starting the next. */
async function* openListeners<App, S>(
  session: Session<App, S>,
  options: ApplicationListeners<App>,
): AsyncGenerator<OpenListener> {
  const translate = (locale: string, key: string, params?: MessageParams) =>
    session.localize(key, params, locale);
  const locale = () => session.locale;
  const defaults = { translate, locale, languages: session.languages };
  if (options.stdio) {
    const stdio = await serveMcpStdio(session.api, {
      translate,
      locale,
      ...options.stdio,
    });
    yield {
      endpoints: { mcp: "stdio" },
      closed: stdio.closed,
      close: () => stdio.close(),
    };
  }
  if (options.http) yield await openHttp(session.api, options.http, defaults);
  if (options.grpc) {
    const { options: grpc, ...listen } = options.grpc;
    const listener = await startGrpcServer(session.api, listen, {
      ...defaults,
      ...grpc,
    });
    yield {
      endpoints: { grpc: listener.address },
      close: () => listener.close(),
    };
  }
}

/** Serves and closes the configured listeners. The caller owns the supplied session. */
export async function serveApplication<App, S>(
  session: Session<App, S>,
  options: ApplicationListeners<App>,
): Promise<void> {
  const signal = options.signal;
  if (signal?.aborted) return;
  const endpoints: Record<string, string> = {};
  const close: Array<() => void | Promise<void>> = [];
  const done = Promise.withResolvers<{ error?: unknown }>();
  let stopping = false;
  let publication: EndpointPublication | undefined;
  const stop = (result: { error?: unknown } = {}) => {
    stopping = true;
    done.resolve(result);
  };
  const abort = () => stop();
  signal?.addEventListener("abort", abort, { once: true });
  let hostingError: unknown;
  let cleanupErrors: unknown[] = [];
  try {
    for await (const listener of openListeners(session, options)) {
      close.push(() => listener.close());
      Object.assign(endpoints, listener.endpoints);
      void listener.closed?.then(abort, (error) => stop({ error }));
      if (stopping) break;
    }
    if (!stopping) {
      if (!close.length) {
        throw appError("transport.invalid_request", {
          details: { reason: "No listener configured" },
        });
      }
      publication = await session.publishEndpoints(endpoints);
      if (!stopping) options.ready?.(endpoints);
    }
    const result = await done.promise;
    if ("error" in result) throw result.error;
  } catch (error) {
    hostingError = error;
  } finally {
    signal?.removeEventListener("abort", abort);
    const shutdown = await Promise.allSettled(
      close.reverse().map(async (cleanup) => cleanup()),
    );
    cleanupErrors = shutdown.flatMap((item) =>
      item.status === "rejected" ? [item.reason] : [],
    );
    await publication?.close().catch((error) => cleanupErrors.push(error));
  }
  if (hostingError && !cleanupErrors.length) throw hostingError;
  if (hostingError) cleanupErrors.unshift(hostingError);
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, "Transport shutdown failed");
}
