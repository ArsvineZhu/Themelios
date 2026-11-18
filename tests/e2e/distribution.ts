import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rename,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { repoRoot, run } from "../../scripts/workspaces.js";

const flags = process.argv.slice(2).filter((arg) => arg !== "--");
const live = flags.includes("--live");
const portableFlag = flags.indexOf("--portable");
const release = resolve(repoRoot, "artifacts/packages");
const parent = resolve(
  process.env.THEMELIOS_CONSUMER_ROOT ?? join(repoRoot, "..", "temp"),
);
await mkdir(parent, { recursive: true });
const source = await realpath(repoRoot);
const outside = relative(source, await realpath(parent));
if (
  !isAbsolute(outside) &&
  outside !== ".." &&
  !outside.startsWith(".." + sep)
) {
  throw new Error("Use a consumer directory outside the Themelios repository.");
}
const sandbox = await mkdtemp(join(parent, "themelios-release-"));
const bun = process.execPath;
const installer = join(repoRoot, "examples/inventory/install-release.ts");

async function prepare(kind: "inventory" | "embedded"): Promise<string> {
  const path = join(sandbox, kind);
  await cp(join(repoRoot, "examples", kind), path, {
    recursive: true,
    filter: (item) => !["node_modules", "bun.lock"].includes(basename(item)),
  });
  await copyFile(installer, join(path, "install-release.ts"));
  await run([bun, "install-release.ts", release], { cwd: path, quiet: true });
  return path;
}

async function call(cwd: string, command: string[], json = true) {
  const child = Bun.spawn(command, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(command.slice(1).join(" ") + " failed:\n" + stderr.trim());
  if (!json) return stdout;
  try {
    return JSON.parse(stdout);
  } catch (cause) {
    throw new Error(
      command.slice(1).join(" ") +
        " did not return JSON (" +
        stdout.length +
        " characters)",
      { cause },
    );
  }
}

async function verifyInventoryServer(
  inventory: string,
  original: string,
  sourceRef: string,
) {
  const token = crypto.randomUUID();
  const server = Bun.spawn(
    [bun, "--no-install", "main.ts", "--installation", "demo", "serve"],
    {
      cwd: inventory,
      env: { ...process.env, THEMELIOS_INVENTORY_TOKEN: token },
      stdout: "ignore",
      stderr: "pipe",
      stdin: "ignore",
    },
  );
  const client = new Client({ name: "inventory-consumer", version: "0.1.0" });
  const reader = server.stderr.getReader();
  const headers = { authorization: "Bearer " + token };
  const signal = AbortSignal.timeout(15_000);
  const deadline = Promise.withResolvers<never>();
  function onTimeout() {
    deadline.reject(signal.reason);
  }
  signal.addEventListener("abort", onTimeout, { once: true });
  try {
    const decoder = new TextDecoder();
    let ready = "";
    while (!ready.includes("\n")) {
      const entry = await Promise.race([reader.read(), deadline.promise]);
      if (entry.done)
        throw new Error("Inventory server did not start: " + ready);
      ready += decoder.decode(entry.value, { stream: true });
    }
    const { endpoints } = JSON.parse(ready.split("\n")[0]!);
    const http = (path: string, init?: RequestInit) =>
      fetch(new URL(path, endpoints.http), {
        ...init,
        signal,
        headers: { ...headers, ...init?.headers },
      });
    const csv = "sku,name,quantity\nPEN,签字笔,3\n";
    const stream = (body: string) =>
      http("/inventory/import-stream", {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body,
      });
    const sse = await stream(csv);
    equal(sse.status, 200);
    const events = await sse.text();
    ok(events.includes("event: progress") && events.includes('"cut":"3"'));
    const invalid = await stream("sku,name,quantity\nPEN,签字笔,-1\n");
    ok((await invalid.text()).includes("event: error"));
    const download = await http("/inventory/source/" + sourceRef);
    equal(download.status, 200);
    deepStrictEqual(
      new Uint8Array(await download.arrayBuffer()),
      new TextEncoder().encode(original),
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoints.mcp), {
        requestInit: { headers },
      }),
    );
    const tool = await client.callTool({
      name: "inventory_history",
      arguments: { sku: "PEN" },
    });
    const report = tool.structuredContent as {
      result: { cut: string; rows: Array<{ quantity: number }> };
    };
    equal(report.result.cut, "3");
    deepStrictEqual(
      report.result.rows.map((row) => row.quantity),
      [12, 7, 3],
    );
  } finally {
    signal.removeEventListener("abort", onTimeout);
    await client.close();
    server.kill();
    await reader.cancel();
    reader.releaseLock();
    await server.exited;
  }
}

