import {
  fromJson,
  fromJsonString,
  toJson,
  type MessageInitShape,
} from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import {
  Code,
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from "@connectrpc/connect";
import { throwIfAborted, type Flow } from "@themelios/core";
import {
  callOperation,
  type BinaryReadResult,
  type OperationContext,
  type OperationDirectory,
} from "@themelios/runtime/operations";
import {
  errorLocale,
  httpStatus,
  localizedError,
  transportError,
} from "../errors.js";
import { checkJsonSize } from "../json.js";
import {
  authenticateRequest,
  RequestTracker,
  validateWebOrigin,
} from "../request.js";
import type { RemoteOperationOptions } from "../types.js";
import {
  FailureSchema,
  Operations,
  type OperationEventSchema,
  type OperationRequest,
  type UploadFrame,
} from "./operations_pb.js";

type Event = NonNullable<
  MessageInitShape<typeof OperationEventSchema>["event"]
>;
type Call = OperationContext & {
  maxJsonBytes: number;
  options: { signal: AbortSignal };
};
const downloadChunkBytes = 64 * 1024;

const statuses = new Map<number, Code>([
  [400, Code.InvalidArgument],
  [401, Code.Unauthenticated],
  [403, Code.PermissionDenied],
  [404, Code.NotFound],
  [409, Code.FailedPrecondition],
  [410, Code.FailedPrecondition],
  [413, Code.ResourceExhausted],
  [415, Code.InvalidArgument],
  [422, Code.InvalidArgument],
  [429, Code.ResourceExhausted],
  [499, Code.Canceled],
  [502, Code.Unavailable],
  [503, Code.Unavailable],
  [504, Code.DeadlineExceeded],
]);

function grpcError(
  error: unknown,
  rpc: HandlerContext,
  locale: string,
  options: RemoteOperationOptions,
) {
  const reason = rpc.signal.reason;
  const mapped =
    reason instanceof ConnectError && reason.code === Code.DeadlineExceeded
      ? transportError("call.timeout", undefined, reason)
      : reason instanceof ConnectError && reason.code === Code.Canceled
        ? transportError("call.cancelled", undefined, reason)
        : error;
  const { details, ...info } = localizedError(
    mapped,
    locale,
    options.translate,
  );
  const code =
    info.code === "storage.already_exists" ||
    info.code === "runtime.instance_exists"
      ? Code.AlreadyExists
      : (statuses.get(httpStatus(info.code)) ?? Code.Internal);
  return new ConnectError(
    info.message,
    code,
    undefined,
    [
      {
        desc: FailureSchema,
        value: {
          ...info,
          ...(details === undefined
            ? {}
            : { details: fromJson(ValueSchema, details) }),
        },
      },
    ],
    error,
  );
}

function readInput(request: OperationRequest, limit: number) {
  const input =
    request.input === undefined ? {} : toJson(ValueSchema, request.input);
  checkJsonSize(input, limit, "request");
  return input;
}

async function readUploadHeader(
  iterator: AsyncIterator<UploadFrame>,
  limit: number,
) {
  const first = await iterator.next();
  if (first.done || first.value.part.case !== "request")
    throw transportError("transport.invalid_request", {
      reason: "expected_upload_request",
    });
  const request = first.value.part.value;
  const metadata = readInput(request, limit);
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    Object.hasOwn(metadata, "body")
  ) {
    throw transportError("transport.invalid_request", {
      reason: "expected_upload_metadata",
    });
  }
  return { operation: request.operation, metadata };
}

function encodeOutput(output: unknown, limit: number) {
  return fromJsonString(ValueSchema, checkJsonSize(output, limit, "result"));
}

function receivedBytes(
  iterator: AsyncIterator<UploadFrame>,
  signal: AbortSignal,
  close: () => Promise<void>,
) {
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        throwIfAborted(signal);
        const next = await iterator.next();
        throwIfAborted(signal);
        if (next.done) {
          controller.close();
          return;
        }
        if (next.value.part.case !== "chunk") {
          throw transportError("transport.invalid_request", {
            reason: "expected_upload_chunk",
          });
        }
        controller.enqueue(next.value.part.value);
      },
      cancel: close,
    },
    { highWaterMark: 0 },
  );
}

