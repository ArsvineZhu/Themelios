import { defineOperation } from "@themelios/runtime/operations";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  createApplicationModule,
  standardOperations,
  type ApplicationApi,
  type ApplicationSettings,
} from "@themelios/application";
import { Installation } from "@themelios/runtime";
import { createSecrets } from "@themelios/runtime/secrets";
import {
  createHttpHandler,
  type RemoteTransportOptions,
} from "@themelios/transports";
import { z } from "zod";

test("HTTP, MCP HTTP, and MCP Stdio share operations, permissions, and Agent readable60 refs", async () => {
  const work = resolve("temp", "work");
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(join(work, "protocol-material-"));
  const app = createApplicationModule({
    id: "test.protocols",
    formatId: "test.protocols",
    resourceRoot: root,
    tasks: [],
  });
  const instance = Installation.at(root, app).instance("default");
  await instance.init();
  const session = await instance.open();
  const writeToken = crypto.randomUUID();
  const readToken = crypto.randomUUID();
  process.env.THEMELIOS_TEST_PROTOCOL_WRITE = writeToken;
  process.env.THEMELIOS_TEST_PROTOCOL_READ = readToken;

  const customEcho = defineOperation<
    ApplicationApi<ApplicationSettings>,
    { text: string },
    { echoed: string; appId: string }
  >({
    id: "custom.echo",
    description: "Echo a string along with the instance application id.",
    permission: "read",
    input: z.strictObject({ text: z.string() }),
    output: z.strictObject({ echoed: z.string(), appId: z.string() }),
    execute: (api, { text }) => ({
      echoed: text,
      appId: api.info().applicationId,
    }),
  });

  const options: RemoteTransportOptions<ApplicationApi<ApplicationSettings>> = {
    enableMcp: true,
    resource: {
      name: "material",
      template: "themelios://materials/{ref}",
      operation: "materials.read",
    },
    operations: [...standardOperations(), customEcho],
    agentRefs: (app: typeof session.api) => ({
      resolveRef: app.materials.resolve,
      formatRef: app.materials.agentRef,
    }),
    policy: () => ({
      maxJsonBytes: 8 * 1024 * 1024,
      allowedHosts: ["127.0.0.1"],
      allowedOrigins: [],
      authTokens: {
        reader: {
          secret: "env:THEMELIOS_TEST_PROTOCOL_READ",
          permissions: ["read"],
        },
        writer: {
          secret: "env:THEMELIOS_TEST_PROTOCOL_WRITE",
          permissions: ["read", "write"],
        },
      },
    }),
    secrets: createSecrets({ baseDir: root }),
  };

  const endpoint = createHttpHandler(session.api, options);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => endpoint.fetch(request),
  });
  const mcpClient = new Client({ name: "themelios-test", version: "0.1.0" });
  const writer = { authorization: "Bearer " + writeToken };
  const reader = { authorization: "Bearer " + readToken };
  let adopted: { ref: string };
  let agentRef = "";

  try {
    const source = "A\r\n中🙂Z";
    const upload = await fetch(
      new URL("/materials?name=original.txt", server.url),
      {
        method: "POST",
        body: source,
        headers: { ...writer, "content-type": "text/plain" },
      },
    );
    expect(upload.status).toBe(201);
    adopted = (await upload.json()) as { ref: string };
    expect(adopted.ref).toMatch(/^art_[a-f0-9-]{36}$/);

    const forbidden = await fetch(
      new URL("/materials?name=denied.txt", server.url),
      {
        method: "POST",
        body: source,
        headers: { ...reader, "content-type": "text/plain; charset=utf-8" },
      },
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      error: { code: "transport.access_denied" },
    });

    const original = await fetch(
      new URL("/materials/" + adopted.ref + "/content", server.url),
      { headers: reader },
    );
    expect(await original.text()).toBe(source);

    const badRange = await fetch(new URL("/materials/text", server.url), {
      method: "POST",
      headers: { ...reader, "content-type": "application/json" },
      body: JSON.stringify({
        ref: adopted.ref,
        range: { kind: "text", start: 4, end: 6 },
      }),
    });
    expect(badRange.status).toBe(400);
    const rangeErr = (await badRange.json()) as {
      error: { code: string; traceId?: string };
    };
    expect(rangeErr.error.code).toBe("content.range_invalid");
    expect(rangeErr.error.traceId).toMatch(/^[a-f0-9]{32}$/);

    const echoHttp = await fetch(
      new URL("/operations/custom.echo", server.url),
      {
        method: "POST",
        headers: { ...reader, "content-type": "application/json" },
        body: JSON.stringify({ text: "hello-ops" }),
      },
    );
    expect(echoHttp.status).toBe(200);
    expect(await echoHttp.json()).toEqual({
      echoed: "hello-ops",
      appId: "test.protocols",
    });

    const inline = {
      bytes: Buffer.from("real inline bytes").toString("base64"),
      mediaType: "text/plain",
      name: "inline.txt",
    };
    const producer = {
      kind: "application" as const,
      name: "protocol-fixture",
    };
    const upstream = {
      value: null,
      producer,
      inputs: [],
      files: [{ name: "output", material: inline, sourceIndices: [] }],
    };
    const savedResp = await fetch(new URL("/results", server.url), {
      method: "POST",
      headers: { ...writer, "content-type": "application/json" },
      body: JSON.stringify({
        value: null,
        producer,
        files: [],
        inputs: [
          {
            role: "primary",
            source: { resultOutput: { result: upstream, output: "output" } },
            delivered: [{ inline }],
          },
        ],
      }),
    });
    expect(savedResp.status).toBe(201);
    const saved = (await savedResp.json()) as { ref: string };
    const readSaved = await fetch(
      new URL("/results/" + saved.ref, server.url),
      { headers: reader },
    );
    expect(readSaved.status).toBe(200);
    const adoptedGraph = await session.api.results.read(saved.ref);
    expect(adoptedGraph.value).toBeNull();
    expect(adoptedGraph.inputs[0]?.source.ref).toMatch(/^art_/);
    expect(
      await session.api.materials.text(adoptedGraph.inputs[0]!.source),
    ).toBe("real inline bytes");

    await mcpClient.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", server.url), {
        requestInit: { headers: reader },
      }),
    );
    const tools = await mcpClient.listTools();
    expect(tools.tools.some((tool) => tool.name === "materials_accept")).toBe(
      false,
    );
    expect(tools.tools.some((tool) => tool.name === "custom_echo")).toBe(true);
    expect(
      tools.tools.find((tool) => tool.name === "materials_inspect")?.inputSchema
        .properties,
    ).toHaveProperty("ref");

    const inspected = await mcpClient.callTool({
      name: "materials_inspect",
      arguments: adopted,
    });
    const inspectedResult = (
      inspected.structuredContent as {
        result: { ref: string; name: string };
      }
    ).result;
    agentRef = inspectedResult.ref;
    expect(agentRef).toMatch(/^art_[a-z]{24}$/);
    expect(agentRef).not.toBe(adopted.ref);
    expect(inspectedResult.name).toBe("original.txt");

    const textViaAgentRef = await mcpClient.callTool({
      name: "materials_text",
      arguments: { ref: agentRef },
    });
    expect(textViaAgentRef.structuredContent).toEqual({
      result: { text: source },
    });

    const resource = await mcpClient.readResource({
      uri: `themelios://materials/${agentRef}`,
    });
    expect(resource.contents[0]).toMatchObject({
      mimeType: "text/plain",
      text: source,
    });

    const echoMcp = await mcpClient.callTool({
      name: "custom_echo",
      arguments: { text: agentRef },
    });
    expect(echoMcp.structuredContent).toEqual({
      result: { echoed: agentRef, appId: "test.protocols" },
    });
  } finally {
    await mcpClient.close();
    await endpoint.close();
    await server.stop(true);
    await session.close();
    delete process.env.THEMELIOS_TEST_PROTOCOL_WRITE;
    delete process.env.THEMELIOS_TEST_PROTOCOL_READ;
  }

  const stdio = new Client({ name: "themelios-test", version: "0.1.0" });
  try {
    await stdio.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(import.meta.dir, "stdio-host.ts"), root],
      }),
    );
    const viaStdio = await stdio.callTool({
      name: "materials_inspect",
      arguments: { ref: agentRef },
    });
    expect(viaStdio.structuredContent).toMatchObject({
      result: { ref: agentRef, name: "original.txt" },
    });
  } finally {
    await stdio.close();
  }
}, 20_000);
