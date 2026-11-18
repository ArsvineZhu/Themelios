import { randomUUID } from "node:crypto";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { throwIfAborted } from "@themelios/core";
import { fileErrorCode } from "./errors.js";

export async function* streamChunks(
  source: Uint8Array | ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    throwIfAborted(signal);
    yield source;
    return;
  }
  const reader = source.getReader();
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  let done = false;
  try {
    while (!done) {
      throwIfAborted(signal);
      const next = await reader.read();
      done = next.done;
      throwIfAborted(signal);
      if (!next.done) yield next.value;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!done) cancel();
    reader.releaseLock();
  }
}

export async function writeChunk(
  handle: FileHandle,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
    );
    if (bytesWritten === 0) throw new Error("File write did not advance");
    offset += bytesWritten;
  }
}

export async function stageFile<T>(
  directory: string,
  fill: (handle: FileHandle) => Promise<T>,
  publish: (path: string, contents: T) => Promise<void>,
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
    await unlink(path).catch((error) => {
      if (fileErrorCode(error) !== "ENOENT") throw error;
    });
  }
}

export async function syncParent(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(dirname(path), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
