import { readFile } from "node:fs/promises";
import { getCACertificates } from "node:tls";
import { AppError, type CallScope } from "@themelios/core";
import type { Closable } from "./execution.js";
import type { Diagnostics } from "./diagnostics.js";
import { errno, failure } from "./failure.js";
import { createSecrets, type CredentialRef, type Secrets } from "./secrets.js";

export interface Network extends Closable {
  readonly fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

export interface NetworkOptions {
  timeoutMs?: number;
  proxy?: string;
  proxyAuthorization?: CredentialRef;
  caFile?: string;
  secrets?: Secrets;
  diagnostics?: Diagnostics;
}

const transient = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_SOCKET",
]);
const requestFields = new Set([
  "body",
  "cache",
  "credentials",
  "duplex",
  "headers",
  "integrity",
  "keepalive",
  "method",
  "mode",
  "redirect",
  "referrer",
  "referrerPolicy",
]);

export async function createNetwork(
  options: NetworkOptions = {},
): Promise<Network> {
  return createSessionNetwork(options, () => undefined);
}

export interface RequestContext {
  call?: CallScope | undefined;
  diagnostics?: Diagnostics | undefined;
  timeoutMs: number;
}

export async function createSessionNetwork(
  options: NetworkOptions,
  current: () => RequestContext | undefined,
): Promise<Network> {
  const defaultTimeout = options.timeoutMs ?? 60000;
  if (
    !Number.isSafeInteger(defaultTimeout) ||
    defaultTimeout < 1 ||
    defaultTimeout > 3600000
  ) {
    throw failure("config.invalid", {
      issues: [
        { path: "/network/timeoutMs", messageKey: "config.invalid_value" },
      ],
    });
  }
  const proxy = options.proxy && proxyUrl(options.proxy);
  if (options.proxyAuthorization && !proxy) {
    throw failure("config.invalid", {
      issues: [
        {
          path: "/network/proxyAuthorization",
          messageKey: "config.requires_proxy",
        },
      ],
    });
  }
  const tls = options.caFile
    ? await readFile(options.caFile, "utf8")
        .then((ca) => ({
          ca: [...getCACertificates("default"), ca],
        }))
        .catch((error) => {
          throw failure(
            "network.failed",
            { method: "GET", origin: "", phase: "read_ca" },
            error,
          );
        })
    : undefined;
  const session = new Bun.FetchSession({
    proxy: proxy ? { url: proxy, respectNoProxy: false } : false,
    tls,
  });
  const secrets = options.secrets ?? createSecrets({ baseDir: process.cwd() });
  const active = new Set<ReturnType<typeof requestLifetime>>();
  let closing: Promise<void> | undefined;

  async function fetchWithLifetime(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    if (closing) throw failure("runtime.closed", { state: "closing" });
    const request = input instanceof Request ? input : undefined;
    const method = init?.method ?? request?.method ?? "GET";
    const origin = requestOrigin(method, request?.url ?? String(input));
    const {
      call,
      timeoutMs,
      diagnostics = options.diagnostics,
    } = current() ?? { timeoutMs: defaultTimeout };
    const lifetime = requestLifetime(
      { method, origin },
      timeoutMs,
      call,
      request?.signal,
      init?.signal,
    );
    const { signal, failed } = lifetime;
    active.add(lifetime);
    const finish = () => {
      lifetime.finish();
      active.delete(lifetime);
    };
    try {
      call?.throwIfAborted("network");
      signal.throwIfAborted();
      const ref = options.proxyAuthorization;
      const proxyAuth =
        proxy && ref
          ? {
              proxy: {
                url: proxy,
                respectNoProxy: false,
                headers: { "Proxy-Authorization": await secrets.resolve(ref) },
              },
            }
          : {};
      signal.throwIfAborted();
      // Connection policy belongs to this FetchSession, including when a caller shares Bun-specific fetch options.
      const requestInit = Object.fromEntries(
        Object.entries(init ?? {}).filter(([field]) =>
          requestFields.has(field),
        ),
      );
      const response = await session.fetch(input, {
        ...requestInit,
        signal,
        ...proxyAuth,
      });
      recordSentBytes(diagnostics, init?.body);
      if (!response.body) {
        finish();
        return response;
      }
      return wrapBody(response, signal, finish, failed, (bytes) =>
        diagnostics?.recordNetworkBytes?.("received", bytes),
      );
    } catch (error) {
      finish();
      const mapped = failed(error, "headers");
      diagnostics?.log("debug", "network.request.failed", {
        method,
        origin,
        code: mapped.code,
      });
      throw mapped;
    }
  }

  return {
    fetch: fetchWithLifetime,
    close() {
      closing ??= (async () => {
        for (const request of active)
          request.stop(failure("call.cancelled", { reason: "network_closed" }));
        await Promise.all([...active].map((request) => request.done));
        session.close();
      })();
      return closing;
    },
  };
}

