import { cc, type Library } from "bun:ffi";
import { Database as SQLite } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { linkSync } from "node:fs";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve, toNamespacedPath } from "node:path";
import { errorCode } from "./errors.js";
import windowsPublication from "./publish-windows.c" with { type: "file" };

const publicationSymbols = {
  publish_file: { args: ["ptr", "ptr"], returns: "u32" },
} as const;
let publication: Library<typeof publicationSymbols> | undefined;
const windowsErrors: Readonly<Record<number, string>> = {
  2: "ENOENT",
  3: "ENOENT",
  5: "EACCES",
  17: "EXDEV",
  32: "EBUSY",
  80: "EEXIST",
  183: "EEXIST",
};

function windowsPath(path: string): Buffer {
  if (path.includes("\0"))
    throw new TypeError("File paths cannot contain NUL.");
  return Buffer.from(toNamespacedPath(path) + "\0", "utf16le");
}

/** Publishes a closed, same-volume staged file without replacing any destination. */
export function publishNewFile(staged: string, destination: string): void {
  if (process.platform !== "win32") {
    linkSync(staged, destination);
    return;
  }
  const { symbols } = (publication ??= cc({
    source: resolve(import.meta.dir, windowsPublication),
    library: ["kernel32"],
    symbols: publicationSymbols,
  }));
  const number = symbols.publish_file(
    windowsPath(staged),
    windowsPath(destination),
  );
  if (number === 0) return;
  throw Object.assign(
    new Error(`MoveFileExW failed with Windows error ${number}`),
    {
      code: windowsErrors[number] ?? "EIO",
      path: staged,
      dest: destination,
    },
  );
}

/** Writes and syncs private bytes before handing the closed staged file to publication. */
export async function stageFile<T>(
  directory: string,
  fill: (handle: FileHandle) => Promise<T>,
  publish: (path: string, contents: T) => void | Promise<void>,
): Promise<T> {
  const path = join(directory, `.write-${randomUUID()}.partial`);
  const handle = await open(path, "wx", 0o600);
  try {
    let contents: T;
    try {
      contents = await fill(handle);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await publish(path, contents);
    return contents;
  } finally {
    // Publication has its own outcome. A remaining staging name can be removed offline.
    await unlink(path).catch(() => undefined);
  }
}

/** Borrows an OS-backed exclusive lock until the returned release function is called. Keep the lock path in place. */
export function tryExclusiveFileLock(path: string): (() => void) | undefined {
  const lock = new SQLite(path, { create: true });
  try {
    lock.exec(
      "PRAGMA journal_mode = DELETE; PRAGMA locking_mode = EXCLUSIVE; PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS lock_holder (id INTEGER PRIMARY KEY); REPLACE INTO lock_holder (id) VALUES (1);",
    );
  } catch (cause) {
    lock.close(true);
    if (errorCode(cause) === "SQLITE_BUSY") return undefined;
    throw cause;
  }
  return () => lock.close(true);
}
