import { randomUUID } from "node:crypto";
import { access, link, open, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { once } from "node:events";
import { AppError, appError, throwIfAborted } from "@themelios/core";

export async function ensureNewFile(destination: string): Promise<void> {
  try {
    await access(destination);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      await access(dirname(destination));
      return;
    }
    throw appError("transport.delivery_failed", {
      details: { path: destination },
      cause,
    });
  }
  throw appError("storage.already_exists", {
    details: { operation: "output", path: destination },
  });
}

export async function publishOutput(
  destination: string,
  text: string,
  result: unknown,
): Promise<void> {
  const temporary = join(
    dirname(destination),
    "." + basename(destination) + "." + randomUUID() + ".tmp",
  );
  let created = false;
  try {
    const file = await open(temporary, "wx");
    created = true;
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporary, destination);
    } catch (cause) {
      if (
        cause instanceof Error &&
        "code" in cause &&
        cause.code === "EEXIST"
      ) {
        throw appError("storage.already_exists", {
          details: { operation: "output", path: destination },
          cause,
        });
      }
      throw cause;
    }
  } catch (cause) {
    const ref =
      result !== null &&
      typeof result === "object" &&
      "ref" in result &&
      typeof result.ref === "string"
        ? result.ref
        : undefined;
    const details = {
      path: destination,
      ...(ref === undefined ? {} : { ref }),
    };
    if (cause instanceof AppError)
      throw appError(cause.code, { details, cause });
    throw appError("transport.delivery_failed", { details, cause });
  } finally {
    if (created) await unlink(temporary);
  }
}

export async function writeStdout(
  data: string | Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (!process.stdout.write(data))
    await once(process.stdout, "drain", signal ? { signal } : {});
}

export async function streamStdout(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      throwIfAborted(signal);
      const chunk = await reader.read();
      if (chunk.done) return;
      await writeStdout(chunk.value, signal);
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
