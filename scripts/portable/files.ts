import { createReadStream } from "node:fs";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { errorCode } from "../../packages/core/src/errors.js";
import { publishNewFile, stageFile } from "../../packages/core/src/files.js";

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

export async function copyEntry(
  source: string,
  destination: string,
): Promise<void> {
  const info = await lstat(source);
  await mkdir(dirname(destination), { recursive: true });
  if (info.isDirectory())
    await cp(source, destination, { recursive: true, verbatimSymlinks: true });
  else if (info.isFile()) await copyFile(source, destination);
  else throw new Error("Unexpected build input: " + source);
}

function outside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return (
    isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)
  );
}

/** Replaces package links inside the private release tree with their files. */
export async function materializeLinks(app: string): Promise<void> {
  const root = await realpath(app);
  const links: { path: string; target: string }[] = [];
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const child of entries) {
    if (!child.isSymbolicLink()) continue;
    const path = join(child.parentPath, child.name);
    const target = await realpath(path);
    if (outside(root, target) || !outside(target, child.parentPath)) {
      throw new Error(
        `Package link escapes the staging directory or creates a cycle: ${path} -> ${target}`,
      );
    }
    links.push({ path, target });
  }
  for (const { path, target } of links) {
    await unlink(path);
    await cp(target, path, {
      recursive: true,
      dereference: true,
      errorOnExist: true,
      force: false,
    });
  }
}

/** Cleans only the exact private staging path created by this build. */
export async function removeBuildTree(root: string): Promise<void> {
  if (!(await exists(root))) return;
  if (!(await lstat(root)).isDirectory())
    throw new Error("Build staging is not a directory: " + root);
  const levels = [[root]];
  for (const level of levels) {
    const directories: string[] = [];
    for (const path of level)
      await removeFilesAndFindDirectories(path, directories);
    if (directories.length > 0) levels.push(directories);
  }
  for (const level of levels.reverse()) await removeInBatches(level, rmdir);
}

async function removeFilesAndFindDirectories(
  path: string,
  directories: string[],
): Promise<void> {
  const files: string[] = [];
  for (const child of await readdir(path, { withFileTypes: true })) {
    (child.isDirectory() ? directories : files).push(join(path, child.name));
  }
  await removeInBatches(files, unlink);
}

async function removeInBatches(
  paths: readonly string[],
  remove: (path: string) => Promise<void>,
): Promise<void> {
  for (let start = 0; start < paths.length; start += 32)
    await Promise.all(
      paths.slice(start, start + 32).map((path) => remove(path)),
    );
}

export async function requireNew(path: string): Promise<void> {
  if (await exists(path))
    throw new Error("Release output already exists: " + path);
}

async function publishDirectory(
  candidate: string,
  output: string,
): Promise<void> {
  await requireNew(output);
  try {
    await rename(candidate, output);
  } catch (error) {
    if (errorCode(error) !== "EXDEV") throw error;
    const adjacent = await mkdtemp(
      join(dirname(output), `.${basename(output)}-`),
    );
    const copy = join(adjacent, basename(output));
    try {
      await cp(candidate, copy, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await requireNew(output);
      await rename(copy, output);
    } finally {
      await removeBuildTree(adjacent).catch((cleanup) =>
        console.error(
          `Cannot remove release staging ${adjacent}: ${String(cleanup)}`,
        ),
      );
    }
  }
}

async function publishFile(candidate: string, output: string): Promise<void> {
  try {
    publishNewFile(candidate, output);
  } catch (error) {
    if (errorCode(error) !== "EXDEV") throw error;
    await stageFile(
      dirname(output),
      (file) => file.writeFile(createReadStream(candidate)),
      (path) => publishNewFile(path, output),
    );
  }
}

/** Publishes the archive first, so archive failure leaves the output directory available for retry. */
export async function publishRelease(
  candidate: string,
  output: string,
  archive: string,
  archiveOutput: string,
): Promise<void> {
  await publishFile(archive, archiveOutput);
  try {
    await publishDirectory(candidate, output);
  } catch (error) {
    try {
      await unlink(archiveOutput);
    } catch (rollback) {
      if (errorCode(rollback) !== "ENOENT")
        throw new AggregateError(
          [error, rollback],
          `Release publication failed and ${archiveOutput} could not be removed`,
          { cause: error },
        );
    }
    throw error;
  }
}
