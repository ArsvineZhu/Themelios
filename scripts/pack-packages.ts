import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildPackages } from "./build-packages.js";
import { orderedWorkspaces, repoRoot, run, workspaces } from "./workspaces.js";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const packages = orderedWorkspaces(await workspaces(), args);
await buildPackages(args);
const destination = join(repoRoot, "artifacts", "packages");
await mkdir(destination, { recursive: true });
for (const pkg of packages) {
  if (pkg.manifest.private) continue;
  await copyFile(join(repoRoot, "LICENSE"), join(pkg.root, "LICENSE"));
  await run(
    [process.execPath, "pm", "pack", "--destination", destination, "--quiet"],
    { cwd: pkg.root },
  );
}
