import { expect, test } from "bun:test";
import { createNetwork } from "@themelios/runtime/network";

test("HTTP deadline covers the unread response body and aborts the upstream stream", async () => {
  const cancelled = Promise.withResolvers<void>();
  const encoder = new TextEncoder();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      let ticker: ReturnType<typeof setInterval>;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("first"));
            ticker = setInterval(
              () => controller.enqueue(encoder.encode(".")),
              100,
            );
          },
          cancel() {
            clearInterval(ticker);
            cancelled.resolve();
          },
        }),
      );
    },
  });
  const network = await createNetwork({ timeoutMs: 300 });
  try {
    const response = await network.fetch(server.url);
    expect(response.url).toBe(server.url.href);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    await Bun.sleep(400);
    await expect(reader.read()).rejects.toMatchObject({
      code: "network.timeout",
    });
    await cancelled.promise;
    reader.releaseLock();
  } finally {
    await network.close();
    await server.stop(true);
  }
});
