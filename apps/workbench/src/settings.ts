import { isIP } from "node:net";
import {
  applicationSettings,
  type ApplicationSettings,
} from "@themelios/application";
import {
  combineSettings,
  defineSettings,
  settingMetadata,
  type SettingEffect,
  type SettingIssue,
  type SettingMeta,
} from "@themelios/runtime/settings";
import { standardPermissionSchema } from "@themelios/runtime/operations";
import { credentialSchema } from "@themelios/runtime/secrets";
import {
  cliServeMode,
  defaultMaxJsonBytes,
  httpIdleTimeoutSecondsSchema,
} from "@themelios/transports";
import { z } from "zod";

const permissions = z
  .array(standardPermissionSchema)
  .min(1)
  .refine(
    (items) => new Set(items).size === items.length,
    "Use each permission once",
  );
const budget = (fallback: number) => z.int().positive().default(fallback);
const defaultListenHost = "127.0.0.1";
export const mcpTransportMode = {
  stdio: cliServeMode.stdio,
  http: "http",
} as const;
const listen = z.strictObject({
  host: z.string().min(1).default(defaultListenHost),
  port: z.int().min(0).max(65535),
});
const schema = z.strictObject({
  transports: z
    .strictObject({
      maxJsonBytes: budget(defaultMaxJsonBytes),
      allowOperations: z.array(z.string().min(1)).optional(),
      authTokens: z
        .record(
          z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
          z.strictObject({ secret: credentialSchema, permissions }),
        )
        .default({}),
      http: z
        .strictObject({
          listen: listen.optional(),
          idleTimeoutSeconds: httpIdleTimeoutSecondsSchema,
          allowedHosts: z
            .array(z.string().min(1))
            .default(["localhost", defaultListenHost, "[::1]"]),
          allowedOrigins: z.array(z.url({ protocol: /^https?$/ })).default([]),
        })
        .prefault({}),
      grpc: z
        .strictObject({
          listen: listen.optional(),
          tls: z
            .strictObject({ key: credentialSchema, cert: credentialSchema })
            .optional(),
        })
        .prefault({}),
      mcp: z
        .strictObject({
          mode: z.enum(mcpTransportMode).optional(),
          localPermissions: permissions.optional(),
        })
        .prefault({}),
    })
    .prefault({}),
});
export type WorkbenchSettings = ApplicationSettings & z.output<typeof schema>;

const entries: readonly [string, SettingEffect, Partial<SettingMeta>?][] = [
  ["/transports/maxJsonBytes", "next-call", { unit: "bytes" }],
  ["/transports/allowOperations", "restart"],
  ["/transports/http/listen", "restart"],
  ["/transports/http/idleTimeoutSeconds", "restart", { unit: "seconds" }],
  ["/transports/http/allowedHosts", "reload"],
  ["/transports/http/allowedOrigins", "reload"],
  ["/transports/grpc/listen", "restart"],
  ["/transports/grpc/tls/key", "restart", { format: "credential" }],
  ["/transports/grpc/tls/cert", "restart", { format: "credential" }],
  ["/transports/mcp/mode", "restart"],
  ["/transports/mcp/localPermissions", "restart"],
  ["/transports/authTokens/*", "reload"],
  ["/transports/authTokens/*/secret", "reload", { format: "credential" }],
];

function isLoopback(host: string): boolean {
  const name = host.toLowerCase();
  return (
    ["localhost", "::1", "[::1]"].includes(name) ||
    (isIP(name) === 4 && name.startsWith("127."))
  );
}

function listenerIssues({
  authTokens,
  http,
  grpc,
  mcp,
}: WorkbenchSettings["transports"]): SettingIssue[] {
  const listeners = [
    ["http", http.listen],
    ["grpc", grpc.listen],
  ] as const;
  const issues = Object.keys(authTokens).length
    ? []
    : listeners.flatMap(([protocol, listener]) =>
        listener && !isLoopback(listener.host)
          ? [
              {
                path: `/transports/${protocol}/listen/host`,
                messageKey: "config.listener_requires_auth",
              },
            ]
          : [],
      );
  if (mcp.mode === mcpTransportMode.http && !http.listen) {
    issues.push({
      path: "/transports/mcp/mode",
      messageKey: "config.mcp_requires_http",
    });
  }
  return issues;
}

export const workbenchSettings = combineSettings(
  applicationSettings,
  defineSettings({
    schema,
    fields: Object.fromEntries(
      entries.map(([path, effect, extras]) => [
        path,
        settingMetadata("settings", path, effect, extras),
      ]),
    ),
    validateEffective: ({ transports }) => listenerIssues(transports),
  }),
);
