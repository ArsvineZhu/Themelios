import { createHash, timingSafeEqual } from "node:crypto";
import type { Principal } from "@themelios/application";
import { appError, throwIfAborted, type CallOptions } from "@themelios/core";
import { transportError } from "./errors.js";
import type { RemoteTransportOptions, TransportPolicy } from "./types.js";

export const loopbackHosts = ["localhost", "127.0.0.1", "[::1]"] as const;

export async function authenticateRequest(
  headers: Headers,
  options: RemoteTransportOptions,
  policy: Readonly<TransportPolicy>,
  signal: AbortSignal,
): Promise<Principal> {
  throwIfAborted(signal);
  if (options.authenticate) return options.authenticate(headers, signal);
  const match = /^Bearer ([^\s,]+)$/i.exec(headers.get("authorization") ?? "");
  const token = match?.[1];
  if (!token) throw transportError("transport.auth_required");
  const hash = digest(token);
  const results = await Promise.all(
    Object.entries(policy.authTokens).map(async ([id, entry]) => {
      try {
        return timingSafeEqual(
          hash,
          digest(await options.secrets.resolve(entry.secret)),
        )
          ? { id, permissions: [...entry.permissions] }
          : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  throwIfAborted(signal);
  const principal = results.find((candidate) => candidate !== undefined);
  if (!principal) throw transportError("transport.auth_required");
  return principal;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function validateWebOrigin(
  request: Request,
  policy: Readonly<TransportPolicy>,
): string | null {
  const url = new URL(request.url);
  const authority = request.headers.get("host") ?? url.host;
  if (!authority || /[\s,@/?#\\]/.test(authority))
    throw transportError("transport.access_denied");
  let hostname: string;
  try {
    hostname = new URL("http://" + authority).hostname.toLowerCase();
  } catch (cause) {
    throw transportError("transport.access_denied", undefined, cause);
  }
  if (
    !policy.allowedHosts.some(
      (host) => (host === "::1" ? "[::1]" : host).toLowerCase() === hostname,
    )
  ) {
    throw transportError("transport.access_denied");
  }
  const origin = request.headers.get("origin");
  if (
    origin !== null &&
    origin !== new URL(url.protocol + "//" + authority).origin &&
    !policy.allowedOrigins.includes(origin)
  ) {
    throw transportError("transport.access_denied");
  }
  return origin;
}

export function callOptions(
  headers: Headers,
  signal: AbortSignal,
): CallOptions {
  const value = headers.get("x-themelios-timeout-ms");
  if (value === null) return { signal };
  const timeoutMs = Number(value);
  if (
    !/^\d+(?:\.\d+)?$/.test(value) ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0
  ) {
    throw transportError("transport.invalid_request", {
      reason: "invalid_timeout",
    });
  }
  return { signal, timeoutMs };
}

type RequestLease = {
  readonly signal: AbortSignal;
  readonly done: Promise<void>;
  close(): void;
};

export class RequestTracker {
  readonly #shutdown = new AbortController();
  readonly #active = new Set<RequestLease>();
  #closePromise: Promise<void> | undefined;

  take(requestSignal?: AbortSignal): RequestLease {
    if (this.#shutdown.signal.aborted)
      throw transportError("runtime.closed", { state: "closing" });
    const signal = requestSignal
      ? AbortSignal.any([requestSignal, this.#shutdown.signal])
      : this.#shutdown.signal;
    const { promise, resolve } = Promise.withResolvers<void>();
    const item = {
      signal,
      done: promise,
      close: () => {
        this.#active.delete(item);
        resolve();
      },
    };
    this.#active.add(item);
    return item;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#shutdown.abort(
      appError("call.cancelled", { details: { reason: "endpoint closing" } }),
    );
    this.#closePromise = Promise.all(
      [...this.#active].map((item) => item.done),
    ).then(() => undefined);
    return this.#closePromise;
  }
}

/** A returned response keeps the request lease until its source finishes or is cancelled. */
export function retainResponse(
  response: Response,
  lease: RequestLease,
  extra?: Headers,
): Response {
  const headers = new Headers(response.headers);
  extra?.forEach((value, key) => headers.append(key, value));
  if (!response.body) {
    lease.close();
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  const reader = response.body.getReader();
  let released = false;
  let stopping: Promise<void> | undefined;
  let abort: () => void;
  function release() {
    if (released) return;
    released = true;
    lease.signal.removeEventListener("abort", abort);
    reader.releaseLock();
    lease.close();
  }
  function cancel(reason: unknown) {
    if (released) return Promise.resolve();
    stopping ??= reader
      .cancel(reason)
      .catch(() => undefined)
      .finally(release);
    return stopping;
  }
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        abort = () => {
          controller.error(lease.signal.reason);
          void cancel(lease.signal.reason);
        };
        lease.signal.addEventListener("abort", abort, { once: true });
        if (lease.signal.aborted) abort();
      },
      async pull(controller) {
        try {
          const next = await reader.read();
          if (stopping) return;
          if (next.done) {
            release();
            controller.close();
          } else controller.enqueue(next.value);
        } catch (error) {
          if (!stopping) {
            release();
            controller.error(error);
          }
        }
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function cors(origin: string | null): Headers {
  return new Headers(
    origin
      ? {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
          "access-control-allow-headers":
            "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id, x-themelios-timeout-ms",
          "access-control-expose-headers":
            "mcp-session-id, mcp-protocol-version, content-type, content-length, content-disposition",
          vary: "Origin",
        }
      : {},
  );
}
