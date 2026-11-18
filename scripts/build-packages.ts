import { readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  exportSources,
  orderedWorkspaces,
  run,
  workspaces,
  type Workspace,
} from "./workspaces.js";

export async function buildPackages(
  selection: string[] = [],
  quiet = false,
): Promise<void> {
  const ordered = orderedWorkspaces(await workspaces(), selection);
  if (!ordered.length) throw new Error("No workspace packages found.");
  const bun = process.execPath;
  await run(
    [bun, "x", "--no-install", "tsc", "-b", ...ordered.map((pkg) => pkg.root)],
    { quiet },
  );
  for (const pkg of ordered) await bundlePackage(pkg);
}

async function bundlePackage(pkg: Workspace): Promise<void> {
  const entrypoints = exportSources(pkg);
  if (!entrypoints.length)
    throw new Error("Missing build exports: " + pkg.manifest.name);
  const dist = join(pkg.root, "dist");
  const result = await Bun.build({
    entrypoints,
    root: join(pkg.root, "src"),
    outdir: dist,
    format: "esm",
    target: "bun",
    packages: "external",
    splitting: true,
    naming: { entry: "[dir]/[name].[ext]", chunk: "chunk-[hash].[ext]" },
    throw: false,
  });
  if (!result.success)
    throw new Error(
      pkg.manifest.name +
        ":\n" +
        result.logs.map((log) => String(log)).join("\n"),
    );
  const emitted = new Set(result.outputs.map((file) => basename(file.path)));
  for (const file of await readdir(dist)) {
    if (/^chunk-[a-zA-Z0-9]+\.js(?:\.map)?$/.test(file) && !emitted.has(file))
      await unlink(join(dist, file));
  }
  for (const contract of Object.values(pkg.manifest.exports ?? {})) {
    const path = join(pkg.root, contract.types);
    if (!(await Bun.file(path).exists()))
      throw new Error("Missing declaration: " + path);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  try {
    await buildPackages(args);
    console.log("Built Themelios package exports.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
