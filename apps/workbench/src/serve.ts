import {
  standardOperations,
  type ApplicationApi,
} from "@themelios/application";
import { materialOperationIds } from "@themelios/content";
import { createSecrets, type Session } from "@themelios/runtime";
import {
  standardPermission,
  type Principal,
} from "@themelios/runtime/operations";
import {
  serveApplication,
  cliServeMode,
  type CliServeMode,
  type ApplicationListeners,
} from "@themelios/transports";

import { mcpTransportMode, type WorkbenchSettings } from "./settings.js";

type Workbench = ApplicationApi<WorkbenchSettings>;

export const localPrincipal: Principal = {
  id: "local",
  permissions: Object.values(standardPermission),
};

export async function serve(
  session: Session<ApplicationApi<WorkbenchSettings>, WorkbenchSettings>,
  mode: CliServeMode,
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
  };
  const tools = {
    name: "Themelios",
    resource: {
      name: "material",
      template: "themelios://materials/{ref}" as const,
      operation: materialOperationIds.read,
      linksFrom: [materialOperationIds.accept, materialOperationIds.inspect],
    },
    agentRefs: (app: Workbench) => ({
      resolveRef: app.materials.resolve,
      formatRef: app.materials.agentRef,
    }),
  };
  const listeners: ApplicationListeners<Workbench> = signal ? { signal } : {};
  if (mode === cliServeMode.stdio || mcp.mode === mcpTransportMode.stdio)
    listeners.stdio = {
      ...published,
      ...tools,
      principal: {
        ...localPrincipal,
        permissions: mcp.localPermissions ?? localPrincipal.permissions,
      },
      limits: policy,
    };
  if (mode === cliServeMode.stdio) return serveApplication(session, listeners);

  const remote = {
    ...published,
    policy,
    secrets: createSecrets({ baseDir: session.instance.paths.config }),
  };
  if (http.listen)
    listeners.http = {
      address: http.listen,
      idleTimeoutSeconds: http.idleTimeoutSeconds,
      options: {
        ...remote,
        ...tools,
        enableMcp: mcp.mode === mcpTransportMode.http,
      },
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
