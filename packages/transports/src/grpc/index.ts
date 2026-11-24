import { once } from "node:events";
import {
  createSecureServer,
  createServer,
  type ServerHttp2Session,
} from "node:http2";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { resolveDirectory } from "../directory.js";
import { transportError } from "../errors.js";
import { RequestTracker } from "../request.js";
import type { GrpcListener, RemoteOperationOptions } from "../types.js";
import { grpcOperations } from "./operations.js";
import { Operations } from "./operations_pb.js";

export { FailureSchema, Operations } from "./operations_pb.js";
export type { GrpcListener } from "../types.js";

export async function startGrpcServer<App>(
  app: App,
  listener: GrpcListener,
  options: RemoteOperationOptions<App>,
): Promise<{
  address: string;
  close(): Promise<void>;
}> {
  const tracker = new RequestTracker();
  const directory = resolveDirectory(
    options.operations,
    options.allowOperations,
  );
  const impl = grpcOperations(app, directory, options, tracker);
  const adapter = connectNodeAdapter({
    grpc: true,
    grpcWeb: false,
    connect: false,
    readMaxBytes: 1024 * 1024 * 1024,
    routes(router) {
      router.rpc(Operations.method.invoke, impl.invoke);
      router.rpc(Operations.method.stream, impl.stream);
      router.rpc(Operations.method.upload, impl.upload, {
        readMaxBytes: 1024 * 1024,
      });
    },
  });
  const {
    address: { host, port },
    tls,
  } = listener;
  const hostname =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const server = tls
    ? createSecureServer(
        {
          key: await options.secrets.resolve(tls.key),
          cert: await options.secrets.resolve(tls.cert),
        },
        adapter,
      )
    : createServer({}, adapter);
  const sessions = new Set<ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
    session.on("error", () => session.destroy());
  });
  server.listen(port, hostname);
  await once(server, "listening");
  const bound = server.address();
  if (!bound || typeof bound === "string")
    throw transportError("internal.unexpected");
  const authority = hostname.includes(":") ? `[${hostname}]` : hostname;
  const address = `${tls ? "https" : "http"}://${authority}:${bound.port}`;
  let closing: Promise<void> | undefined;
  return {
    address,
    close() {
      closing ??= (async () => {
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await tracker.close();
        for (const session of sessions) session.destroy();
        await stopped;
      })();
      return closing;
    },
  };
}
