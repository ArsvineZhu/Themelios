import { expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fromJson } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createApplicationModule } from "@themelios/application";
import { Installation } from "@themelios/runtime";
import { createSecrets } from "@themelios/runtime/secrets";
import {
  ApplicationService,
  createHttpHandler,
  createMcpEndpoint,
  FailureSchema,
  startGrpcServer,
} from "@themelios/transports";
import type { RemoteTransportOptions } from "@themelios/transports";

test("HTTP, gRPC, and MCP clients consume the same adopted bytes under the same permissions", async () => {
  const work = resolve("temp", "work");
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(join(work, "protocol-material-"));
  const app = createApplicationModule({
    id: "test.protocols",
    formatId: "test.protocols/1",
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
  const options: RemoteTransportOptions = {
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
  const http = createHttpHandler(session.api, options);
  const mcp = createMcpEndpoint(session.api, options);
  const grpc = await startGrpcServer(session.api, {
    ...options,
    hostname: "127.0.0.1",
    port: 0,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/mcp"
        ? mcp.fetch(request)
        : http.fetch(request),
  });
  const mcpClient = new Client({ name: "themelios-test", version: "0.1.0" });
  const grpcClient = createClient(
    ApplicationService,
    createGrpcTransport({ baseUrl: grpc.address }),
  );
  const writer = { authorization: "Bearer " + writeToken };
  const reader = { authorization: "Bearer " + readToken };
  let adopted: { ref: string };
  try {
    const source = "A\r\n中🙂Z";
    const upload = await fetch(
      new URL("/v1/materials?name=original.txt", server.url),
      {
        method: "POST",
        body: source,
        headers: { ...writer, "content-type": "text/plain" },
      },
    );
    expect(upload.status).toBe(201);
    adopted = (await upload.json()) as { ref: string };
    const ref = adopted.ref;
    const forbidden = await fetch(
      new URL("/v1/materials?name=denied.txt", server.url),
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
      new URL("/v1/materials/" + ref + "/content", server.url),
      { headers: reader },
    );
    expect(await original.text()).toBe(source);

    expect(
      (await grpcClient.inspectMaterial({ ref }, { headers: reader })).ref,
    ).toBe(ref);
    const bytes = Uint8Array.of(9, 7, 5, 3);
    async function* chunks() {
      yield {
        part: {
          case: "metadata" as const,
          value: { mediaType: "application/octet-stream" },
        },
      };
      yield { part: { case: "chunk" as const, value: bytes } };
    }
    const adoptedGrpc = await grpcClient.uploadMaterial(chunks(), {
      headers: writer,
    });
    const packets = await Array.fromAsync(
      grpcClient.readMaterial({ ref: adoptedGrpc.ref }, { headers: reader }),
    );
    expect(packets.map((packet) => packet.part.case)).toEqual([
      "info",
      "chunk",
    ]);
    expect(packets[1]?.part.value).toEqual(bytes);
    const denied = await grpcClient
      .uploadMaterial(chunks(), { headers: reader })
      .catch((value: unknown) => value);
    expect(denied).toBeInstanceOf(ConnectError);
    const grpcFailure = denied as ConnectError;
    expect(grpcFailure.code).toBe(Code.PermissionDenied);
    expect(grpcFailure.findDetails(FailureSchema)[0]?.code).toBe(
      "transport.access_denied",
    );
    const badRange = await grpcClient
      .readMaterialText(
        {
          ref,
          range: { selection: { case: "text", value: { start: 4n, end: 6n } } },
        },
        { headers: reader },
      )
      .catch((value: unknown) => value);
    expect(badRange).toBeInstanceOf(ConnectError);
    const detail = (badRange as ConnectError).findDetails(FailureSchema)[0];
    expect(detail?.code).toBe("content.range_invalid");
    expect(detail?.traceId).toMatch(/^[a-f0-9]{32}$/);

    const saved = await session.api.results.save({
      value: { empty: null },
      inputs: [{ source: adopted, delivered: [adopted], role: "primary" }],
      files: [],
      producer: { kind: "application", name: "protocol-fixture" },
    });
    const result = await grpcClient.readResult(
      { ref: saved.ref },
      { headers: reader },
    );
    expect(result.value?.kind.case).toBe("structValue");
    if (result.value?.kind.case === "structValue")
      expect(result.value.kind.value.fields.empty?.kind.case).toBe("nullValue");

    const inline = {
      bytes: Buffer.from("real inline bytes").toString("base64"),
      mediaType: "text/plain",
      name: "inline.txt",
    };
    const producer = {
      kind: "PRODUCER_KIND_APPLICATION",
      name: "protocol-fixture",
    };
    const upstream = {
      value: null,
      producer,
      files: [{ name: "output", inline, sourceIndices: [] }],
    };
    const nested = await grpcClient.saveResult(
      fromJson(ApplicationService.method.saveResult.input, {
        value: null,
        producer,
        inputs: [
          {
            role: "INPUT_ROLE_PRIMARY",
            source: { resultOutput: { completed: upstream, output: "output" } },
            delivered: [{ inline }],
          },
        ],
      }),
      { headers: writer },
    );
    const adoptedGraph = await session.api.results.read(nested.ref);
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
    expect(
      tools.tools.find((tool) => tool.name === "materials_inspect")?.inputSchema
        .properties,
    ).toHaveProperty("ref");
    const viaMcp = await mcpClient.callTool({
      name: "materials_inspect",
      arguments: adopted,
    });
    expect(viaMcp.structuredContent).toMatchObject({
      result: { ref, name: "original.txt" },
    });
  } finally {
    await mcpClient.close();
    await Promise.all([http.close(), mcp.close(), grpc.close()]);
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
      arguments: adopted,
    });
    expect(viaStdio.structuredContent).toMatchObject({
      result: { ref: adopted.ref, name: "original.txt" },
    });
  } finally {
    await stdio.close();
  }
}, 20_000);
