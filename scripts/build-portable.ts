import { chmod, copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  installationDirectories,
  instanceConfigurationFiles,
} from "@themelios/core";
import { orderedWorkspaces, repoRoot, run, workspaces } from "./workspaces.js";
import {
  materializeLinks,
  publishRelease,
  removeBuildTree,
  requireNew,
} from "./portable/files.js";
import {
  buildInStaging,
  stageApplication,
  workbenchMetadata,
  writeNotices,
} from "./portable/staging.js";

const platforms = {
  win32: {
    name: "windows-x64-msvc",
    runtime: "bun.exe",
    launcher: "themelios.cmd",
    source: "launch.cmd",
    extension: ".zip",
  },
  linux: {
    name: "linux-x64-gnu",
    runtime: "bun",
    launcher: "themelios",
    source: "launch.sh",
    extension: ".tar.gz",
  },
} as const;
type Target = (typeof platforms)[keyof typeof platforms];

function targetFor(requested?: string): Target {
  const supported = Object.values(platforms).map((platform) => platform.name);
  if (requested && !supported.some((target) => target === requested))
    throw new Error("Unsupported Portable target: " + requested);
  const host = platforms[process.platform as keyof typeof platforms];
  if (
    !host ||
    process.arch !== "x64" ||
    (requested && requested !== host.name)
  ) {
    throw new Error(
      `Build ${requested ?? "Portable"} on its target Windows x64 or Linux x64 glibc host.`,
    );
  }
  if (process.platform === "linux") {
    const report = process.report?.getReport() as
      { header?: { glibcVersionRuntime?: string } } | undefined;
    if (!report?.header?.glibcVersionRuntime)
      throw new Error(
        "The linux-x64-gnu Portable build requires a glibc host.",
      );
  }
  return host;
}

async function copyLauncher(candidate: string, target: Target): Promise<void> {
  const template = join(import.meta.dir, "portable");
  const runtime = join(candidate, "runtime");
  await mkdir(runtime);
  await copyFile(process.execPath, join(runtime, target.runtime));
  await copyFile(
    join(template, target.source),
    join(candidate, target.launcher),
  );
  await copyFile(
    join(template, "launch.mjs"),
    join(candidate, "app", "launch.mjs"),
  );
  if (target.name === "linux-x64-gnu") {
    await chmod(join(candidate, target.launcher), 0o755);
    await chmod(join(runtime, target.runtime), 0o755);
  }
}

async function archive(
  candidate: string,
  output: string,
  target: Target,
): Promise<void> {
  const tar = Bun.which("tar");
  if (!tar)
    throw new Error("The target host needs its tar archive tool on PATH.");
  const options = target.name === "windows-x64-msvc" ? ["-a", "-cf"] : ["-czf"];
  await run(
    [
      tar,
      ...options,
      output,
      "-C",
      dirname(candidate),
      "--",
      basename(candidate),
    ],
    { quiet: true },
  );
}

export async function buildPortable(
  options: { target?: string; output?: string } = {},
): Promise<{ output: string; archive: string }> {
  const target = targetFor(options.target);
  const rootManifest = (await Bun.file(
    join(repoRoot, "package.json"),
  ).json()) as { packageManager: string };
  if (rootManifest.packageManager !== `bun@${Bun.version}`)
    throw new Error(
      `Use ${rootManifest.packageManager}; the current Bun is ${Bun.version}.`,
    );
  const all = await workspaces();
  const workbench = all.find(
    (item) => item.root === join(repoRoot, "apps", "workbench"),
  );
  if (!workbench)
    throw new Error("Missing Workbench package at apps/workbench.");
  const { name, version } = workbench.manifest;
  const closure = orderedWorkspaces(all, [name]);
  const entry = "app/apps/workbench/dist/main.js";
  const output =
    options.output === undefined
      ? join(
          repoRoot,
          "artifacts",
          "portable",
          `themelios-${version}-${target.name}`,
        )
      : resolve(options.output);
  const archiveOutput = output + target.extension;
  await requireNew(output);
  await requireNew(archiveOutput);

  const stagingRoot = join(repoRoot, "temp", "build", "portable");
  await mkdir(stagingRoot, { recursive: true });
  const staging = await mkdtemp(join(stagingRoot, `${target.name}-`));
  const build = join(staging, "build");
  // Keep the directory name the same inside the archive and at the chosen output path.
  const candidate = join(staging, "release", basename(output));
  const app = join(candidate, "app");
  const localArchive = join(staging, `archive${target.extension}`);
  try {
    await buildInStaging(build, all, closure, name);
    await stageApplication(build, app, all, closure, name);
    await materializeLinks(app);
    await copyLauncher(candidate, target);
    await mkdir(join(candidate, installationDirectories.config));
    await Bun.write(
      join(
        candidate,
        installationDirectories.config,
        instanceConfigurationFiles.installation,
      ),
      "# Installation settings\n",
    );
    await mkdir(join(candidate, installationDirectories.instances));
    await copyFile(join(repoRoot, "LICENSE"), join(candidate, "LICENSE"));

    const metadata = await workbenchMetadata(
      join(candidate, "app"),
      join(candidate, entry),
    );
    const manifest = {
      format: "themelios.portable",
      ...metadata,
      version,
      target: target.name,
      runtime: {
        name: "bun",
        version: Bun.version,
        path: `runtime/${target.runtime}`,
      },
      entry,
      packages: Object.fromEntries(
        closure.map((pkg) => [pkg.manifest.name, pkg.manifest.version]),
      ),
      tools: {},
    };
    await Bun.write(
      join(candidate, "app", "release.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await writeNotices(candidate, name);

    const bundled = join(candidate, "runtime", target.runtime);
    const launch = join(candidate, "app", "launch.mjs");
    await run([bundled, "--no-install", launch, "--help"], {
      cwd: staging,
      quiet: true,
    });
    await archive(candidate, localArchive, target);
    await mkdir(dirname(output), { recursive: true });
    await publishRelease(candidate, output, localArchive, archiveOutput);
    return { output, archive: archiveOutput };
  } finally {
    await removeBuildTree(staging).catch((error) =>
      console.error(`Cannot remove build staging ${staging}: ${String(error)}`),
    );
  }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      args: Bun.argv.slice(2).filter((arg) => arg !== "--"),
      options: { target: { type: "string" }, output: { type: "string" } },
    });
    const built = await buildPortable(values);
    console.log(built.output);
    console.log(built.archive);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
