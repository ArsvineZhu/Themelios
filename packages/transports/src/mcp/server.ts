import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import { resolveDirectory } from "../directory.js";
import { defaultMaxJsonBytes } from "../json.js";
import { defaultLocale } from "@themelios/runtime/locales";
import { RequestTracker, runProtectedHttp } from "../request.js";
import type {
  HttpEndpoint,
  McpStdioOptions,
  RemoteTransportOptions,
} from "../types.js";
import { createMcpHandlerFor, operationCall } from "./handler.js";
import { toolServer } from "./tools.js";

export function createMcpEndpoint<App>(
  app: App,
  options: RemoteTransportOptions<App>,
): HttpEndpoint {
  const directory = resolveDirectory(
    options.operations,
    options.allowOperations,
  );
  const tracker = new RequestTracker();
  const handleMcp = createMcpHandlerFor(app, directory, tracker, {
    ...(options.name ? { name: options.name } : {}),
    ...(options.resource ? { resource: options.resource } : {}),
    ...(options.translate ? { translate: options.translate } : {}),
    ...(options.agentRefs ? { agentRefs: options.agentRefs } : {}),
  });
  return {
    fetch(request) {
      const defaultLocale = options.locale?.();
      return runProtectedHttp(
        request,
        tracker,
        options,
        defaultLocale,
        "GET, POST, DELETE, OPTIONS",
        (ctx) => handleMcp(request, ctx),
      );
    },
    close: () => tracker.close(),
  };
}

export async function serveMcpStdio<App>(
  app: App,
  input: McpStdioOptions<App>,
): Promise<{ close(): Promise<void>; closed: Promise<void> }> {
  const directory = resolveDirectory(input.operations, input.allowOperations);
  const tracker = new RequestTracker();
  const channel = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 1024 * 1024 * 1024,
  });
  const transport = serveStdio(
    () =>
      toolServer(app, directory, {
        principal: input.principal,
        tracker,
        ...(input.name ? { name: input.name } : {}),
        ...(input.resource ? { resource: input.resource } : {}),
        ...(input.translate ? { translate: input.translate } : {}),
        ...(input.agentRefs ? { agentRefs: input.agentRefs } : {}),
        request(ctx, signal) {
          const locale = input.locale?.() ?? defaultLocale;
          return {
            principal: input.principal,
            locale,
            maxJsonBytes: input.limits?.().maxJsonBytes ?? defaultMaxJsonBytes,
            options: operationCall(ctx, { signal }),
          };
        },
      }),
    { transport: channel },
  );
  let closing: Promise<void> | undefined;
  const closed = Promise.withResolvers<void>();
  const close = () => {
    process.stdin.removeListener("end", end);
    closing ??= Promise.all([tracker.close(), transport.close()]).then(
      () => undefined,
    );
    return closing.then(closed.resolve, (error) => {
      closed.reject(error);
      throw error;
    });
  };
  const end = () => {
    void close().catch(() => undefined);
  };
  const transportClosed = channel.onclose;
  channel.onclose = () => {
    transportClosed?.();
    queueMicrotask(end);
  };
  process.stdin.once("end", end);
  return { close, closed: closed.promise };
}
