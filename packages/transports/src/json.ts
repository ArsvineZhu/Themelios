import { streamChunks } from "@themelios/core";
import { transportError } from "./errors.js";

export const defaultMaxJsonBytes = 8 * 1024 * 1024;

export function checkJsonSize(
  value: unknown,
  maxJsonBytes: number,
  direction: "request" | "result",
): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw transportError("internal.unexpected");
  const size = Buffer.byteLength(encoded);
  if (size > maxJsonBytes)
    throw transportError("transport." + direction + "_too_large", {
      actualBytes: size,
      maxJsonBytes,
      alternative:
        "Use an artifact reference or the binary material endpoints.",
    });
  return encoded;
}

export const jsonText = (value: unknown, maxJsonBytes = defaultMaxJsonBytes) =>
  checkJsonSize(value, maxJsonBytes, "result");

export async function readJson(
  request: Request,
  maximum: number,
  signal: AbortSignal,
): Promise<unknown> {
  const size = Number(request.headers.get("content-length"));
  if (size > maximum)
    throw transportError("transport.request_too_large", {
      actualBytes: size,
      maxJsonBytes: maximum,
    });
  const body = request.body;
  if (!body) return {};
  let received = 0;
  const text = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  for await (const chunk of streamChunks(body, signal)) {
    received += chunk.byteLength;
    if (received > maximum)
      throw transportError("transport.request_too_large", {
        actualBytes: received,
        maxJsonBytes: maximum,
      });
    try {
      parts.push(text.decode(chunk, { stream: true }));
    } catch (cause) {
      throw transportError(
        "transport.invalid_request",
        { reason: "invalid_utf8" },
        cause,
      );
    }
  }
  try {
    return received
      ? (JSON.parse(parts.join("") + text.decode()) as unknown)
      : {};
  } catch (cause) {
    throw transportError(
      "transport.invalid_request",
      { reason: "invalid_json" },
      cause,
    );
  }
}
