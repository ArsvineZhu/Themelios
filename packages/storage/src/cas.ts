import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  AppError,
  appError,
  blobDigestAlgorithm,
  blobDigestHexCharacters,
  blobRefFromDigest,
  blobRefPrefix,
  blobRefSchema,
  errorCode,
  openCall,
  type BlobRef,
  type CallOptions,
} from "@themelios/core";
import { publishNewFile, stageFile } from "@themelios/core/files";
import { streamChunks } from "@themelios/core";
import { syncParent, writeChunk } from "./files.js";

export interface BlobInfo {
  ref: BlobRef;
  sizeBytes: number;
}

const shardWidth = 2;
const shardPattern = new RegExp(
  `^[${blobDigestHexCharacters}]{${shardWidth}}$`,
);
export const casStagingDirectory = "tmp";

export function casObjectsPath(root: string): string {
  return join(root, blobDigestAlgorithm);
}

export function isObjectShard(name: string): boolean {
  return shardPattern.test(name);
}

export function objectRef(shard: string, name: string): BlobRef | undefined {
  const ref = blobRefSchema.safeParse(`${blobRefPrefix}${shard}${name}`);
  return ref.success ? ref.data : undefined;
}

export function objectPath(root: string, ref: BlobRef): string {
  const parsed = blobRefSchema.safeParse(ref);
  if (!parsed.success)
    throw appError("storage.blob_ref_invalid", { details: { blobRef: ref } });
  const digest = parsed.data.slice(blobRefPrefix.length);
  return join(
    casObjectsPath(root),
    digest.slice(0, shardWidth),
    digest.slice(shardWidth),
  );
}

function objectSize(info: Stats, ref: BlobRef, path: string): number {
  if (!info.isFile())
    throw appError("storage.blob_corrupt", {
      details: { blobRef: ref, path, expected: "file", actual: "non-file" },
    });
  return info.size;
}

/** Publishes immutable exact bytes before any application transaction adopts a reference. */
export class Cas {
  readonly root: string;
  readonly #streams = new Set<() => Promise<void>>();
  readonly #stopping = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  #closing: Promise<void> | undefined;

  private constructor(root: string) {
    this.root = root;
  }

  static async open(root: string): Promise<Cas> {
    return new Cas(resolve(root));
  }

