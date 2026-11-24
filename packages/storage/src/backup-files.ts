import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { appError, errorCode, throwIfAborted } from "@themelios/core";

export async function existing(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

export async function copyBackupFile(
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await pipeline(
    createReadStream(source),
    createWriteStream(destination, { mode: 0o600, flush: true }),
    signal ? { signal } : {},
  );
}

export const defaultBackupPaths: readonly string[] = [
  "config/instance.toml",
  "config/managed.toml",
  "config/prompts",
];

export async function copyConfiguration(
  source: string,
  destination: string,
  paths: readonly string[],
  options: { signal?: AbortSignal; required: boolean },
): Promise<string[]> {
  const { signal, required } = options;
  const copied: string[] = [];
  const selected = new Set([
    "instance.json",
    ...paths.map((path) => path.replaceAll("\\", "/")),
  ]);
  for (const relative of selected) {
    throwIfAborted(signal);
    if (
      relative !== "instance.json" &&
      (!relative.startsWith("config/") ||
        relative.split("/").some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            // oxlint-disable-next-line no-control-regex -- Reject non-portable path characters.
            /[:<>|?*"\x00-\x1f]|[. ]$/.test(part),
        ))
    ) {
      throw appError("storage.backup_invalid", {
        details: {
          path: relative,
          reason: "expected a relative path under config/",
        },
      });
    }
    let parent = source;
    for (const part of relative.split("/").slice(0, -1)) {
      parent = join(parent, part);
      const info = await existing(parent);
      if (info && !info.isDirectory())
        throw appError("storage.backup_invalid", {
          details: {
            path: parent,
            reason: "expected a directory",
          },
        });
    }
    if (
      await copyTree(
        join(source, relative),
        join(destination, relative),
        signal,
      )
    ) {
      copied.push(relative);
    } else if (required || relative === "instance.json") {
      throw appError("storage.backup_invalid", {
        details: {
          path: relative,
          reason: "configuration path is missing",
        },
      });
    }
  }
  return copied;
}

async function copyTree(
  source: string,
  destination: string,
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfAborted(signal);
  const info = await existing(source);
  if (!info) return false;
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source))
      await copyTree(join(source, entry), join(destination, entry), signal);
  } else if (info.isFile()) {
    await mkdir(dirname(destination), { recursive: true });
    await copyBackupFile(source, destination, signal);
  } else {
    throw appError("storage.backup_invalid", {
      details: {
        path: source,
        reason: "expected a regular file",
      },
    });
  }
  return true;
}

/** Removes the private tree created by the current maintenance operation. */
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
