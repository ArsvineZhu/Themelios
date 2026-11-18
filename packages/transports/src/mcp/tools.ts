import {
  callOperation,
  type AgentRefBridge,
  type BinaryReadResult,
  type Operation,
  type OperationDirectory,
  type Principal,
} from "@themelios/runtime/operations";
import { jsonSchema, type Json } from "@themelios/core";
import {
  McpServer,
  ProtocolError,
  ResourceTemplate,
  type CallToolResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { agentSchema } from "./agent-schema.js";
import { localizedError, transportError } from "../errors.js";
import { checkJsonSize, defaultMaxJsonBytes } from "../json.js";
import type { RequestTracker } from "../request.js";
import type { McpResourceSpec, Translate } from "../types.js";

const errorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: jsonSchema.optional(),
  traceId: z.string().optional(),
});

export interface ToolServerOptions<App> {
  readonly principal: Principal;
  readonly translate?: Translate;
  readonly tracker: RequestTracker;
  readonly agentRefs?: (app: App) => AgentRefBridge;
  readonly name?: string;
  readonly resource?: McpResourceSpec;
  request(
    ctx: ServerContext,
    signal: AbortSignal,
  ): {
    readonly principal: Principal;
    readonly locale: string;
    readonly options: import("@themelios/core").CallOptions;
    readonly maxJsonBytes: number;
  };
}

export function toolServer<App>(
  app: App,
  directory: OperationDirectory<App>,
  input: ToolServerOptions<App>,
): McpServer {
  const server = new McpServer({
    name: input.name ?? "application",
    version: "0.1.0",
  });
  const bridge = input.agentRefs?.(app);
  const resource = input.resource;
  const readable = resource && directory.get(resource.operation);
  const canReadResource =
    readable?.kind === "binary-read" &&
    input.principal.permissions.includes(readable.permission);

  for (const item of directory.values()) {
    if (
      (item.kind ?? "unary") === "unary" &&
      item.mcp?.expose !== false &&
      input.principal.permissions.includes(item.permission)
    ) {
      registerOperation(
        server,
        app,
        directory,
        input,
        item,
        bridge,
        canReadResource ? resource : undefined,
      );
    }
  }
  if (resource && canReadResource)
    registerResource(server, app, directory, input, resource, bridge);
  return server;
}

function registerOperation<App>(
  server: McpServer,
  app: App,
  directory: OperationDirectory<App>,
  input: ToolServerOptions<App>,
  item: Operation<App, unknown, unknown>,
  bridge?: AgentRefBridge,
  resource?: McpResourceSpec,
) {
  const outputSchema = z.strictObject({
    result: (item.output ?? jsonSchema).optional(),
    error: errorSchema.optional(),
  });
  const requestSchema = agentSchema(
    item.mcp?.input ?? item.input,
    "input",
    bridge,
  );
  const responseSchema = agentSchema(outputSchema, "output", bridge);
  server.registerTool(
    toolName(item.id),
    {
      description: item.description || item.id,
      inputSchema: requestSchema.advertised,
      outputSchema: responseSchema.advertised,
      annotations: {
        readOnlyHint: item.mcp?.readOnlyHint ?? item.permission === "read",
        destructiveHint: item.mcp?.destructiveHint ?? false,
        idempotentHint: item.mcp?.idempotentHint ?? item.permission === "read",
      },
    },
    async (args, ctx) => {
      let lease: ReturnType<RequestTracker["take"]> | undefined;
      let locale = "zh-CN";
      try {
        lease = input.tracker.take(ctx.mcpReq.signal);
        const request = input.request(ctx, lease.signal);
        locale = request.locale;
        checkJsonSize(args, request.maxJsonBytes, "request");
        const canonicalArgs = requestSchema.convert(args);
        const rawResult = await callOperation(
          app,
          directory,
          item.id,
          canonicalArgs,
          request,
        );
        const result = (
          responseSchema.convert({ result: rawResult }) as { result: Json }
        ).result as Json;
        const encoded = checkJsonSize(result, request.maxJsonBytes, "result");
        const summary =
          encoded.length > 512 ? encoded.slice(0, 512) + "…" : encoded;
        const content: CallToolResult["content"] = [
          { type: "text", text: summary },
        ];
        appendResourceLink(content, resource, item.id, result);
        return envelope({ result }, content, request.maxJsonBytes);
      } catch (error) {
        const info = localizedError(error, locale, input.translate);
        return envelope({ error: info }, [
          { type: "text", text: info.message },
        ]);
      } finally {
        lease?.close();
      }
    },
  );
}

function appendResourceLink(
  content: CallToolResult["content"],
  resource: McpResourceSpec | undefined,
  id: string,
  result: Json,
) {
  if (!resource?.linksFrom?.includes(id)) return;
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    typeof result.ref !== "string"
  )
    return;
  content.push({
    type: "resource_link",
    name: result.ref,
    uri: resource.template.replace("{ref}", encodeURIComponent(result.ref)),
  });
}

function registerResource<App>(
  server: McpServer,
  app: App,
  directory: OperationDirectory<App>,
  input: ToolServerOptions<App>,
  resource: McpResourceSpec,
  bridge?: AgentRefBridge,
) {
  server.registerResource(
    resource.name,
    new ResourceTemplate(resource.template, { list: undefined }),
    {},
    async (uri, variables, ctx) => {
      const lease = input.tracker.take(ctx.mcpReq.signal);
      let locale = "zh-CN";
      try {
        const request = input.request(ctx, lease.signal);
        locale = request.locale;
        const rawRef = String(variables.ref);
        const resolvedRef = bridge ? bridge.resolveRef(rawRef) : rawRef;
        const result = (await callOperation(
          app,
          directory,
          resource.operation,
          { ref: resolvedRef },
          request,
        )) as BinaryReadResult;
        if (result.info.sizeBytes > request.maxJsonBytes) {
          await result.body.cancel();
          throw transportError("transport.result_too_large", {
            ...(result.info.ref
              ? {
                  ref: bridge
                    ? bridge.formatRef(result.info.ref)
                    : result.info.ref,
                }
              : {}),
            maxJsonBytes: request.maxJsonBytes,
          });
        }
        const bytes = new Uint8Array(
          await new Response(result.body).arrayBuffer(),
        );
        const payload = result.info.mediaType.startsWith("text/")
          ? { text: new TextDecoder().decode(bytes) }
          : { blob: Buffer.from(bytes).toString("base64") };
        const response = {
          contents: [
            { uri: uri.href, mimeType: result.info.mediaType, ...payload },
          ],
        };
        checkJsonSize(response, request.maxJsonBytes, "result");
        return response;
      } catch (error) {
        const info = localizedError(error, locale, input.translate);
        throw new ProtocolError(-32000, info.message, info);
      } finally {
        lease.close();
      }
    },
  );
}

function envelope(
  data: { result?: Json; error?: ReturnType<typeof localizedError> },
  content: CallToolResult["content"],
  max = defaultMaxJsonBytes,
): CallToolResult {
  if (Object.hasOwn(data, "result") === Object.hasOwn(data, "error")) {
    throw transportError("internal.unexpected");
  }
  if (data.error)
    return { isError: true, structuredContent: { error: data.error }, content };
  const result: CallToolResult = {
    structuredContent: { result: data.result },
    content,
  };
  checkJsonSize(result, max, "result");
  return result;
}

function toolName(id: string): string {
  return id
    .replaceAll(".", "_")
    .replace(/[A-Z]/g, (letter) => "_" + letter.toLowerCase());
}
