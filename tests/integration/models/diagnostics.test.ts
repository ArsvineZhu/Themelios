import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels } from "@themelios/models";
import {
  Installation,
  runtimeSettings,
  type OpenEnvironment,
  type RuntimeSettings,
} from "@themelios/runtime";

test("model diagnostics follow real attempts and keep secrets and media bytes out of captured content", async () => {
  const work = join("temp", "work");
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(join(work, "model-diagnostics-"));
  const secret = crypto.randomUUID();
  process.env.THEMELIOS_TEST_MODELS_SECRET = secret;
  const binary = Uint8Array.of(
    137,
    80,
    78,
    71,
    12,
    26,
    10,
    71,
    45,
    11,
    92,
    127,
  );
  const base64 = Buffer.from(binary).toString("base64");
  let requests = 0;
  let sawMedia = false;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== "Bearer " + secret) {
        return Response.json(
          { error: { message: "invalid credential" } },
          { status: 401 },
        );
      }
      const message = await request.text();
      if (message.includes(base64)) sawMedia = true;
      requests++;
      if (requests === 1)
        return Response.json(
          { error: { message: "Wait" } },
          { status: 429, headers: { "retry-after": "0" } },
        );
      return Response.json({
        id: "local-response",
        object: "chat.completion",
        created: 100,
        model: "local-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "done" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      });
    },
  });
  await mkdir(join(root, "config"));
  await writeFile(
    join(root, "config", "installation.toml"),
    '[logging]\nlevel = "debug"\n',
  );
  const instance = Installation.at(root, {
    id: "test.model-diagnostics",
    formatId: "test.model-diagnostics",
    settings: runtimeSettings,
    async provision() {},
    async open(env: OpenEnvironment<RuntimeSettings>) {
      const models = env.own(
        createModels({
          connections: {
            local: {
              protocol: "openai-compatible",
              baseURL: new URL("/v1", provider.url).href,
              credential: "env:THEMELIOS_TEST_MODELS_SECRET",
            },
          },
          bindings: {
            demo: {
              connection: "local",
              providerModel: "local-model",
              capabilities: {
                operations: ["generate"],
                inputMimeTypes: ["text/plain", "image/png"],
                needs: ["text", "visual"],
                structuredOutput: false,
                streaming: false,
              },
            },
          },
          defaults: { maxAttempts: 2, concurrency: 1 },
          fetch: env.network.fetch,
          resolveCredential: env.secrets.resolve,
          diagnostics: env.diagnostics,
        }),
      );
      return (withImage: boolean) =>
        env.execution.run("test.generate", (signal) =>
          models.generate(
            {
              model: "demo",
              output: "text",
              messages: [
                {
                  role: "user",
                  parts: [
                    { kind: "text", text: "Prompt contains " + secret },
                    ...(withImage
                      ? [
                          {
                            kind: "media" as const,
                            mediaType: "image/png",
                            bytes: binary,
                          },
                        ]
                      : []),
                  ],
                },
              ],
            },
            { signal },
          ),
        );
    },
  }).instance("default");
  try {
    await instance.init();
    const session = await instance.open();
    const attachmentRoot = join(session.instance.paths.logs, "model-content");
    try {
      expect((await session.api(false)).value).toBe("done");
      expect(existsSync(attachmentRoot)).toBe(false);
      await session.configuration.set("logging.captureModelContent", true);
      expect((await session.api(true)).usage).toMatchObject({
        inputTokens: 12,
        outputTokens: 3,
      });
    } finally {
      await session.close();
    }
    expect(requests).toBe(3);
    expect(sawMedia).toBe(true);
    const logs = (
      await readFile(join(session.instance.paths.logs, "runtime.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const attempts = logs.filter(
      (event) => event.event === "model.request.completed",
    );
    expect(
      attempts.map(({ attempt, providerStatus, outcome }) => ({
        attempt,
        providerStatus,
        outcome,
      })),
    ).toEqual([
      { attempt: 1, providerStatus: 429, outcome: "failure" },
      { attempt: 2, providerStatus: 200, outcome: "success" },
      { attempt: 1, providerStatus: 200, outcome: "success" },
    ]);
    expect(attempts[2]).toMatchObject({ inputTokens: 12, outputTokens: 3 });
    expect(
      logs.some(
        (event) =>
          event.event === "queue.acquired" && typeof event.queueMs === "number",
      ),
    ).toBe(true);
    const traces = await readdir(attachmentRoot);
    expect(traces).toEqual([attempts[2]?.traceId as string]);
    const [attachment] = await readdir(join(attachmentRoot, traces[0]!));
    const content = await readFile(
      join(attachmentRoot, traces[0]!, attachment!),
      "utf8",
    );
    expect(content).not.toContain(secret);
    expect(content).not.toContain(base64);
    expect(JSON.parse(content)).toMatchObject({ response: "done" });
    expect(content).toContain('"mediaType":"image/png","sizeBytes":12');
  } finally {
    delete process.env.THEMELIOS_TEST_MODELS_SECRET;
    await provider.stop(true);
  }
}, 20_000);
