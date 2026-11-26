import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { once } from "node:events";
import {
  appError,
  errorCode,
  streamChunks,
  throwIfAborted,
} from "@themelios/core";
import { publishNewFile, stageFile } from "@themelios/core/files";
import { jsonText } from "../json.js";

export async function ensureNewFile(destination: string): Promise<void> {
  try {
    await access(destination);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") {
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
  result: unknown,
): Promise<void> {
  try {
    await stageFile(
      dirname(destination),
      (file) => file.writeFile(jsonText(result, Infinity) + "\n", "utf8"),
      (path) => publishNewFile(path, destination),
    );
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
    const code =
      errorCode(cause) === "EEXIST"
        ? "storage.already_exists"
        : "transport.delivery_failed";
    throw appError(code, { details, cause });
  }
}

export async function writeStdout(
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (!process.stdout.write(text))
    await once(process.stdout, "drain", signal ? { signal } : {});
}

export async function streamStdout(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  for await (const chunk of streamChunks(stream, signal)) {
    if (!process.stdout.write(chunk)) {
      await once(process.stdout, "drain", signal ? { signal } : {});
    }
  }
}