  #operation(operation: string, options?: CallOptions) {
    if (this.#stopping.signal.aborted) throw this.#stopping.signal.reason;
    return openCall(operation, {
      ...options,
      signal: options?.signal
        ? AbortSignal.any([options.signal, this.#stopping.signal])
        : this.#stopping.signal,
    });
  }

  async #track<T>(operation: Promise<T>): Promise<T> {
    this.#pending.add(operation);
    try {
      return await operation;
    } finally {
      this.#pending.delete(operation);
    }
  }

  put(
    input: Uint8Array | ReadableStream<Uint8Array>,
    options?: CallOptions & { maxBytes?: number },
  ): Promise<BlobInfo> {
    return this.#track(this.#put(input, options));
  }

  async #put(
    input: Uint8Array | ReadableStream<Uint8Array>,
    options?: CallOptions & { maxBytes?: number },
  ): Promise<BlobInfo> {
    const scope = this.#operation("storage.put", options);
    const temporary = join(this.root, casStagingDirectory);
    const maxBytes = options?.maxBytes ?? Number.MAX_SAFE_INTEGER;
    try {
      scope.throwIfAborted();
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
        throw appError("storage.options_invalid", {
          details: { field: "maxBytes" },
        });
      const inline = input instanceof Uint8Array;
      if (inline && input.byteLength > maxBytes)
        throw appError("storage.limit_exceeded", {
          details: {
            maxBytes,
            sizeBytes: input.byteLength,
          },
        });
      const source = inline
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(input));
              controller.close();
            },
          })
        : input;
      await mkdir(temporary, { recursive: true });
      return await stageFile(
        temporary,
        async (handle) => {
          const hash = createHash(blobDigestAlgorithm);
          let sizeBytes = 0;
          for await (const chunk of streamChunks(source, scope.signal)) {
            const bytes = inline ? chunk : new Uint8Array(chunk);
            sizeBytes += bytes.byteLength;
            if (sizeBytes > maxBytes)
              throw appError("storage.limit_exceeded", {
                details: {
                  maxBytes,
                  sizeBytes,
                },
              });
            hash.update(bytes);
            await writeChunk(handle, bytes, scope.signal);
          }
          return { ref: blobRefFromDigest(hash.digest("hex")), sizeBytes };
        },
        async (path, { ref, sizeBytes }) => {
          scope.throwIfAborted();
          const destination = objectPath(this.root, ref);
          await mkdir(dirname(destination), { recursive: true });
          scope.throwIfAborted();
          try {
            publishNewFile(path, destination);
          } catch (error) {
            if (errorCode(error) !== "EEXIST") throw error;
            const existing = await this.stat(ref);
            if (existing.sizeBytes !== sizeBytes) {
              throw appError("storage.blob_corrupt", {
                details: {
                  blobRef: ref,
                  expected: sizeBytes,
                  actual: existing.sizeBytes,
                },
              });
            }
          }
          await syncParent(destination);
        },
      );
    } catch (error) {
      scope.throwIfAborted();
      if (error instanceof AppError) throw error;
      throw appError("storage.write_failed", {
        details: { operation: "put", path: temporary, reason: String(error) },
        cause: error,
      });
    } finally {
      scope.close();
    }
  }

  async stat(ref: BlobRef): Promise<BlobInfo> {
    if (this.#stopping.signal.aborted) throw this.#stopping.signal.reason;
    const path = objectPath(this.root, ref);
    try {
      return { ref, sizeBytes: objectSize(await stat(path), ref, path) };
    } catch (error) {
      throw this.#readFailure(error, ref, path);
    }
  }

  read(
    ref: BlobRef,
    options?: CallOptions & { start?: number; end?: number },
  ): Promise<ReadableStream<Uint8Array>> {
    return this.#track(this.#read(ref, options));
  }

  async #read(
    ref: BlobRef,
    options?: CallOptions & { start?: number; end?: number },
  ): Promise<ReadableStream<Uint8Array>> {
    const path = objectPath(this.root, ref);
    const scope = this.#operation("storage.read", options);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      scope.throwIfAborted();
      handle = await open(path, "r");
      const size = objectSize(await handle.stat(), ref, path);
      const start = options?.start ?? 0;
      const end = options?.end ?? size;
      if (
        ![start, end].every(Number.isSafeInteger) ||
        start < 0 ||
        end < start ||
        end > size
      ) {
        throw appError("storage.range_invalid", {
          details: {
            blobRef: ref,
            start,
            end,
            sizeBytes: size,
          },
        });
      }
      scope.throwIfAborted();
      const file = handle;
      let position = start;
      let cleanup: Promise<void> | undefined;
      const finish = () =>
        (cleanup ??= file.close().finally(() => {
          scope.signal.removeEventListener("abort", abort);
          scope.close();
          this.#streams.delete(finish);
        }));
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const abort = () => {
        controller.error(scope.signal.reason);
        void finish().catch(() => undefined);
      };
      const body = new ReadableStream<Uint8Array>(
        {
          start(output) {
            controller = output;
          },
          pull: async (output) => {
            try {
              scope.throwIfAborted();
              if (position === end) {
                await finish();
                output.close();
                return;
              }
              const bytes = new Uint8Array(Math.min(64 * 1024, end - position));
              const { bytesRead } = await file.read(
                bytes,
                0,
                bytes.length,
                position,
              );
              scope.throwIfAborted();
              if (bytesRead === 0)
                throw appError("storage.blob_corrupt", {
                  details: {
                    blobRef: ref,
                    path,
                    expected: size,
                    actual: position,
                  },
                });
              position += bytesRead;
              output.enqueue(bytes.subarray(0, bytesRead));
            } catch (error) {
              await finish().catch(() => undefined);
              throw this.#readFailure(error, ref, path);
            }
          },
          cancel: finish,
        },
        { highWaterMark: 0 },
      );
      this.#streams.add(finish);
      scope.signal.addEventListener("abort", abort, { once: true });
      return body;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      scope.close();
      throw this.#readFailure(error, ref, path);
    }
  }

  export(
    ref: BlobRef,
    destination: string,
    options?: CallOptions,
  ): Promise<void> {
    return this.#track(this.#export(ref, destination, options));
  }

  async #export(
    ref: BlobRef,
    destination: string,
    options?: CallOptions,
  ): Promise<void> {
    const scope = this.#operation("storage.export", options);
    try {
      await stageFile(
        dirname(destination),
        async (handle) => {
          const body = await this.read(ref, { signal: scope.signal });
          for await (const bytes of streamChunks(body, scope.signal))
            await writeChunk(handle, bytes, scope.signal);
        },
        async (path) => {
          scope.throwIfAborted();
          publishNewFile(path, destination);
          await syncParent(destination);
        },
      );
    } catch (error) {
      scope.throwIfAborted();
      if (error instanceof AppError) throw error;
      if (errorCode(error) === "EEXIST")
        throw appError("storage.already_exists", {
          details: {
            operation: "export",
            path: destination,
          },
        });
      throw appError("storage.write_failed", {
        details: {
          operation: "export",
          path: destination,
          reason: String(error),
        },
        cause: error,
      });
    } finally {
      scope.close();
    }
  }

  close(): Promise<void> {
    return (this.#closing ??= this.#close());
  }

  async #close(): Promise<void> {
    this.#stopping.abort(
      appError("runtime.closed", { details: { state: "closed" } }),
    );
    await Promise.allSettled([
      ...this.#pending,
      ...Array.from(this.#streams, (finish) => finish()),
    ]);
  }

  #readFailure(error: unknown, ref: BlobRef, path: string): AppError {
    if (error instanceof AppError) return error;
    if (errorCode(error) === "ENOENT")
      return appError("storage.blob_missing", {
        details: { blobRef: ref, path },
        cause: error,
      });
    return appError("storage.read_failed", {
      details: { blobRef: ref, path, reason: String(error) },
      cause: error,
    });
  }
}
