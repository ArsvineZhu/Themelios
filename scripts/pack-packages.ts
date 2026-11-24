import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildPackages } from "./build-packages.js";
import { orderedWorkspaces, repoRoot, run, workspaces } from "./workspaces.js";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  allowPositionals: true,
  options: { output: { type: "string" } },
});
const packages = orderedWorkspaces(await workspaces(), positionals);
await buildPackages(positionals);
const destination = values.output
  ? resolve(values.output)
  : join(repoRoot, "artifacts", "packages");
await mkdir(destination, { recursive: true });
for (const pkg of packages) {
  if (pkg.manifest.private) continue;
  await copyFile(join(repoRoot, "LICENSE"), join(pkg.root, "LICENSE"));
  await run(
    [process.execPath, "pm", "pack", "--destination", destination, "--quiet"],
    { cwd: pkg.root },
  );
}
console.log(`Packed Themelios packages into ${destination}`);
