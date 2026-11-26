import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createFlow } from "@themelios/core";
import { credentialSchema } from "@themelios/runtime/secrets";
import {
  combineSettings,
  defineSettings,
  Installation,
  runtimeSettings,
  type OpenEnvironment,
  type RuntimeSettings,
  type SettingMeta,
} from "@themelios/runtime";

test("composed settings keep each owner's validation, defaults and live values", async () => {
  const work = join("temp", "work");
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(join(work, "runtime-settings-"));
  await mkdir(join(root, "config"));
  const file = join(root, "config", "installation.toml");
  await writeFile(file, 'site = "north"\n');
  await writeFile(join(root, "config", "fixture.key"), "installation");
  const field: SettingMeta = {
    titleKey: "test.settings",
    descriptionKey: "test.settings",
    impactKey: "test.settings",
    scopes: ["installation", "instance"],
    effect: "next-call",
  };
  const limits = defineSettings({
    schema: z
      .strictObject({
        limits: z
          .strictObject({
            total: z.int().positive().default(8),
            readers: z.int().positive().default(2),
          })
          .prefault({}),
      })
      .refine(({ limits }) => limits.readers <= limits.total, {
        path: ["limits", "readers"],
        message: "Reader slots exceed the total",
      }),
    fields: { "/limits/total": field, "/limits/readers": field },
    validateEffective({ limits }) {
      return limits.total === 13
        ? [{ path: "/limits/total", messageKey: "test.reserved_total" }]
        : [];
    },
  });
  const site = defineSettings({
    schema: z.strictObject({
      site: z.string().min(1),
      zone: z.string().default("one"),
      service: z
        .strictObject({
          credential: credentialSchema.default("file:fixture.key"),
        })
        .readonly()
        .prefault({}),
    }),
    fields: {
      "/site": field,
      "/zone": field,
      "/service/credential": { ...field, format: "credential" },
    },
  });
  const instance = Installation.at(root, {
    id: "test.settings",
    formatId: "test.settings",
    settings: combineSettings(combineSettings(runtimeSettings, limits), site),
    async provision() {},
    async open(env) {
      return {
        credential: () => env.secrets.resolve(env.settings.service.credential),
        slots: () =>
          env.execution.run("test.slots", async () => ({
            site: env.settings.site,
            available: env.settings.limits.total - env.settings.limits.readers,
          })),
      };
    },
  }).instance("default");
  await instance.init();
  const session = await instance.open();
  try {
    const { configuration, api } = session;
    expect(await api.slots()).toEqual({ site: "north", available: 6 });
    expect(await api.credential()).toBe("installation");
    await writeFile(
      join(session.instance.paths.config, "fixture.key"),
      "instance",
    );
    await configuration.set("/service/credential", "file:fixture.key");
    expect(await api.credential()).toBe("instance");
    expect(configuration.explain("/limits/readers").contributions).toEqual([
      { layer: "default", value: 2 },
    ]);
    await configuration.set("/zone", "two");
    expect(configuration.explain("/zone")).toMatchObject({
      effective: "two",
      contributions: [
        { layer: "default", value: "one" },
        { layer: "managed", value: "two" },
      ],
    });
    await expect(configuration.set("/limits/readers", 9)).rejects.toMatchObject(
      { code: "config.invalid" },
    );
    await expect(configuration.set("/limits/total", 13)).rejects.toMatchObject({
      code: "config.invalid",
    });
    expect(await api.slots()).toEqual({ site: "north", available: 6 });
    await configuration.set("/limits/readers", 5);
    await writeFile(file, 'site = "east"\n[limits]\ntotal = 7\n');
    await configuration.reload();
    expect(await api.slots()).toEqual({ site: "east", available: 2 });
  } finally {
    await session.close();
  }
});

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
        async () => {
          const timeout = env.settings.network.timeoutMs;
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

test("a failed resource registration leaves queued updates and retries on the same generation", async () => {
  await mkdir(join("temp", "work"), { recursive: true });
  const root = await mkdtemp(join("temp", "work", "runtime-registration-"));
  const entered = Promise.withResolvers<void>();
  const first = Promise.withResolvers<void>();
  const closed: string[] = [];
  const instance = Installation.at(root, {
    id: "test.registration",
    formatId: "test.registration",
    settings: runtimeSettings,
    async provision() {},
    async open(env) {
      return {
        bind(fail: boolean) {
          return env.bindResource(
            (settings) => settings.locale,
            async ({ settings }) => {
              if (fail && settings.locale === "zh-CN") {
                entered.resolve();
                await first.promise;
              }
              return {
                locale: settings.locale,
                close: () => {
                  closed.push(settings.locale);
                },
              };
            },
          );
        },
      };
    },
  }).instance("default");

  await instance.init();
  const session = await instance.open();
  try {
    const failed = session.api.bind(true).catch((error: unknown) => error);
    await entered.promise;
    const updated = session.configuration.set("/locale", "en");
    const retried = session.api.bind(false);
    first.reject(new Error("initial factory failed"));
    expect(await failed).toMatchObject({ message: "initial factory failed" });
    await updated;
    expect((await retried).get().locale).toBe("en");
  } finally {
    await session.close();
  }
  expect(closed).toEqual(["en"]);
});

test("a session rebuilds independent bindings together and disposes a failed generation in reverse order", async () => {
  const work = join("temp", "work");
  await mkdir(work, { recursive: true });
  const root = await mkdtemp(join(work, "runtime-bindings-"));
  const oldCall = Promise.withResolvers<void>();
  const closed: string[] = [];
  const instance = Installation.at(root, {
    id: "test.bindings",
    formatId: "test.bindings",
    settings: runtimeSettings,
    async provision() {},
    async open(env) {
      const shared = await env.bindResource(
        (settings) => settings.locale,
        async () => ({
          close() {
            closed.push("shared");
          },
        }),
      );
      const source = await env.bindResource(
        ({ network }) => network.timeoutMs,
        async ({ runtime }) => {
          const timeout = runtime.network.timeoutMs;
          return {
            timeout,
            close() {
              closed.push(`source:${timeout}`);
            },
          };
        },
      );
      const reader = await env.bindResource(
        () => null,
        async () => {
          const dependency = source.get();
          return {
            dependency,
            close() {
              closed.push(`reader:${dependency.timeout}`);
            },
          };
        },
      );
      await env.bindResource(
        () => null,
        async () => {
          const { timeout } = reader.get().dependency;
          if (timeout === 9000) throw new Error("new reader could not open");
          return {
            close() {
              closed.push(`guard:${timeout}`);
            },
          };
        },
      );
      return {
        read(wait = Promise.resolve()) {
          return env.execution.run("test.bindings", async () => {
            await wait;
            return {
              source: source.get(),
              reader: reader.get(),
              shared: shared.get(),
            };
          });
        },
      };
    },
  }).instance("default");
  await instance.init();
  const session = await instance.open();
  try {
    const pending = session.api.read(oldCall.promise);
    await session.configuration.set("/network/timeoutMs", 6500);
    const current = await session.api.read();
    expect(current.source.timeout).toBe(6500);
    expect(current.reader.dependency).toBe(current.source);
    await expect(
      session.configuration.set("/network/timeoutMs", 9000),
    ).rejects.toThrow("new reader could not open");
    expect(closed).toEqual(["reader:9000", "source:9000"]);
    expect((await session.api.read()).reader).toBe(current.reader);
    oldCall.resolve();
    const previous = await pending;
    expect(previous.source.timeout).toBe(60000);
    expect(previous.reader.dependency).toBe(previous.source);
    expect(previous.shared).toBe(current.shared);
  } finally {
    oldCall.resolve();
    await session.close();
  }
  expect(closed.filter((item) => item.endsWith(":60000"))).toEqual([
    "guard:60000",
    "reader:60000",
    "source:60000",
  ]);
  expect(closed.filter((item) => item.endsWith(":6500"))).toEqual([
    "guard:6500",
    "reader:6500",
    "source:6500",
  ]);
  expect(closed.filter((item) => item === "shared")).toEqual(["shared"]);
});
