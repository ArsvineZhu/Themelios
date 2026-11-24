import {
  standardOperations,
  type ApplicationApi,
  type ApplicationSettings,
} from "@themelios/application";
import { createSecrets, type Session } from "@themelios/runtime";
import type { Principal } from "@themelios/runtime/operations";
import {
  serveApplication,
  type ApplicationListeners,
} from "@themelios/transports";

type Workbench = ApplicationApi<ApplicationSettings>;

export const localPrincipal: Principal = {
  id: "local",
  permissions: ["read", "write", "admin"],
};

export async function serve(
  session: Session<ApplicationApi<ApplicationSettings>, ApplicationSettings>,
  mode: "serve" | "stdio",
  signal?: AbortSignal,
) {
  const current = () => session.configuration.snapshot();
  const { allowOperations, grpc, http, mcp } = current().transports;
  const policy = () => {
    const config = current().transports;
    return {
      maxJsonBytes: config.maxJsonBytes,
      authTokens: config.authTokens,
      allowedHosts: config.http.allowedHosts,
      allowedOrigins: config.http.allowedOrigins,
    };
  };
  const published = {
    operations: standardOperations<Workbench>(),
    ...(allowOperations === undefined ? {} : { allowOperations }),
    locale: () => current().locale,
  };
  const tools = {
    name: "Themelios",
    resource: {
      name: "material",
      template: "themelios://materials/{ref}" as const,
      operation: "materials.read",
      linksFrom: ["materials.accept", "materials.inspect"],
    },
    agentRefs: (app: Workbench) => ({
      resolveRef: app.materials.resolve,
      formatRef: app.materials.agentRef,
    }),
  };
  const listeners: ApplicationListeners<Workbench> = signal ? { signal } : {};
  if (mode === "stdio" || mcp.mode === "stdio")
    listeners.stdio = {
      ...published,
      ...tools,
      principal: {
        ...localPrincipal,
        permissions: mcp.localPermissions ?? localPrincipal.permissions,
      },
      limits: policy,
    };
  if (mode === "stdio") return serveApplication(session, listeners);

  const remote = {
    ...published,
    policy,
    secrets: createSecrets({ baseDir: session.instance.paths.config }),
  };
  if (http.listen)
    listeners.http = {
      address: http.listen,
      ...(http.idleTimeoutSeconds === undefined
        ? {}
        : { idleTimeoutSeconds: http.idleTimeoutSeconds }),
      options: { ...remote, ...tools, enableMcp: mcp.mode === "http" },
    };
  if (grpc.listen)
    listeners.grpc = {
      address: grpc.listen,
      ...(grpc.tls === undefined ? {} : { tls: grpc.tls }),
      options: remote,
    };
  listeners.ready = (endpoints) => {
    const unconfigured =
      (endpoints.http || endpoints.grpc) &&
      !Object.keys(policy().authTokens).length;
    process.stderr.write(
      JSON.stringify({
        event: "themelios.ready",
        endpoints,
        ...(unconfigured
          ? { configureBearerTokens: "/transports/authTokens" }
          : {}),
      }) + "\n",
    );
  };
  await serveApplication(session, listeners);
}
