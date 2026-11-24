import { open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { throwIfAborted } from "@themelios/core";

export async function writeChunk(
  handle: FileHandle,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    throwIfAborted(signal);
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
    );
    if (bytesWritten === 0) throw new Error("File write did not advance");
    offset += bytesWritten;
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
