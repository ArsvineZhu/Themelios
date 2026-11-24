import { resolve } from "node:path";
import { appError, parseJson, streamChunks, type Json } from "@themelios/core";
import { InvalidArgumentError } from "commander";

export function nonnegativeInt(value: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number)) {
    throw new InvalidArgumentError("Expected a nonnegative integer.");
  }
  return number;
}

export function cliInputError(reason: string, cause?: unknown): never {
  throw appError("transport.invalid_request", { details: { reason }, cause });
}

export function jsonCliInput(text: string): Json {
  try {
    return parseJson(JSON.parse(text));
  } catch (cause) {
    return cliInputError("Expected a valid JSON value", cause);
  }
}

export function objectCliInput(input: Json): Record<string, Json> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return cliInputError("Expected a JSON object");
  }
  return input;
}

export async function readCliInput(
  path: string,
  cwd: string,
  maxBytes: number,
): Promise<Json> {
  if (path !== "-") {
    const file = Bun.file(resolve(cwd, path));
    if (file.size > maxBytes) {
      throw appError("transport.request_too_large", {
        details: { maxJsonBytes: maxBytes },
      });
    }
    return jsonCliInput(await file.text());
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of streamChunks(Bun.stdin.stream())) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      throw appError("transport.request_too_large", {
        details: { maxJsonBytes: maxBytes },
      });
    }
    chunks.push(new Uint8Array(chunk));
  }
  return jsonCliInput(Buffer.concat(chunks, size).toString("utf8"));
}
