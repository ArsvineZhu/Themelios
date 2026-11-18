import {
  createOperations,
  type ApplicationApi,
  type Principal,
} from "@themelios/application";
import {
  createMcpHandler,
  readRequestBody,
  type ServerContext,
} from "@modelcontextprotocol/server";
import {
  serveStdio,
  StdioServerTransport,
} from "@modelcontextprotocol/server/stdio";
import type { CallOptions, Progress } from "@themelios/core";
import {
  errorLocale,
  httpStatus,
  localizedError,
  transportError,
} from "../errors.js";
import { defaultMaxJsonBytes } from "../json.js";
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
  TransportLimits,
} from "../types.js";
import { toolServer } from "./tools.js";

export function createMcpEndpoint<S>(
  api: ApplicationApi<S>,
  options: RemoteTransportOptions,
): HttpEndpoint {
  const directory = createOperations(api);
  const tracker = new RequestTracker();
  type RequestContext = {
    principal: Principal;
    locale: string;
    maxJsonBytes: number;
    call: CallOptions;
  };
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const context = authInfo?.extra?.context as RequestContext | undefined;
      if (!context) throw transportError("transport.auth_required");
      return toolServer(directory, {
        principal: context.principal,
        tracker,
        ...(options.operations ? { operations: options.operations } : {}),
        ...(options.translate ? { translate: options.translate } : {}),
        request(ctx, signal) {
          const inherited = context.call.signal;
          return {
            ...context,
            options: operationCall(ctx, {
              ...context.call,
              signal: inherited ? AbortSignal.any([inherited, signal]) : signal,
            }),
          };
        },
      });
    },
    { maxRequestBodySize: 1024 * 1024 * 1024 },
  );
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
        const context: RequestContext = {
          principal,
          locale,
          maxJsonBytes: policy.maxJsonBytes,
          call: callOptions(request.headers, lease.signal),
        };
        let operation = new Request(request, { signal: lease.signal });
        if (operation.method === "POST") {
          const body = await readRequestBody(operation, policy.maxJsonBytes);
          if (body.tooLarge)
            throw transportError("transport.request_too_large", {
              maxJsonBytes: policy.maxJsonBytes,
            });
          operation = new Request(operation.url, {
            method: operation.method,
            headers: operation.headers,
            body: body.text,
            signal: lease.signal,
          });
        }
        const response = await handler.fetch(operation, {
          authInfo: {
            token: request.headers.get("authorization")?.slice(7) ?? "",
            clientId: principal.id,
            scopes: [...principal.permissions],
            extra: { context },
          },
        });
        return retainResponse(response, lease, cors(origin));
      } catch (error) {
        lease?.close();
        const info = localizedError(error, locale, options.translate);
        const headers = cors(origin);
        if (info.code === "transport.auth_required")
          headers.set("www-authenticate", "Bearer");
        return Response.json(
          { error: info },
          { status: httpStatus(info.code), headers },
        );
      }
    },
    close: () => tracker.close(),
  };
}

export async function serveMcpStdio<S>(
  api: ApplicationApi<S>,
  input: {
    principal: Principal;
    limits?: () => Readonly<TransportLimits>;
    operations?: readonly string[];
    translate?: Translate;
  },
): Promise<{ close(): Promise<void>; closed: Promise<void> }> {
  const directory = createOperations(api);
  const tracker = new RequestTracker();
  const channel = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: 1024 * 1024 * 1024,
  });
  const transport = serveStdio(
    () =>
      toolServer(directory, {
        principal: input.principal,
        tracker,
        ...(input.operations ? { operations: input.operations } : {}),
        ...(input.translate ? { translate: input.translate } : {}),
        request(ctx, signal) {
          const settings = api.configuration.snapshot() as {
            locale?: string;
          } | null;
          return {
            principal: input.principal,
            locale: settings?.locale ?? "zh-CN",
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

function operationCall(ctx: ServerContext, options: CallOptions): CallOptions {
  const token = ctx.mcpReq._meta?.progressToken;
  if (token === undefined) return options;
  let sequence = 0;
  return {
    ...options,
    onProgress(progress: Progress) {
      void ctx.mcpReq
        .notify({
          method: "notifications/progress",
          params: {
            progressToken: token,
            progress: progress.completed ?? ++sequence,
            ...(progress.total === undefined ? {} : { total: progress.total }),
            message: progress.stage,
          },
        })
        .catch(() => undefined);
    },
  };
}
