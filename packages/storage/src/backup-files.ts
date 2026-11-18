import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileErrorCode, storageError } from "./errors.js";

export async function existing(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

const configuration = [
  "instance.json",
  "config/instance.toml",
  "config/managed.toml",
  "config/prompts",
];

export async function copyConfiguration(
  source: string,
  destination: string,
  paths = configuration,
): Promise<void> {
  for (const path of new Set(["instance.json", ...paths])) {
    const relative = path.replaceAll("\\", "/");
    if (
      !configuration.includes(relative) &&
      !(
        relative.startsWith("config/prompts/") &&
        relative
          .split("/")
          .every((part) => part && part !== "." && part !== "..")
      )
    ) {
      throw storageError("storage.backup_invalid", {
        path,
        reason: "unmanaged configuration path",
      });
    }
    let parent = source;
    for (const part of relative.split("/").slice(0, -1)) {
      parent = join(parent, part);
      const info = await existing(parent);
      if (info && !info.isDirectory())
        throw storageError("storage.backup_invalid", {
          path: parent,
          reason: "expected a directory",
        });
    }
    await copyTree(join(source, relative), join(destination, relative));
  }
}

async function copyTree(source: string, destination: string): Promise<void> {
  const info = await existing(source);
  if (!info) return;
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source))
      await copyTree(join(source, entry), join(destination, entry));
  } else if (info.isFile()) {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  } else {
    throw storageError("storage.backup_invalid", {
      path: source,
      reason: "expected a regular file",
    });
  }
}

/** Removes only the private directory created for this failed restore. */
export async function removeStaging(root: string): Promise<void> {
  const entries = [root];
  const directories: string[] = [];
  for (const path of entries) {
    const info = await existing(path);
    if (!info) continue;
    if (info.isDirectory()) {
      directories.push(path);
      for (const child of await readdir(path)) entries.push(join(path, child));
    } else await unlink(path);
  }
  for (const directory of directories.reverse()) await rmdir(directory);
}
