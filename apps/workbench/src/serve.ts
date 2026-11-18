import type {
  ApplicationApi,
  ApplicationSettings,
  Principal,
} from "@themelios/application";
import { appError } from "@themelios/core";
import {
  createSecrets,
  type Session,
  sessionMessage,
  updateSessionEndpoints,
} from "@themelios/runtime";
import {
  createHttpHandler,
  createMcpEndpoint,
  serveMcpStdio,
  startGrpcServer,
  type Translate,
  type RemoteTransportOptions,
} from "@themelios/transports";

export const localPrincipal: Principal = {
  id: "local",
  permissions: ["read", "write", "admin"],
};

function waitForAbort(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export async function serve(
  session: Session<ApplicationApi<ApplicationSettings>, ApplicationSettings>,
  mode: "serve" | "stdio",
  signal = new AbortController().signal,
) {
  const current = () => session.configuration.snapshot();
  const stop = new AbortController();
  const lifetime = AbortSignal.any([signal, stop.signal]);
  const policy = () => {
    const config = current().transports;
    return {
      maxJsonBytes: config.maxJsonBytes,
      authTokens: config.authTokens,
      allowedHosts: config.http.allowedHosts,
      allowedOrigins: config.http.allowedOrigins,
    };
  };
  const secrets = createSecrets({ baseDir: session.instance.paths.config });
  const translate: Translate = (locale, key, params) =>
    sessionMessage(session, key, params, locale);
  const addresses: Record<string, string> = {};
  const cleanup: Array<() => Promise<void>> = [];
  const wait = waitForAbort(lifetime);
  try {
    const settings = current();
    const { http, grpc, mcp } = settings.transports;
    if (mode === "stdio" || mcp.mode === "stdio") {
      const stdio = await serveMcpStdio(session.api, {
        principal: localPrincipal,
        limits: policy,
        translate,
      });
      cleanup.push(() => stdio.close());
      addresses.mcp = "stdio";
      void stdio.closed.then(
        () => stop.abort(),
        () => stop.abort(),
      );
    }
    if (mode === "serve" && http.listen) {
      Object.assign(
        addresses,
        listenHttp(
          session.api,
          http.listen,
          mcp.mode === "http",
          { policy, secrets, translate },
          cleanup,
        ),
      );
    }
    if (mode === "serve" && grpc.listen) {
      const grpcServer = await startGrpcServer(session.api, {
        policy,
        secrets,
        translate,
        hostname: grpc.listen.host,
        port: grpc.listen.port,
        ...(grpc.tls === undefined ? {} : { tls: grpc.tls }),
      });
      cleanup.push(() => grpcServer.close());
      addresses.grpc = grpcServer.address;
    }
    if (Object.keys(addresses).length === 0)
      throw appError("transport.invalid_request", {
        details: {
          reason:
            "Enable an HTTP or gRPC listener, or run themelios mcp for stdio",
        },
      });
    await updateSessionEndpoints(session, addresses);
    if (mode === "serve")
      process.stderr.write(
        JSON.stringify({ event: "themelios.ready", endpoints: addresses }) +
          "\n",
      );
    await wait;
  } finally {
    stop.abort();
    await closeListeners(cleanup);
  }
}

function listenHttp(
  api: ApplicationApi<ApplicationSettings>,
  address: { host: string; port: number },
  enableMcp: boolean,
  options: RemoteTransportOptions,
  cleanup: Array<() => Promise<void>>,
): Record<string, string> {
  const handler = createHttpHandler(api, options);
  cleanup.push(() => handler.close());
  const mcp = enableMcp ? createMcpEndpoint(api, options) : undefined;
  if (mcp) cleanup.push(() => mcp.close());
  const listener = Bun.serve({
    hostname: address.host,
    port: address.port,
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    fetch: (request) =>
      new URL(request.url).pathname === "/mcp" && mcp
        ? mcp.fetch(request)
        : handler.fetch(request),
  });
  cleanup.push(() => listener.stop(true));
  return {
    http: listener.url.href,
    ...(mcp ? { mcp: new URL("/mcp", listener.url).href } : {}),
  };
}

async function closeListeners(
  cleanup: Array<() => Promise<void>>,
): Promise<void> {
  const errors: unknown[] = [];
  for (const close of cleanup.reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Transport shutdown failed");
}
