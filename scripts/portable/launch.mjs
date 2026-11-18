import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const installationRoot = fileURLToPath(new URL("../", import.meta.url));
const workingDirectory = process.cwd();

/** @param {unknown} path */
function installedPath(path) {
  if (
    typeof path !== "string" ||
    !path ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    throw new Error(
      "The release has an invalid installation path: " + String(path),
    );
  }
  const result = resolve(installationRoot, path);
  const fromRoot = relative(installationRoot, result);
  if (
    !fromRoot ||
    isAbsolute(fromRoot) ||
    fromRoot === ".." ||
    fromRoot.startsWith(".." + sep)
  ) {
    throw new Error("The release refers outside the installation: " + path);
  }
  return result;
}

try {
  const manifest = JSON.parse(
    await readFile(new URL("./release.json", import.meta.url), "utf8"),
  );
  const target =
    process.platform === "win32"
      ? "windows-x64-msvc"
      : process.platform === "linux"
        ? "linux-x64-gnu"
        : undefined;
  if (
    manifest.schemaVersion !== 1 ||
    !target ||
    process.arch !== "x64" ||
    manifest.target !== target
  ) {
    throw new Error(
      "This Themelios release targets " +
        String(manifest.target) +
        ", current platform is " +
        process.platform +
        "/" +
        process.arch,
    );
  }
  if (
    manifest.runtime?.name !== "bun" ||
    manifest.runtime.version !== Bun.version
  ) {
    throw new Error(
      "This release requires its bundled Bun " +
        String(manifest.runtime?.version),
    );
  }
  await stat(installedPath(manifest.runtime.path));
  for (const path of Object.values(manifest.tools ?? {}))
    await stat(installedPath(path));
  const entry = installedPath(manifest.entry);
  if (!(await stat(entry)).isFile())
    throw new Error("Themelios application entry is missing: " + entry);
  const { runWorkbench, workbenchApplication } = await import(
    pathToFileURL(entry).href
  );
  if (
    typeof runWorkbench !== "function" ||
    workbenchApplication?.id !== manifest.applicationId ||
    workbenchApplication.formatId !== manifest.formatId
  ) {
    throw new Error(
      "The application entry does not match the Themelios release manifest",
    );
  }
  process.exitCode = await runWorkbench({
    installationRoot,
    cwd: workingDirectory,
    argv: process.argv.slice(2),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
