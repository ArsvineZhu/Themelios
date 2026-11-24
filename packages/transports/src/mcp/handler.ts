import type {
  AgentRefBridge,
  OperationDirectory,
  Principal,
} from "@themelios/runtime/operations";
import {
  createMcpHandler,
  readRequestBody,
  type ServerContext,
} from "@modelcontextprotocol/server";
import type { CallOptions, Progress } from "@themelios/core";
import { transportError } from "../errors.js";
import type { ProtectedHttpContext, RequestTracker } from "../request.js";
import type { McpResourceSpec, Translate } from "../types.js";
import { toolServer } from "./tools.js";

type RequestContext = {
  principal: Principal;
  locale: string;
  maxJsonBytes: number;
  call: CallOptions;
};

export function createMcpHandlerFor<App>(
  app: App,
  directory: OperationDirectory<App>,
  tracker: RequestTracker,
  options: {
    readonly translate?: Translate;
    readonly agentRefs?: (app: App) => AgentRefBridge;
    readonly name?: string;
    readonly resource?: McpResourceSpec;
  } = {},
) {
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const context = authInfo?.extra?.context as RequestContext | undefined;
      if (!context) throw transportError("transport.auth_required");
      return toolServer(app, directory, {
        principal: context.principal,
        tracker,
        ...(options.name ? { name: options.name } : {}),
        ...(options.resource ? { resource: options.resource } : {}),
        ...(options.translate ? { translate: options.translate } : {}),
        ...(options.agentRefs ? { agentRefs: options.agentRefs } : {}),
        request(ctx, signal) {
          const inherited = context.call.signal;
          return {
            principal: context.principal,
            locale: context.locale,
            maxJsonBytes: context.maxJsonBytes,
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

  return async (
    request: Request,
    ctx: ProtectedHttpContext,
  ): Promise<Response> => {
    let operation = new Request(request, { signal: ctx.call.signal });
    if (operation.method === "POST") {
      const body = await readRequestBody(operation, ctx.maxJsonBytes);
      if (body.tooLarge) {
        throw transportError("transport.request_too_large", {
          maxJsonBytes: ctx.maxJsonBytes,
        });
      }
      operation = new Request(operation.url, {
        method: operation.method,
        headers: operation.headers,
        body: body.text,
        signal: ctx.call.signal,
      });
    }
    return handler.fetch(operation, {
      authInfo: {
        token: request.headers.get("authorization")?.slice(7) ?? "",
        clientId: ctx.principal.id,
        scopes: [...ctx.principal.permissions],
        extra: { context: ctx },
      },
    });
  };
}

export function operationCall(
  ctx: ServerContext,
  options: CallOptions,
): CallOptions {
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