async function* download(
  result: BinaryReadResult,
  call: Call,
): AsyncGenerator<Event> {
  const reader = result.body.getReader();
  try {
    checkJsonSize(result.info, call.maxJsonBytes, "result");
    yield {
      case: "download",
      value: { ...result.info, sizeBytes: BigInt(result.info.sizeBytes) },
    };
    while (true) {
      throwIfAborted(call.options.signal);
      const next = await reader.read();
      if (next.done) return;
      for (
        let start = 0;
        start < next.value.byteLength;
        start += downloadChunkBytes
      ) {
        yield {
          case: "chunk",
          value: next.value.subarray(start, start + downloadChunkBytes),
        };
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function* flowEvents(
  flow: Flow<unknown>,
  limit: number,
): AsyncGenerator<Event> {
  for await (const event of flow) {
    switch (event.type) {
      case "progress":
        checkJsonSize(event.progress, limit, "result");
        yield { case: "progress", value: event.progress };
        break;
      case "text-delta":
        checkJsonSize(event.text, limit, "result");
        yield { case: "textDelta", value: event.text };
        break;
      case "result":
        yield { case: "result", value: encodeOutput(event.value, limit) };
    }
  }
}

export function grpcOperations<App>(
  app: App,
  directory: OperationDirectory<App>,
  options: RemoteOperationOptions<App>,
  tracker: RequestTracker,
): ServiceImpl<typeof Operations> {
  function localeFor(rpc: HandlerContext) {
    return errorLocale(
      rpc.requestHeader.get("accept-language"),
      options.locale?.(),
      options.languages,
    );
  }

  async function authorize(
    rpc: HandlerContext,
    signal: AbortSignal,
    locale: string,
  ): Promise<Call> {
    const policy = options.policy();
    validateWebOrigin(
      new Request(rpc.url, { headers: rpc.requestHeader }),
      policy,
    );
    const principal = await authenticateRequest(
      rpc.requestHeader,
      options,
      policy,
      signal,
    );
    return {
      principal,
      locale,
      maxJsonBytes: policy.maxJsonBytes,
      options: { signal },
    };
  }

  function kind(id: string) {
    const operation = directory.get(id);
    if (!operation)
      throw transportError("transport.not_found", { operation: id });
    return operation.kind ?? "unary";
  }

  async function* streaming(
    rpc: HandlerContext,
    work: (call: Call) => AsyncIterable<Event>,
  ) {
    const locale = localeFor(rpc);
    let lease: ReturnType<RequestTracker["take"]> | undefined;
    try {
      lease = tracker.take(rpc.signal);
      const call = await authorize(rpc, lease.signal, locale);
      for await (const event of work(call)) yield { event };
    } catch (error) {
      throw grpcError(error, rpc, locale, options);
    } finally {
      lease?.close();
    }
  }

  return {
    async invoke(request, rpc) {
      const locale = localeFor(rpc);
      let lease: ReturnType<RequestTracker["take"]> | undefined;
      try {
        lease = tracker.take(rpc.signal);
        const call = await authorize(rpc, lease.signal, locale);
        if (kind(request.operation) !== "unary") {
          throw transportError("transport.invalid_request", {
            operation: request.operation,
            reason: "use_stream",
          });
        }
        const input = readInput(request, call.maxJsonBytes);
        const output = await callOperation(
          app,
          directory,
          request.operation,
          input,
          call,
        );
        return { result: encodeOutput(output, call.maxJsonBytes) };
      } catch (error) {
        throw grpcError(error, rpc, locale, options);
      } finally {
        lease?.close();
      }
    },
    stream(request, rpc) {
      return streaming(rpc, async function* (call) {
        const type = kind(request.operation);
        if (type === "unary") {
          throw transportError("transport.invalid_request", {
            operation: request.operation,
            reason: "use_invoke",
          });
        }
        const input = readInput(request, call.maxJsonBytes);
        const output = callOperation(
          app,
          directory,
          request.operation,
          input,
          call,
        );
        if (type === "stream")
          yield* flowEvents(output as Flow<unknown>, call.maxJsonBytes);
        else yield* download((await output) as BinaryReadResult, call);
      });
    },
    upload(frames, rpc) {
      return streaming(rpc, async function* (call) {
        const iterator = frames[Symbol.asyncIterator]();
        let closed: Promise<void> | undefined;
        const close = () => {
          closed ??= (async () => {
            await iterator.return?.();
          })().catch(() => undefined);
          return closed;
        };
        try {
          const { operation, metadata } = await readUploadHeader(
            iterator,
            call.maxJsonBytes,
          );
          const type = kind(operation);
          if (type === "binary-read")
            throw transportError("transport.invalid_request", {
              reason: "use_stream",
            });
          const payload = {
            ...metadata,
            body: receivedBytes(iterator, call.options.signal, close),
          };
          const output = callOperation(
            app,
            directory,
            operation,
            payload,
            call,
            true,
          );
          if (type === "stream")
            yield* flowEvents(output as Flow<unknown>, call.maxJsonBytes);
          else
            yield {
              case: "result",
              value: encodeOutput(await output, call.maxJsonBytes),
            };
        } finally {
          await close();
        }
      });
    },
  };
}
