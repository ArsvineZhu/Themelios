import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { appError, createFlow, toErrorInfo } from "@themelios/core";
import {
  Installation,
  withOfflineInstance,
  withInstanceLock,
  type OpenEnvironment,
} from "@themelios/runtime";
import {
  combineSettings,
  runtimeSettings,
  type RuntimeSettings,
} from "@themelios/runtime/settings";
import {
  defineOperation,
  createOperationDirectory,
  callOperation,
} from "@themelios/runtime/operations";
import { createSecrets } from "@themelios/runtime/secrets";
import { createNetwork } from "@themelios/runtime/network";
import { createLocalizer, mergeLocales } from "@themelios/runtime/locales";

const root = await mkdtemp(join(tmpdir(), "themelios-tea-runtime-"));
const settings = combineSettings(runtimeSettings, {
  schema: z.strictObject({ shelf: z.string().default("west") }),
  fields: {
    "/shelf": {
      titleKey: "tea.shelf",
      descriptionKey: "tea.shelf",
      impactKey: "tea.shelf",
      scopes: ["installation", "instance"],
      effect: "reload",
    },
  },
});
const locales = mergeLocales({
  en: { "tea.ready": "{{shelf}} shelf ready" },
  "zh-CN": { "tea.ready": "{{shelf}} 架已就绪" },
});
const generations: string[] = [];
const app = {
  id: "tea-desk",
  formatId: "tea-desk",
  settings,
  locales,
  async provision() {},
  async open(env: OpenEnvironment<RuntimeSettings & { shelf: string }>) {
    const slot = await env.bindResource(
      (s) => s.shelf,
      async (context) => {
        const shelf = context.settings.shelf;
        generations.push("open " + shelf);
        return {
          shelf,
          close() {
            generations.push("close " + shelf);
          },
        };
      },
    );
    env.own({
      close() {
        generations.push("close desk");
      },
    });
    return {
      shelf: () => slot.get().shelf,
      announce: () =>
        env.execution.run("tea.ready", async () =>
          env.diagnostics.span("tea.print", async () => {
            env.diagnostics.log("info", "tea.shelf.ready", {
              shelf: slot.get().shelf,
            });
            return env.localize("tea.ready", { shelf: slot.get().shelf });
          }),
        ),
      hold: (gate: Promise<void>, started: () => void) =>
        env.execution.run("tea.pick", async () => {
          const before = slot.get().shelf;
          started();
          await gate;
          return [before, slot.get().shelf];
        }),
      feed: () =>
        env.execution.flow("tea.feed", (signal) =>
          createFlow(
            "tea.feed",
            async function* () {
              yield { type: "text-delta", text: slot.get().shelf };
              return "ready";
            },
            { signal },
          ),
        ),
      job: () =>
        env.execution.start(
          "tea.wait",
          (signal) =>
            new Promise<string>((_, reject) => {
              if (signal.aborted) reject(signal.reason);
              else
                signal.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                });
            }),
        ),
      fail: () =>
        env.execution.run("tea.sample", async () => {
          throw appError("tea.sample_failure");
        }),
    };
  },
};
const home = Installation.at(root, app, {
  configRoot: "config",
  dataRoot: "data",
});
const instance = home.instance("main");
const info = await instance.init();
const external = home.external(join(root, "separate-room"));
await external.init();
console.log(
  "同一安装的内置/外置实例",
  (await instance.locate()).id !== (await external.locate()).id,
);
await mkdir(join(root, "config"), { recursive: true });
await writeFile(join(root, "config", "installation.toml"), 'shelf = "north"\n');
await writeFile(join(info.paths.config, "instance.toml"), 'shelf = "south"\n');
const session = await instance.open();
try {
  const config = session.configuration;
  console.log(
    "层次",
    config.explain("/shelf").contributions.map((c) => c.layer),
  );
  console.log("描述", config.describe("/shelf")[0]?.metadata.effect);
  const start = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const oldCall = session.api.hold(release.promise, start.resolve);
  await start.promise;
  await config.set("/shelf", "east");
  console.log("新调用", await session.api.announce());
  release.resolve();
  console.log("在途调用", await oldCall);
  console.log("换代", generations);
  await config.unset("/shelf");
  await writeFile(
    join(info.paths.config, "instance.toml"),
    'shelf = "upper"\n',
  );
  await config.reload();
  console.log("移除托管层、重读实例文件", config.snapshot().shelf);
  for await (const event of session.api.feed()) console.log("流", event);
  const task = session.api.job();
  task.cancel("访客离开");
  try {
    await task.result;
  } catch (err) {
    console.log("任务取消", toErrorInfo(err).code);
  }
  try {
    await session.api.fail();
  } catch (err) {
    console.log("调用与日志关联", Boolean(toErrorInfo(err).traceId));
  }
  await session.setEndpoints({ status: "in-process" });
  try {
    await withOfflineInstance(instance, async () => null);
  } catch (err) {
    console.log("活跃实例的维护锁", toErrorInfo(err).code);
  }

  const listShelf = defineOperation<typeof session.api>()({
    id: "tea.shelf",
    description: "Current shelf",
    permission: "read",
    input: z.strictObject({}),
    output: z.string(),
    execute: (api) => api.shelf(),
  });
  const directory = createOperationDirectory([listShelf]);
  console.log(
    "授权的应用操作",
    await callOperation(
      session.api,
      directory,
      "tea.shelf",
      {},
      {
        principal: { id: "guest", permissions: ["read"] },
        locale: "en",
        options: {},
      },
    ),
  );
} finally {
  await session.close();
}
const readOnly = await instance.open({ mode: "read-only" });
try {
  await readOnly.configuration.set("/shelf", "locked");
} catch (err) {
  console.log("只读写入", toErrorInfo(err).code);
} finally {
  await readOnly.close();
}
console.log(
  "离线独占与外置锁",
  await withOfflineInstance(instance, async (i) => i.id === info.id),
  await withInstanceLock(
    (await external.locate()).paths.root,
    async () => true,
  ),
);
const log = await readFile(join(info.paths.logs, "runtime.jsonl"), "utf8");
console.log(
  "日志含事件",
  log
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .some((e) => e.event === "tea.shelf.ready" && e.traceId),
);
const translate = await createLocalizer(locales);
console.log("英文", translate("en", "tea.ready", { shelf: "upper" }));
const secrets = createSecrets({ baseDir: root });
await writeFile(join(root, "demo.key"), "example-only\n", { mode: 0o600 });
console.log(
  "文件凭据",
  await secrets.available("file:demo.key"),
  (await secrets.resolve("file:demo.key")).length,
);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("tea"),
});
const network = await createNetwork({ timeoutMs: 1000, secrets });
try {
  console.log("受控网络", await (await network.fetch(server.url)).text());
} finally {
  await network.close();
  await server.stop(true);
}
