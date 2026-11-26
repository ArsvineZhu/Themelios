import { readFile } from "node:fs/promises";
import { getCACertificates } from "node:tls";
import {
  appError,
  errorCode,
  parseJson,
  parseValue,
  AppError,
  type CallScope,
} from "@themelios/core";
import { z } from "zod";
import type { Closable } from "./execution.js";
import type { Diagnostics } from "./diagnostics.js";
import { createSecrets, credentialSchema, type Secrets } from "./secrets.js";
import type { SettingIssue } from "./settings.js";

export interface Network extends Closable {
  /** Sends a Request with this client's connection policy and lifetime. Consume or cancel the response body before closing the client. */
  fetch(request: Request): Promise<Response>;
}

export type NetworkOptions = z.input<typeof networkSettingsSchema> & {
  secrets?: Secrets;
  diagnostics?: Diagnostics;
};

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

const proxyUrlSchema = z.url({ protocol: /^https?$/, normalize: true }).refine(
  (value) => {
    const url = URL.parse(value);
    return url !== null && !url.username && !url.password;
  },
  { message: "HTTP(S) proxy URLs must omit user information" },
);
export const networkSettingsSchema = z.strictObject({
  timeoutMs: z.int().positive().max(2_147_483_647).default(60_000),
  proxy: proxyUrlSchema.optional(),
  noProxy: z
    .array(z.string().refine((value) => proxyHost(value) !== undefined))
    .readonly()
    .default([]),
  proxyAuthorization: credentialSchema.optional(),
  caFile: z.string().min(1).optional(),
});
export type NetworkSettings = z.output<typeof networkSettingsSchema>;

export function networkSettingIssues(
  settings: NetworkSettings,
): SettingIssue[] {
  return settings.proxyAuthorization && !settings.proxy
    ? [
        {
          path: "/network/proxyAuthorization",
          messageKey: "config.requires_proxy",
        },
      ]
    : [];
}

const transient = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_SOCKET",
]);
export async function createNetwork(
  options: NetworkOptions = {},
): Promise<Network> {
  const { secrets, diagnostics, ...input } = options;
  const settings = parseValue(networkSettingsSchema, input, "config.invalid");
  const issues = networkSettingIssues(settings);
  if (issues.length)
    throw appError("config.invalid", {
      details: { issues: parseJson(issues) },
    });
  return createSessionNetwork(settings, {
    secrets: secrets ?? createSecrets({ baseDir: process.cwd() }),
    diagnostics,
  });
}

export interface RequestContext {
  call?: CallScope | undefined;
  diagnostics?: Diagnostics | undefined;
  timeoutMs: number;
}

export async function createSessionNetwork(
  settings: NetworkSettings,
  options: {
    secrets: Secrets;
    diagnostics?: Diagnostics | undefined;
    current?: () => RequestContext | undefined;
  },
): Promise<Network> {
  const {
    timeoutMs: defaultTimeout,
    proxy,
    proxyAuthorization,
    caFile,
  } = settings;
  const directHosts = settings.noProxy.map((host) => proxyHost(host)!);
  const tls = caFile
    ? await readFile(caFile, "utf8")
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
  const active = new Set<ReturnType<typeof requestLifetime>>();
  let closing: Promise<void> | undefined;

  async function fetchWithLifetime(request: Request): Promise<Response> {
    if (closing)
      throw appError("runtime.closed", { details: { state: "closing" } });
    const { method } = request;
    const url = new URL(request.url);
    const origin = url.origin;
    const {
      call,
      timeoutMs,
      diagnostics = options.diagnostics,
    } = options.current?.() ?? { timeoutMs: defaultTimeout };
    const lifetime = requestLifetime(
      { method, origin },
      timeoutMs,
      call,
      request.signal,
    );
    const { signal, failed } = lifetime;
    active.add(lifetime);
    const length = request.headers.get("content-length");
    const sentBytes = length === null ? undefined : Number(length);
    let receivedBytes: number | undefined;
    const finish = () => {
      if (!active.delete(lifetime)) return;
      lifetime.finish();
      for (const [direction, size] of [
        ["sent", sentBytes],
        ["received", receivedBytes],
      ] as const) {
        if (size !== undefined && Number.isSafeInteger(size) && size >= 0)
          observeNetwork(() =>
            diagnostics?.recordNetworkBytes?.(direction, size),
          );
      }
    };
    try {
      call?.throwIfAborted("network");
      signal.throwIfAborted();
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
              ...(proxyAuthorization
                ? {
                    headers: {
                      "Proxy-Authorization":
                        await options.secrets.resolve(proxyAuthorization),
                    },
                  }
                : {}),
            }
          : false;
      signal.throwIfAborted();
      const response = await session.fetch(request, {
        signal,
        proxy: route,
      });
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

function requestLifetime(
  route: { method: string; origin: string },
  timeoutMs: number,
  call: CallScope | undefined,
  request: AbortSignal,
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
  const signal = AbortSignal.any(
    call
      ? [request, call.signal, controller.signal]
      : [request, controller.signal],
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

function observeNetwork(report: () => void): void {
  try {
    report();
  } catch {
    // Diagnostics must not affect delivery or cancellation of a response.
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
