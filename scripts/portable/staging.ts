import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { repoRoot, run, type Workspace } from "../workspaces.js";
import { copyEntry, exists } from "./files.js";

const runtimePackage = "@themelios/runtime";

function workspacePath(root: string, workspace: Workspace): string {
  return join(root, relative(repoRoot, workspace.root));
}

async function copyParts(
  source: string,
  destination: string,
  paths: readonly string[],
): Promise<void> {
  for (const path of paths)
    await copyEntry(join(source, path), join(destination, path));
}

async function copyOptional(
  source: string,
  destination: string,
  paths: readonly string[],
): Promise<void> {
  for (const path of paths) {
    const file = join(source, path);
    if (await exists(file)) await copyEntry(file, join(destination, path));
  }
}

/** Copies a source snapshot so native and npm installs for different hosts never share node_modules. */
export async function buildInStaging(
  root: string,
  all: readonly Workspace[],
  closure: readonly Workspace[],
  appName: string,
): Promise<void> {
  await copyParts(repoRoot, root, [
    "package.json",
    "bun.lock",
    "tsconfig.base.json",
    "tsconfig.package.json",
    "tsconfig.json",
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "native",
    "proto",
    "scripts/build-packages.ts",
    "scripts/workspaces.ts",
  ]);
  await Bun.write(
    join(root, "bunfig.toml"),
    '[install]\nlinker = "isolated"\nglobalStore = false\n',
  );
  const built = new Set(closure);
  for (const workspace of all) {
    const destination = workspacePath(root, workspace);
    await copyParts(workspace.root, destination, ["package.json"]);
    if (built.has(workspace)) {
      await copyParts(workspace.root, destination, ["src", "tsconfig.json"]);
      await copyOptional(workspace.root, destination, ["resources"]);
    }
  }
  await run(
    [process.execPath, "install", "--frozen-lockfile", "--linker=isolated"],
    { cwd: root, quiet: true },
  );
  await run([process.execPath, "scripts/build-packages.ts", appName], {
    cwd: root,
    quiet: true,
  });
}

export async function stageApplication(
  build: string,
  app: string,
  all: readonly Workspace[],
  closure: readonly Workspace[],
  appName: string,
  target: string,
): Promise<void> {
  await copyParts(build, app, ["package.json", "bun.lock"]);
  await Bun.write(
    join(app, "bunfig.toml"),
    '[install]\nlinker = "hoisted"\nglobalStore = false\nauto = "disable"\n',
  );
  for (const workspace of all)
    await copyParts(
      workspacePath(build, workspace),
      workspacePath(app, workspace),
      ["package.json"],
    );
  for (const workspace of closure)
    await stageWorkspaceOutput(build, app, workspace, target);
  await run(
    [
      process.execPath,
      "install",
      "--production",
      "--frozen-lockfile",
      "--linker=hoisted",
      "--filter",
      `${appName}...`,
    ],
    { cwd: app, quiet: true },
  );
  for (const workspace of closure) {
    const source = join(workspace.root, "LICENSE");
    const destination = join(workspacePath(app, workspace), "LICENSE");
    await copyFile(
      (await exists(source)) ? source : join(repoRoot, "LICENSE"),
      destination,
    );
  }
}

async function stageWorkspaceOutput(
  build: string,
  app: string,
  workspace: Workspace,
  target: string,
): Promise<void> {
  const source = workspacePath(build, workspace);
  const destination = workspacePath(app, workspace);
  await copyParts(source, destination, ["dist"]);
  await copyOptional(source, destination, ["resources"]);
  if (workspace.manifest.name === runtimePackage)
    await copyParts(source, destination, [
      `native/${target}/themelios_runtime.node`,
    ]);
  for (const contract of Object.values(workspace.manifest.exports ?? {})) {
    for (const entry of [contract.types, contract.import]) {
      const path = join(destination, entry);
      if (!(await exists(path)))
        throw new Error("Missing workspace export: " + path);
    }
  }
}

async function captured(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const [exit, output] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  if (exit !== 0)
    throw new Error(`${command.join(" ")} failed with code ${exit}`);
  return output;
}

export interface WorkbenchMetadata {
  applicationId: string;
  formatId: string;
  recipes: { id: string; version: string }[];
}

export async function workbenchMetadata(
  app: string,
  entry: string,
): Promise<WorkbenchMetadata> {
  const source = `
    import { pathToFileURL } from 'node:url';
    const { workbenchApplication, releaseRecipes } = await import(pathToFileURL(process.argv[1]));
    console.log(JSON.stringify({ applicationId: workbenchApplication.id, formatId: workbenchApplication.formatId, recipes: releaseRecipes }));
  `;
  const output = await captured(
    [process.execPath, "--no-install", "-e", source, entry],
    app,
  );
  const metadata = JSON.parse(output) as WorkbenchMetadata;
  if (
    !metadata.applicationId ||
    !metadata.formatId ||
    !Array.isArray(metadata.recipes)
  )
    throw new Error("Missing Workbench release metadata");
  return metadata;
}

export async function writeNotices(
  candidate: string,
  appName: string,
): Promise<void> {
  const licenses = await captured(
    [process.execPath, "pm", "licenses", "--prod", "--filter", `${appName}...`],
    join(candidate, "app"),
  );
  const bunLicense = join(import.meta.dir, "BUN-LICENSE.md");
  const native =
    "Themelios Runtime native module and linked Rust crate license notices are in licenses/rust/.\n";
  await mkdir(join(candidate, "licenses"), { recursive: true });
  await copyFile(bunLicense, join(candidate, "licenses", "Bun.md"));
  await Bun.write(
    join(candidate, "THIRD-PARTY-NOTICES"),
    [
      "Bun license and linked libraries: licenses/Bun.md",
      native.trim(),
      "JavaScript package terms accompany their packages under app/node_modules/.",
      "",
      licenses.trimEnd(),
      "",
    ].join("\n"),
  );
}

interface Crate {
  manifest_path: string;
  name: string;
  version: string;
  license_file: string | null;
  license: string | null;
  source: string | null;
}

export async function rustNotices(
  build: string,
  candidate: string,
  triple: string,
): Promise<void> {
  const metadata = await captured(
    [
      "cargo",
      "metadata",
      "--locked",
      "--format-version",
      "1",
      "--filter-platform",
      triple,
    ],
    build,
  );
  const { packages } = JSON.parse(metadata) as { packages: Crate[] };
  const notices = join(candidate, "licenses", "rust");
  await mkdir(notices, { recursive: true });
  const summary: string[] = [];
  for (const crate of packages) {
    if (!crate.source) continue;
    summary.push(
      `${crate.name} ${crate.version} (${crate.license ?? "see license file"})`,
    );
    const root = dirname(crate.manifest_path);
    const paths = Array.from(
      new Bun.Glob("{LICENSE*,COPYING*,NOTICE*}").scanSync({
        cwd: root,
        onlyFiles: true,
      }),
    );
    if (crate.license_file && !paths.includes(crate.license_file))
      paths.push(crate.license_file);
    for (const file of paths) {
      const text = await readFile(join(root, file));
      await Bun.write(
        join(notices, `${crate.name}-${crate.version}`, basename(file)),
        text,
      );
    }
  }
  await Bun.write(join(notices, "INDEX"), `${summary.sort().join("\n")}\n`);
}
