import { standardOperations } from "@themelios/application";
import type { AnyOperation } from "@themelios/runtime/operations";
import { httpRouteSpecs } from "@themelios/transports/http";
import { z } from "zod";

function describe(operation: AnyOperation) {
  const kind = operation.kind ?? "unary";
  return {
    id: operation.id,
    description: operation.description,
    permission: operation.permission,
    kind,
    http: httpRouteSpecs(operation).map((route) => ({
      ...route,
      body: route.binaryBody
        ? "raw bytes"
        : route.method === "GET" || route.method === "HEAD"
          ? "none"
          : "JSON",
    })),
    mcpTool: kind === "unary" && operation.mcp?.expose !== false,
    grpc: [
      kind === "unary" ? "Invoke" : "Stream",
      ...(operation.binaryInput ? ["Upload"] : []),
    ],
  };
}

const [id, ...extra] = process.argv.slice(2).filter((arg) => arg !== "--");
const operations = standardOperations();
const selected = operations.find((operation) => operation.id === id);
if (extra.length || (id && !selected)) {
  console.error("Usage: bun run operations:describe [operation-id]");
  if (id && !selected) console.error(`Unknown operation: ${id}`);
  process.exitCode = 1;
} else {
  const output = selected
    ? {
        ...describe(selected),
        input: z.toJSONSchema(selected.input, { io: "input" }),
        output: selected.output ? z.toJSONSchema(selected.output) : null,
      }
    : operations.map(describe);
  console.log(JSON.stringify(output, null, 2));
}
