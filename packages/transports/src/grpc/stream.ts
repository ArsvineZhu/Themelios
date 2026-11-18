import { create } from "@bufbuild/protobuf";
import { throwIfAborted, type Flow } from "@themelios/core";
import type { MaterialRead } from "@themelios/content";
import { transportError } from "../errors.js";
import { checkJsonSize } from "../json.js";
import {
  decodeOrigin,
  decodeProto,
  encodeArtifact,
  encodeProto,
  encodeTaskResult,
} from "./codec.js";
import {
  ArtifactInfoSchema,
  FlowEventSchema,
  ReadMaterialResponseSchema,
  OriginSchema,
  type UploadMaterialRequest,
} from "./generated/themelios/v1/application_pb.js";

const maxChunkBytes = 1024 * 1024;
const outgoingChunkBytes = 64 * 1024;

export async function withUpload<T>(
  messages: AsyncIterable<UploadMaterialRequest>,
  signal: AbortSignal,
  work: (input: unknown) => Promise<T>,
): Promise<T> {
  const iterator = messages[Symbol.asyncIterator]();
  let failure: unknown;
  let complete = false;
  let closing: Promise<unknown> | undefined;
  const close = () => (closing ??= Promise.resolve(iterator.return?.()));
  const abort = () => {
    void close().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    throwIfAborted(signal);
    const first = await iterator.next();
    if (first.done || first.value.part.case !== "metadata") {
      throw transportError("transport.invalid_request", {
        reason: "upload_metadata_required",
      });
    }
    const { mediaType, origin, name } = first.value.part.value;
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            throwIfAborted(signal);
            const next = await iterator.next();
            throwIfAborted(signal);
            if (next.done) {
              complete = true;
              controller.close();
            } else if (next.value.part.case !== "chunk") {
              throw transportError("transport.invalid_request", {
                reason: "upload_chunk_required",
              });
            } else {
              const chunk = next.value.part.value;
              if (chunk.byteLength > maxChunkBytes) {
                throw transportError("transport.request_too_large", {
                  actualBytes: chunk.byteLength,
                  maxBytes: maxChunkBytes,
                });
              }
              controller.enqueue(chunk);
            }
          } catch (error) {
            failure = error;
            controller.error(error);
          }
        },
        async cancel() {
          await close();
        },
      },
      { highWaterMark: 0 },
    );
    try {
      return await work({
        body: stream,
        mediaType,
        ...(name === undefined ? {} : { name }),
        ...(origin === undefined
          ? {}
          : { origin: decodeOrigin(decodeProto(OriginSchema, origin)) }),
      });
    } catch (error) {
      throw failure ?? error;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    if (!complete) await close();
  }
}

export async function* downloadMaterial(
  download: MaterialRead,
  maximum: number,
  signal: AbortSignal,
) {
  const reader = download.body.getReader();
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    throwIfAborted(signal);
    checkJsonSize(download.info, maximum, "result");
    yield create(ReadMaterialResponseSchema, {
      part: {
        case: "info",
        value: encodeProto(ArtifactInfoSchema, encodeArtifact(download.info)),
      },
    });
    while (true) {
      throwIfAborted(signal);
      const next = await reader.read();
      throwIfAborted(signal);
      if (next.done) break;
      for (
        let offset = 0;
        offset < next.value.byteLength;
        offset += outgoingChunkBytes
      ) {
        yield create(ReadMaterialResponseSchema, {
          part: {
            case: "chunk",
            value: next.value.subarray(offset, offset + outgoingChunkBytes),
          },
        });
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function* streamTask(flow: Flow<unknown>, maximum: number) {
  try {
    for await (const event of flow) {
      if (event.type === "progress") {
        yield create(FlowEventSchema, {
          event: { case: "progress", value: event.progress },
        });
      } else if (event.type === "text-delta") {
        yield create(FlowEventSchema, {
          event: { case: "textDelta", value: event.text },
        });
      } else {
        checkJsonSize(event.value, maximum, "result");
        yield encodeProto(FlowEventSchema, {
          result: encodeTaskResult(event.value),
        });
      }
    }
  } finally {
    flow.cancel("request ended");
  }
}
