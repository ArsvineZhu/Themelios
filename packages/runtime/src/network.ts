import { readFile } from "node:fs/promises";
import { getCACertificates } from "node:tls";
import { appError, errorCode, AppError, type CallScope } from "@themelios/core";
import { z } from "zod";
import type { Closable } from "./execution.js";
import type { Diagnostics } from "./diagnostics.js";
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
  noProxy?: readonly string[];
  proxyAuthorization?: CredentialRef;
  caFile?: string;
  secrets?: Secrets;
  diagnostics?: Diagnostics;
}

function proxyHost(value: string): string | undefined {
  if (value === "*") return value;
  const tail = value.startsWith(".") || value.startsWith("*.");
  const host = tail ? value.slice(value.indexOf(".") + 1) : value;
  if (!/^[^\s/\\?#@*%:]+$/.test(host) && !/^\[[a-f\d:.]+\]$/i.test(host))
    return undefined;
  try {
    const normalized = new URL(`http://${host}`).hostname.replace(/\.$/, "");
    return tail ? `.${normalized}` : normalized;
  } catch {
    return undefined;
  }
}

export const noProxySchema = z.array(
  z.string().refine((value) => proxyHost(value) !== undefined),
);
export const networkTimeoutSchema = z
  .int()
  .positive()
  .max(2_147_483_647)
  .default(60_000);

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
  const timeout = networkTimeoutSchema.safeParse(options.timeoutMs);
  if (!timeout.success) {
    throw appError("config.invalid", {
      details: {
        issues: [
          { path: "/network/timeoutMs", messageKey: "config.invalid_value" },
        ],
      },
    });
  }
  const defaultTimeout = timeout.data;
  const proxy = options.proxy && proxyUrl(options.proxy);
  const bypass = noProxySchema.safeParse(options.noProxy ?? []);
  if (!bypass.success)
    throw appError("config.invalid", {
      details: {
        issues: [
          { path: "/network/noProxy", messageKey: "config.invalid_value" },
        ],
      },
      cause: bypass.error,
    });
  const directHosts = bypass.data.map((host) => proxyHost(host)!);
  if (options.proxyAuthorization && !proxy) {
    throw appError("config.invalid", {
      details: {
        issues: [
          {
            path: "/network/proxyAuthorization",
            messageKey: "config.requires_proxy",
          },
        ],
      },
    });
  }
  const tls = options.caFile
    ? await readFile(options.caFile, "utf8")
        .then((ca) => ({
          ca: [...getCACertificates("default"), ca],
        }))
        .catch((error) => {
          throw appError("network.failed", {
            details: { method: "GET", origin: "", phase: "read_ca" },
            cause: error,
          });
        })
    : undefined;
  const session = new Bun.FetchSession({
    proxy: false,
    tls,
  });
  const secrets = options.secrets ?? createSecrets({ baseDir: process.cwd() });
  const active = new Set<ReturnType<typeof requestLifetime>>();
  let closing: Promise<void> | undefined;

  async function fetchWithLifetime(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    if (closing)
      throw appError("runtime.closed", { details: { state: "closing" } });
    const request = input instanceof Request ? input : undefined;
    const method = init?.method ?? request?.method ?? "GET";
    const url = requestUrl(method, request?.url ?? String(input));
    const origin = url.origin;
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
    let sentBytes: number | undefined;
    let receivedBytes: number | undefined;
    const finish = () => {
      if (!active.delete(lifetime)) return;
      lifetime.finish();
      for (const [direction, size] of [
        ["sent", sentBytes],
        ["received", receivedBytes],
      ] as const) {
        if (size !== undefined)
          observeNetwork(() =>
            diagnostics?.recordNetworkBytes?.(direction, size),
          );
      }
    };
    try {
      call?.throwIfAborted("network");
      signal.throwIfAborted();
      const ref = options.proxyAuthorization;
      const host = url.hostname.replace(/\.$/, "");
      const direct = directHosts.some(
        (rule) =>
          rule === "*" ||
          rule === host ||
          (rule.startsWith(".") &&
            (host.endsWith(rule) || host === rule.slice(1))),
      );
      const route =
        proxy && !direct
          ? {
              url: proxy,
              respectNoProxy: false,
              ...(ref
                ? {
                    headers: {
                      "Proxy-Authorization": await secrets.resolve(ref),
                    },
                  }
                : {}),
            }
          : false;
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
        proxy: route,
      });
      sentBytes = bodyByteLength(init?.body);
      if (!response.body) {
        finish();
        return response;
      }
      receivedBytes = 0;
      return wrapBody(response, signal, finish, failed, (bytes) => {
        receivedBytes = (receivedBytes ?? 0) + bytes;
      });
    } catch (error) {
      finish();
      const mapped = failed(error, "headers");
      observeNetwork(() =>
        diagnostics?.log("debug", "network.request.failed", {
          method,
          origin,
          code: mapped.code,
        }),
      );
      throw mapped;
    }
  }

  return {
    fetch: fetchWithLifetime,
    close() {
      closing ??= (async () => {
        for (const request of active)
          request.stop(
            appError("call.cancelled", {
              details: { reason: "network_closed" },
            }),
          );
        await Promise.all([...active].map((request) => request.done));
        session.close();
      })();
      return closing;
    },
  };
}

function requestUrl(method: string, address: string): URL {
  try {
    return new URL(address);
  } catch (error) {
    throw appError("network.failed", {
      details: { method, origin: "", phase: "url" },
      cause: error,
    });
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
      appError("network.timeout", {
        details: { ...route, timeoutMs: budget },
        retryable: true,
      }),
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
          : appError("call.cancelled", { cause: signal.reason });
      }
      return cause instanceof AppError
        ? cause
        : appError("network.failed", {
            details: { ...route, phase },
            cause: cause,
            retryable: transient.has(errorCode(cause) ?? ""),
          });
    },
  };
}

function bodyByteLength(body: RequestInit["body"]): number | undefined {
  return typeof body === "string"
    ? Buffer.byteLength(body)
    : body instanceof Blob
      ? body.size
      : body instanceof ArrayBuffer || ArrayBuffer.isView(body)
        ? body.byteLength
        : undefined;
}

function observeNetwork(report: () => void): void {
  try {
    report();
  } catch {
    // Diagnostics must not affect delivery or cancellation of a response.
  }
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
    throw appError("config.invalid", {
      details: {
        issues: [
          { path: "/network/proxy", messageKey: "config.invalid_value" },
        ],
      },
      cause: error,
    });
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
