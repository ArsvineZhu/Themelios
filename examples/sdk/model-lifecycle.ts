import { createModels, z } from "@themelios/models";
let mode = "retry",
  attempts = 0;
const objectOutput = z.strictObject({ tea: z.string() });
let entered = Promise.withResolvers<void>();
const model = createModels({
  connections: {
    service: {
      protocol: "openai-compatible",
      baseURL: "http://example.invalid/v1",
    },
  },
  bindings: {
    local: {
      connection: "service",
      providerModel: "demo",
      capabilities: {
        operations: ["generate"],
        inputMimeTypes: ["text/plain"],
        needs: ["text"],
        structuredOutput: true,
        streaming: true,
      },
    },
  },
  defaults: { maxAttempts: 2, timeoutMs: 4000, concurrency: 1 },
  fetch: async (_u, init) => {
    attempts++;
    if (mode === "retry" && attempts === 1)
      return Response.json(
        { error: { message: "busy", type: "unavailable" } },
        { status: 503 },
      );
    if (mode === "wait") {
      entered.resolve();
      await new Promise((_resolve, reject) => {
        const signal = init!.signal!;
        if (signal.aborted) reject(signal.reason);
        else
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
      });
    }
    return Response.json({
      id: "answer",
      model: "demo",
      created: 1,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: mode === "wrong" ? '{"other":3}' : "tea",
          },
          finish_reason: mode === "limit" ? "length" : "stop",
        },
      ],
    });
  },
});
const req = {
  model: "local",
  output: "text" as const,
  messages: [
    { role: "user" as const, parts: [{ kind: "text" as const, text: "Read" }] },
  ],
};
const code = async (label: string, promise: Promise<unknown>) => {
  try {
    console.log(label, await promise);
  } catch (e) {
    console.log(label, (e as { code?: string }).code);
  }
};
try {
  await code("503 followed by success", model.generate(req));
  console.log("attempts", attempts);
  mode = "limit";
  await code("truncation", model.generate(req));
  await code(
    "truncated JSON",
    model.generate({ ...req, output: objectOutput }),
  );
  mode = "wrong";
  await code(
    "invalid schema",
    model.generate({ ...req, output: objectOutput }),
  );
  mode = "wait";
  const ac = new AbortController();
  const running = model.generate(req, { signal: ac.signal });
  await entered.promise;
  ac.abort();
  await code("abort", running);
  entered = Promise.withResolvers<void>();
  await code("deadline", model.generate(req, { timeoutMs: 20 }));
} finally {
  await model.close();
}
await code("after close", model.generate(req));
