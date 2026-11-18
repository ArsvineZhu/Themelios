import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFlow } from "@themelios/core";
import {
  Installation,
  runtimeSettings,
  type OpenEnvironment,
  type RuntimeSettings,
} from "@themelios/runtime";

test("a reloaded session leaves captured calls on their original settings and closes them in order", async () => {
  const work = join("temp", "work");
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(join(work, "runtime-generations-"));
  const closed: (string | number)[] = [];
  const installation = Installation.at(root, {
    id: "test.generations",
    formatId: "test.generations",
    settings: runtimeSettings,
    async provision() {},
    async open(env: OpenEnvironment<RuntimeSettings>) {
      const slot = await env.bindResource(
        (settings) => settings.network.timeoutMs,
        async ({ settings }) => {
          const timeout = settings.network.timeoutMs;
          return {
            timeout,
            close() {
              closed.push(timeout);
            },
          };
        },
      );
      return {
        read: () =>
          env.execution.run("test.read", async () => slot.get().timeout),
        stream: () =>
          env.execution.flow("test.stream", (signal) =>
            createFlow(
              "test.source",
              async function* () {
                try {
                  yield {
                    type: "text-delta",
                    text: String(slot.get().timeout),
                  };
                  yield {
                    type: "text-delta",
                    text: String(
                      env.configuration.snapshot().network.timeoutMs,
                    ),
                  };
                  return slot.get().timeout;
                } finally {
                  closed.push("stream");
                }
              },
              { signal },
            ),
          ),
      };
    },
  });
  const instance = installation.instance("default");
  await instance.init();
  const session = await instance.open();
  try {
    const first = session.api.stream()[Symbol.asyncIterator]();
    expect((await first.next()).value).toEqual({
      type: "text-delta",
      text: "60000",
    });
    expect(
      (await session.configuration.set("network.timeoutMs", 6500)).applied,
    ).toEqual(["/network/timeoutMs"]);
    expect(await session.api.read()).toBe(6500);
    expect((await first.next()).value).toEqual({
      type: "text-delta",
      text: "60000",
    });
    expect(closed).toEqual([]);
    await first.return?.();

    await writeFile(
      join(session.instance.paths.config, "instance.toml"),
      "[invalid",
    );
    await expect(session.configuration.reload()).rejects.toMatchObject({
      code: "config.invalid",
    });
    expect(await session.api.read()).toBe(6500);
    const second = session.api.stream()[Symbol.asyncIterator]();
    expect((await second.next()).value).toEqual({
      type: "text-delta",
      text: "6500",
    });
  } finally {
    await session.close({ graceMs: 0 });
  }
  expect(closed).toEqual(["stream", 60000, "stream", 6500]);
});
