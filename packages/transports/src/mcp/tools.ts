import {
  callOperation,
  type Operation,
  type OperationContext,
  type Principal,
} from "@themelios/application";
import type { MaterialRead } from "@themelios/content";
import type { Json } from "@themelios/core";
import {
  McpServer,
  ProtocolError,
  ResourceTemplate,
  type CallToolResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { localizedError, transportError } from "../errors.js";
import { checkJsonSize, defaultMaxJsonBytes } from "../json.js";
import type { RequestTracker } from "../request.js";
import type { Translate } from "../types.js";

export type Directory = ReadonlyMap<string, Operation<unknown, unknown>>;
type OperationRequest = OperationContext & { maxJsonBytes: number };
const normalTools = new Set([
  "materials.accept",
  "materials.inspect",
  "materials.text",
  "materials.structure",
  "materials.sources",
  "materials.list",
  "results.read",
  "tasks.list",
  "tasks.describe",
  "tasks.preview",
  "tasks.run",
  "tasks.runMany",
  "configuration.describe",
  "configuration.explain",
]);
const destructive = new Set([
  "materials.release",
  "configuration.set",
  "configuration.unset",
  "prompts.setOverride",
  "prompts.reset",
]);
const errorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.json().optional(),
  traceId: z.string().optional(),
});

export function toolServer(
  directory: Directory,
  input: {
    principal: Principal;
    operations?: readonly string[];
    translate?: Translate;
    tracker: RequestTracker;
    request(ctx: ServerContext, signal: AbortSignal): OperationRequest;
  },
): McpServer {
  const server = new McpServer({ name: "Themelios", version: "0.1.0" });
  const allowed = input.operations ? new Set(input.operations) : normalTools;
  for (const item of directory.values()) {
    if (
      !allowed.has(item.id) ||
      !input.principal.permissions.includes(item.permission) ||
      item.mode !== "unary"
    )
      continue;
    if (item.id === "materials.read") continue;
    const outputSchema = z.strictObject({
      result: item.output.optional(),
      error: errorSchema.optional(),
    });
    server.registerTool(
      toolName(item.id),
      {
        description: item.description ?? item.id,
        inputSchema: item.input,
        outputSchema,
        annotations: {
          readOnlyHint: item.permission === "read",
          destructiveHint: destructive.has(item.id),
          idempotentHint:
            item.permission === "read" ||
            item.id === "materials.retain" ||
            item.id === "materials.release",
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
          const result = (await callOperation(
            directory,
            item.id,
            args,
            request,
          )) as Json;
          const encoded = checkJsonSize(result, request.maxJsonBytes, "result");
          const summary =
            encoded.length > 512 ? encoded.slice(0, 512) + "…" : encoded;
          const content: CallToolResult["content"] = [
            { type: "text", text: summary },
          ];
          if (
            result &&
            typeof result === "object" &&
            !Array.isArray(result) &&
            typeof result.ref === "string" &&
            (item.id === "materials.accept" || item.id === "materials.inspect")
          ) {
            content.push({
              type: "resource_link",
              name: result.ref,
              uri: resourceUri(result.ref),
            });
          }
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
  if (
    input.principal.permissions.includes("read") &&
    (!input.operations || allowed.has("materials.read"))
  ) {
    server.registerResource(
      "material",
      new ResourceTemplate("themelios://materials/{ref}", { list: undefined }),
      {},
      async (uri, variables, ctx) => {
        const lease = input.tracker.take(ctx.mcpReq.signal);
        let locale = "zh-CN";
        try {
          const request = input.request(ctx, lease.signal);
          locale = request.locale;
          const result = (await callOperation(
            directory,
            "materials.read",
            { ref: variables.ref },
            request,
          )) as MaterialRead;
          if (result.info.sizeBytes > request.maxJsonBytes) {
            await result.body.cancel();
            throw transportError("transport.result_too_large", {
              ref: result.info.ref,
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
  return server;
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

function resourceUri(ref: string): string {
  return "themelios://materials/" + encodeURIComponent(ref);
}
