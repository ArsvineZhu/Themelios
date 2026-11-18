import {
  standardOperations,
  type ApplicationApi,
  type ApplicationSettings,
} from "@themelios/application";
import { createSecrets, type Session } from "@themelios/runtime";
import type { Principal } from "@themelios/runtime/operations";
import { serveApplication } from "@themelios/transports";

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
  const policy = () => {
    const config = current().transports;
    return {
      maxJsonBytes: config.maxJsonBytes,
      authTokens: config.authTokens,
      allowedHosts: config.http.allowedHosts,
      allowedOrigins: config.http.allowedOrigins,
    };
  };
  const common = {
    name: "Themelios",
    resource: {
      name: "material",
      template: "themelios://materials/{ref}" as const,
      operation: "materials.read",
      linksFrom: ["materials.accept", "materials.inspect"],
    },
    operations: standardOperations<ApplicationApi<ApplicationSettings>>(),
    locale: () => current().locale,
    agentRefs: (app: ApplicationApi<ApplicationSettings>) => ({
      resolveRef: app.materials.resolve,
      formatRef: app.materials.agentRef,
    }),
  };
  const { http, mcp } = current().transports;
  await serveApplication(session, {
    ...(signal ? { signal } : {}),
    ...(mode === "stdio" || mcp.mode === "stdio"
      ? {
          stdio: { ...common, principal: localPrincipal, limits: policy },
        }
      : {}),
    ...(mode === "serve" && http.listen
      ? {
          http: {
            address: http.listen,
            options: {
              ...common,
              policy,
              secrets: createSecrets({
                baseDir: session.instance.paths.config,
              }),
              enableMcp: mcp.mode === "http",
            },
          },
        }
      : {}),
    ...(mode === "serve"
      ? {
          ready: (endpoints) =>
            process.stderr.write(
              JSON.stringify({ event: "themelios.ready", endpoints }) + "\n",
            ),
        }
      : {}),
  });
}
