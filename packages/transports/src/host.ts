import { appError, type MessageParams } from "@themelios/core";
import type { Session } from "@themelios/runtime";
import { createHttpHandler } from "./http/server.js";
import { serveMcpStdio } from "./mcp/server.js";
import type { McpStdioOptions, RemoteTransportOptions } from "./types.js";

export async function serveApplication<App, S>(
  session: Session<App, S>,
  options: {
    signal?: AbortSignal;
    http?: {
      address: { host: string; port: number };
      options: RemoteTransportOptions<App>;
    };
    stdio?: McpStdioOptions<App>;
    ready?: (endpoints: Readonly<Record<string, string>>) => void;
  },
): Promise<void> {
  const signal = options.signal;
  const translate = (locale: string, key: string, params?: MessageParams) =>
    session.localize(key, params, locale);
  const endpoints: Record<string, string> = {};
  const close: Array<() => void | Promise<void>> = [];
  const done = Promise.withResolvers<void>();
  const abort = () => done.resolve();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    abort();
    return;
  }
  let hostingError: unknown;
  let cleanupErrors: unknown[] = [];
  try {
    if (options.stdio) {
      const stdio = await serveMcpStdio(session.api, {
        translate,
        ...options.stdio,
      });
      close.push(() => stdio.close());
      endpoints.mcp = "stdio";
      void stdio.closed.then(abort, done.reject);
    }
    if (options.http) {
      const { address, options: http } = options.http;
      const handler = createHttpHandler(session.api, { translate, ...http });
      close.push(() => handler.close());
      const listener = Bun.serve({
        hostname: address.host,
        port: address.port,
        maxRequestBodySize: Number.MAX_SAFE_INTEGER,
        fetch: handler.fetch,
      });
      close.push(() => listener.stop(true));
      endpoints.http = listener.url.href;
      if (http.enableMcp) endpoints.mcp = new URL("/mcp", listener.url).href;
    }
    if (!options.http && !options.stdio) {
      throw appError("transport.invalid_request", {
        details: { reason: "No listener configured" },
      });
    }
    await session.setEndpoints(endpoints);
    options.ready?.(endpoints);
    await done.promise;
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
  }
  if (hostingError && !cleanupErrors.length) throw hostingError;
  if (hostingError) cleanupErrors.unshift(hostingError);
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, "Transport shutdown failed");
}
