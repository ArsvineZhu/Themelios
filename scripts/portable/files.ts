import { constants } from "node:fs";
import {
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

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

/** Checks packaged links before the standard copier materializes them. */
export async function materialize(
  source: string,
  destination: string,
): Promise<void> {
  const root = await realpath(source);
  const queue = [root];
  for (const directory of queue) {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, child.name);
      if (child.isDirectory()) queue.push(path);
      if (child.isSymbolicLink()) {
        const target = await realpath(path);
        if (outside(root, target) || !outside(target, directory)) {
          throw new Error(
            `Package link escapes the staging directory or creates a cycle: ${path} -> ${target}`,
          );
        }
      }
    }
  }
  await cp(root, destination, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    force: false,
  });
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

export async function publishDirectory(
  candidate: string,
  output: string,
): Promise<void> {
  await requireNew(output);
  try {
    await rename(candidate, output);
  } catch (error) {
    if (errorCode(error) !== "EXDEV") throw error;
    const adjacent = join(
      dirname(output),
      `.${basename(output)}-${randomUUID()}.partial`,
    );
    await mkdir(adjacent);
    try {
      await cp(candidate, adjacent, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await requireNew(output);
      await rename(adjacent, output);
    } finally {
      await removeBuildTree(adjacent);
    }
  }
}

export async function publishFile(
  candidate: string,
  output: string,
): Promise<void> {
  try {
    await link(candidate, output);
  } catch (error) {
    if (errorCode(error) !== "EXDEV") throw error;
    const adjacent = join(
      dirname(output),
      `.${basename(output)}-${randomUUID()}.partial`,
    );
    await copyFile(candidate, adjacent, constants.COPYFILE_EXCL);
    try {
      await link(adjacent, output);
    } finally {
      await unlink(adjacent);
    }
  }
}