try {
  const inventory = await prepare("inventory");
  const execute = (args: string[]) =>
    call(inventory, [
      bun,
      "--no-install",
      "main.ts",
      "--installation",
      "demo",
      "--json",
      ...args,
    ]);
  const first = "sku,name,quantity\r\nPEN,签字笔,12\r\nBOOK,练习本,0\r\n";
  const second = "sku,name,quantity\nPEN,签字笔,7\nPAPER,A4纸,1000000000\n";
  await Bun.write(join(inventory, "first.csv"), first);
  await Bun.write(join(inventory, "second.csv"), second);
  await execute(["instance", "init"]);
  const a = (await execute(["import", "first.csv"])) as {
    cut: string;
    sourceRef: string;
  };
  const b = (await execute(["import", "second.csv"])) as {
    cut: string;
    sourceRef: string;
  };
  equal(a.cut, "1");
  equal(b.cut, "2");
  const prior = JSON.stringify(await execute(["list", a.cut]));
  const latest = JSON.stringify(await execute(["list"]));
  ok(prior.includes('"quantity":12') && !prior.includes("PAPER"));
  ok(latest.includes('"quantity":7') && latest.includes("PAPER"));
  await execute(["export", a.sourceRef, "exported.csv"]);
  equal(await Bun.file(join(inventory, "exported.csv")).text(), first);
  await verifyInventoryServer(inventory, first, a.sourceRef);
  const resolved = await call(
    inventory,
    [
      bun,
      "--no-install",
      "-e",
      "console.log(import.meta.resolve('@themelios/storage'))",
    ],
    false,
  );
  ok(String(resolved).includes("/node_modules/"));
  ok(!String(resolved).includes("/packages/storage/dist"));

  const embedded = await prepare("embedded");
  await call(embedded, [
    bun,
    "--no-install",
    "-e",
    "await import('@themelios/models'); await import('@themelios/models/tasks'); let hasApp = true; try { import.meta.resolve('@themelios/application'); } catch { hasApp = false; } if (hasApp) throw new Error('Expected standalone embedded install without @themelios/application'); console.log(true)",
  ]);
  if (live) {
    const model = (await call(embedded, [
      bun,
      "--no-install",
      "embedded-summary.ts",
    ])) as {
      value: { title: string; sections: { sourceKeys: string[] }[] };
      producer: { details: { providerModel: string } };
    };
    ok(model.value.title && model.value.sections.length);
    ok(model.value.sections.every((item) => item.sourceKeys.includes("S1")));
    const fromFile = (await call(embedded, [
      bun,
      "--no-install",
      "embedded-summary.ts",
      "--file-prompt",
    ])) as typeof model;
    ok(fromFile.value.title && fromFile.value.sections.length);
    ok(fromFile.value.sections.every((item) => item.sourceKeys.includes("S1")));
    console.log("External model: " + model.producer.details.providerModel);
  }

  if (portableFlag >= 0) {
    const directory = flags[portableFlag + 1];
    if (!directory || directory.startsWith("--"))
      throw new Error("Pass the unpacked release directory after --portable.");
    const initial = join(sandbox, "Portable 原目录");
    const moved = join(sandbox, "Portable 已搬迁");
    await cp(resolve(directory), initial, { recursive: true });
    const invoke = (root: string, args: string[], json = true) =>
      call(
        sandbox,
        [
          join(
            root,
            "runtime",
            process.platform === "win32" ? "bun.exe" : "bun",
          ),
          "--no-install",
          join(root, "app/launch.mjs"),
          "--json",
          ...args,
        ],
        json,
      );
    await invoke(initial, ["instance", "init"]);
    const item = (await invoke(initial, [
      "material",
      "import",
      "--text",
      "UTF-8 原件🍎",
    ])) as { ref: string };
    const completed = {
      value: { text: "保存成果" },
      inputs: [{ source: item, delivered: [item], role: "primary" }],
      files: [],
      producer: { kind: "application", name: "release-smoke" },
    };
    await Bun.write(join(sandbox, "complete.json"), JSON.stringify(completed));
    const result = (await invoke(initial, [
      "result",
      "save",
      "--input",
      "complete.json",
    ])) as { ref: string };
    await rename(initial, moved);
    deepStrictEqual(
      await invoke(moved, ["result", "read", result.ref]),
      result,
    );
    await invoke(moved, ["material", "export", item.ref, "moved.txt"], false);
    equal(await Bun.file(join(sandbox, "moved.txt")).text(), "UTF-8 原件🍎");
    console.log("Portable reopened after moving to " + moved);
  }
  console.log(
    "Installed tarballs and verified inventory cuts " +
      a.cut +
      "/" +
      b.cut +
      " in " +
      sandbox,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Consumer directory: " + sandbox);
  process.exitCode = 1;
}
