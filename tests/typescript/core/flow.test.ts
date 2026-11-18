import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "bun:test";
import { createFlow } from "@themelios/core";

test("a pending pull is cancelled before iterator return waits for its producer", async () => {
  const entered = Promise.withResolvers<void>();
  let releases = 0;
  let started = false;
  const flow = createFlow("read", async function* (call) {
    started = true;
    try {
      yield { type: "text-delta", text: "initial data" };
      entered.resolve();
      await delay(30_000, undefined, { signal: call.signal });
      return "done";
    } finally {
      releases++;
    }
  });
  const iterator = flow[Symbol.asyncIterator]();
  expect(started).toBe(false);
  expect((await iterator.next()).value).toEqual({
    type: "text-delta",
    text: "initial data",
  });
  const pending = iterator.next().catch((error) => error);
  await entered.promise;
  expect(await iterator.next().catch((error) => error)).toMatchObject({
    code: "call.invalid_state",
  });
  await iterator.return?.();
  expect(await pending).toMatchObject({ code: "call.cancelled" });
  expect(releases).toBe(1);
  expect(() => flow[Symbol.asyncIterator]()).toThrow(
    expect.objectContaining({ code: "call.stream_consumed" }),
  );
});
