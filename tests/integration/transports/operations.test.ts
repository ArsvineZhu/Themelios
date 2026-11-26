import { expect, test } from "bun:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { defineOperation } from "@themelios/runtime/operations";
import { createSecrets } from "@themelios/runtime/secrets";
import { createHttpHandler } from "@themelios/transports";
import { z } from "zod";

test("an MCP operation uses its selected input contract and encodes its result once", async () => {
  const units = z.codec(z.string().regex(/^\d+$/), z.int(), {
    decode: Number,
    encode: String,
  });
  const input = z.strictObject({ units });
  const result = z.strictObject({
    units: z.codec(z.int(), z.string(), { decode: String, encode: Number }),
  });
  const alternate = z.strictObject({ count: units }).transform(({ count }) => ({
    units: count,
  }));
  const measure = defineOperation<object>()({
    id: "measure.units",
    description: "Double the supplied number of units.",
    permission: "read",
    input,
    output: result,
    execute: (_app, { units }) => ({ units: units * 2 }),
  });
  const count = defineOperation<object>()({
    ...measure,
    id: "measure.count",
    mcp: { input: alternate },
  });
  const endpoint = createHttpHandler(
    {},
    {
      operations: [measure, count],
      enableMcp: true,
      policy: () => ({
        maxJsonBytes: 65536,
        allowedHosts: ["127.0.0.1"],
        allowedOrigins: [],
        authTokens: {},
      }),
      authenticate: async () => ({ id: "tester", permissions: ["read"] }),
      secrets: createSecrets({ baseDir: process.cwd() }),
    },
  );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => endpoint.fetch(request),
  });
  const client = new Client({ name: "operation-test", version: "0.1.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", server.url)),
    );
    const tools = await client.listTools();
    expect(
      tools.tools.find((tool) => tool.name === "measure_count")?.inputSchema
        .required,
    ).toEqual(["count"]);

    const response = await fetch(
      new URL("/operations/measure.count", server.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ units: "7" }),
      },
    );
    expect(await response.json()).toEqual({ units: "14" });
    expect(
      await client.callTool({
        name: "measure_units",
        arguments: { units: "7" },
      }),
    ).toMatchObject({ structuredContent: { result: { units: "14" } } });
    expect(
      await client.callTool({
        name: "measure_count",
        arguments: { count: "7" },
      }),
    ).toMatchObject({ structuredContent: { result: { units: "14" } } });
    expect(
      await client.callTool({
        name: "measure_count",
        arguments: { units: "7" },
      }),
    ).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "transport.invalid_request" } },
    });
  } finally {
    await client.close();
    await Promise.all([server.stop(true), endpoint.close()]);
  }
});
