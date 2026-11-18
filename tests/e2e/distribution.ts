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
  return json ? JSON.parse(stdout) : stdout;
}

try {
  const inventory = await prepare("inventory");
  const execute = (args: string[]) =>
    call(inventory, [bun, "--no-install", "main.ts", "demo", ...args]);
  const first = "sku,name,quantity\r\nPEN,签字笔,12\r\nBOOK,练习本,0\r\n";
  const second = "sku,name,quantity\nPEN,签字笔,7\nPAPER,A4纸,1000000000\n";
  await Bun.write(join(inventory, "first.csv"), first);
  await Bun.write(join(inventory, "second.csv"), second);
  await execute(["init"]);
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
    "await import('@themelios/models/prompts'); await import('@themelios/application/tasks'); console.log(true)",
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
    console.log("External model: " + model.producer.details.providerModel);
  }

  if (portableFlag >= 0) {
    const directory = flags[portableFlag + 1];
    if (!directory || directory.startsWith("--"))
      throw new Error("Pass the unpacked release directory after --portable.");
    const initial = join(sandbox, "Portable 原目录");
    const moved = join(sandbox, "Portable 已搬迁");
    await cp(resolve(directory), initial, { recursive: true });
    const invoke = (root: string, args: string[]) =>
      call(sandbox, [
        join(root, "runtime", process.platform === "win32" ? "bun.exe" : "bun"),
        "--no-install",
        join(root, "app/launch.mjs"),
        "--json",
        ...args,
      ]);
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
    await invoke(moved, ["material", "export", item.ref, "moved.txt"]);
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