function requestOrigin(method: string, address: string): string {
  try {
    return new URL(address).origin;
  } catch (error) {
    throw failure(
      "network.failed",
      { method, origin: "", phase: "url" },
      error,
    );
  }
}

function requestLifetime(
  route: { method: string; origin: string },
  timeoutMs: number,
  call?: CallScope,
  request?: AbortSignal,
  supplied?: AbortSignal | null,
) {
  const remainingMs = call?.remainingMs() ?? Infinity;
  const budget = Math.min(timeoutMs, remainingMs);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    if (call && remainingMs <= timeoutMs) {
      try {
        call.throwIfAborted("network");
      } catch (error) {
        controller.abort(error);
      }
    }
    controller.abort(
      failure(
        "network.timeout",
        { ...route, timeoutMs: budget },
        undefined,
        true,
      ),
    );
  }, Math.ceil(budget));
  timer.unref();
  const sources = new Set([request, supplied, call?.signal, controller.signal]);
  const signal = AbortSignal.any(
    [...sources].filter((value): value is AbortSignal => value != null),
  );
  const settled = Promise.withResolvers<void>();
  return {
    signal,
    done: settled.promise,
    stop: (reason: unknown) => controller.abort(reason),
    finish() {
      clearTimeout(timer);
      settled.resolve();
    },
    failed(cause: unknown, phase: string): AppError {
      if (signal.aborted) {
        return signal.reason instanceof AppError
          ? signal.reason
          : failure("call.cancelled", undefined, signal.reason);
      }
      return cause instanceof AppError
        ? cause
        : failure(
            "network.failed",
            { ...route, phase },
            cause,
            transient.has(errno(cause) ?? ""),
          );
    },
  };
}

function recordSentBytes(
  diagnostics: Diagnostics | undefined,
  body: RequestInit["body"],
): void {
  const size =
    typeof body === "string"
      ? Buffer.byteLength(body)
      : body instanceof Blob
        ? body.size
        : body instanceof ArrayBuffer || ArrayBuffer.isView(body)
          ? body.byteLength
          : undefined;
  if (size !== undefined) diagnostics?.recordNetworkBytes?.("sent", size);
}

function proxyUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("Invalid proxy URL");
    return url.href;
  } catch (error) {
    throw failure(
      "config.invalid",
      {
        issues: [
          { path: "/network/proxy", messageKey: "config.invalid_value" },
        ],
      },
      error,
    );
  }
}

function wrapBody(
  original: Response,
  signal: AbortSignal,
  finish: () => void,
  failed: (error: unknown, phase: string) => AppError,
  recordBytes: (size: number) => void,
): Response {
  const reader = original.body!.getReader();
  let ended = false;
  let stopping: Promise<void> | undefined;
  let abort: () => void;
  const cleanup = () => {
    if (ended) return;
    ended = true;
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
    finish();
  };
  const cancel = (reason: unknown): Promise<void> => {
    if (ended) return Promise.resolve();
    stopping ??= reader
      .cancel(reason)
      .catch(() => undefined)
      .finally(cleanup);
    return stopping;
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        abort = () => {
          const error = failed(signal.reason, "body");
          void cancel(error);
          controller.error(error);
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      },
      async pull(controller) {
        try {
          const next = await reader.read();
          if (stopping) return;
          if (next.done) {
            cleanup();
            controller.close();
          } else {
            recordBytes(next.value.byteLength);
            controller.enqueue(next.value);
          }
        } catch (error) {
          if (stopping) return;
          cleanup();
          controller.error(failed(error, "body"));
        }
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  return preserveResponseMetadata(new Response(stream, original), original);
}

function preserveResponseMetadata(
  response: Response,
  original: Response,
): Response {
  const clone = response.clone.bind(response);
  Object.defineProperties(response, {
    url: { value: original.url },
    redirected: { value: original.redirected },
    type: { value: original.type },
    headers: { value: original.headers },
    clone: { value: () => preserveResponseMetadata(clone(), original) },
  });
  return response;
}
