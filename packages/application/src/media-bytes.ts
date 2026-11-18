import { appError, openCall, type CallOptions } from "@themelios/core";
import type { MediaInput } from "./input-contracts.js";

/** Consume one source under the current byte and cancellation budget. */
export async function readMediaBytes(
  input: MediaInput,
  options?: CallOptions,
  maxBytes = 67_108_864,
): Promise<Uint8Array> {
  const scope = openCall("input.media_read", options);
  function oversized(actual: number): never {
    throw appError("model.input_too_large", {
      details: {
        name: input.info.name ?? null,
        mediaType: input.info.mediaType,
        maxBytes,
        actualBytes: actual,
      },
    });
  }
  try {
    scope.throwIfAborted();
    if (input.info.sizeBytes > maxBytes) oversized(input.info.sizeBytes);
    const body = await input.open({ signal: scope.signal });
    const reader = body.getReader();
    const abort = () => {
      void reader.cancel(scope.signal.reason).catch(() => undefined);
    };
    scope.signal.addEventListener("abort", abort, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    let done = false;
    try {
      while (!done) {
        scope.throwIfAborted();
        const next = await reader.read();
        done = next.done;
        scope.throwIfAborted();
        if (!next.done) {
          size += next.value.byteLength;
          if (size > maxBytes) oversized(size);
          chunks.push(next.value);
        }
      }
    } finally {
      scope.signal.removeEventListener("abort", abort);
      if (!done) abort();
      reader.releaseLock();
    }
    if (chunks.length === 1) return chunks[0]!;
    const bytes = new Uint8Array(size);
    let cursor = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    return bytes;
  } finally {
    scope.close();
  }
}
