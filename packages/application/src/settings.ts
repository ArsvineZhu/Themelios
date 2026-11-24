import { isIP } from "node:net";
import {
  connectionSchema,
  modelBindingSchema,
  modelNameSchema,
  taskRouteSchema,
} from "@themelios/models";
import {
  combineSettings,
  runtimeSettings,
  type RuntimeSettings,
  type SettingEffect,
  type SettingIssue,
  type SettingMeta,
  type SettingsDefinition,
} from "@themelios/runtime/settings";
import { z } from "zod";

const fileCredential = z.templateLiteral([
  z.enum(["env", "file"]),
  ":",
  z.string().min(1),
]);
const permissions = z
  .array(z.enum(["read", "write", "admin"]))
  .min(1)
  .refine(
    (items) => new Set(items).size === items.length,
    "Use each permission once",
  );
const budget = (fallback: number) => z.int().positive().default(fallback);

const listen = z.strictObject({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.int().min(0).max(65535),
});
const schema = z.strictObject({
  models: z
    .strictObject({
      timeoutMs: budget(120_000),
      maxAttempts: budget(1),
      concurrency: budget(4),
      bindings: z.record(modelNameSchema, modelBindingSchema).default({}),
      connections: z.record(modelNameSchema, connectionSchema).default({}),
      tasks: z.record(modelNameSchema, taskRouteSchema).default({}),
    })
    .prefault({}),
  content: z
    .strictObject({
      maxImportBytes: budget(1_073_741_824),
      maxInlineBytes: budget(8_388_608),
    })
    .prefault({}),
  preparation: z
    .strictObject({
      maxMaterialBytes: budget(67_108_864),
      image: z.strictObject({ maxPixels: budget(40_000_000) }).prefault({}),
      media: z
        .strictObject({
          ffmpeg: z.string().min(1).optional(),
          ffprobe: z.string().min(1).optional(),
        })
        .prefault({}),
    })
    .prefault({}),
  storage: z
    .strictObject({ synchronous: z.enum(["FULL", "NORMAL"]).default("FULL") })
    .prefault({}),
  transports: z
    .strictObject({
      maxJsonBytes: budget(8_388_608),
      allowOperations: z.array(z.string().min(1)).optional(),
      authTokens: z
        .record(
          modelNameSchema,
          z.strictObject({ secret: fileCredential, permissions }),
        )
        .default({}),
      http: z
        .strictObject({
          listen: listen.optional(),
          idleTimeoutSeconds: z.int().min(0).max(255).optional(),
          allowedHosts: z
            .array(z.string().min(1))
            .default(["localhost", "127.0.0.1", "[::1]"]),
          allowedOrigins: z.array(z.url({ protocol: /^https?$/ })).default([]),
        })
        .prefault({}),
      grpc: z
        .strictObject({
          listen: listen.optional(),
          tls: z
            .strictObject({ key: fileCredential, cert: fileCredential })
            .optional(),
        })
        .prefault({}),
      mcp: z
        .strictObject({
          mode: z.enum(["stdio", "http"]).optional(),
          localPermissions: permissions.optional(),
        })
        .prefault({}),
    })
    .prefault({}),
});

type Configured = z.infer<typeof schema>;
export type ApplicationSettings = z.output<typeof schema> & RuntimeSettings;

function setting(
  path: string,
  effect: SettingEffect,
  extras: Partial<SettingMeta> = {},
): SettingMeta {
  const key = "settings." + path.split("/").filter(Boolean).join(".");
  return {
    titleKey: key + ".title",
    descriptionKey: key + ".description",
    impactKey: key + ".impact",
    effect,
    scopes: ["installation", "instance"],
    ...extras,
  };
}

const entries: readonly [string, SettingEffect, Partial<SettingMeta>?][] = [
  [
    "/models/timeoutMs",
    "next-call",
    { unit: "ms", scopes: ["installation", "instance", "task", "call"] },
  ],
  [
    "/models/maxAttempts",
    "next-call",
    {
      scopes: ["installation", "instance", "task"],
    },
  ],
  ["/models/concurrency", "reload"],
  ["/models/connections/*", "reload"],
  ["/models/connections/*/credential", "reload", { format: "credential" }],
  ["/models/bindings/*", "reload"],
  ["/models/tasks/*", "next-call"],
  ["/content/maxImportBytes", "next-call", { unit: "bytes" }],
  ["/content/maxInlineBytes", "next-call", { unit: "bytes" }],
  ["/preparation/maxMaterialBytes", "next-call", { unit: "bytes" }],
  ["/preparation/image/maxPixels", "next-call", { unit: "pixels" }],
  ["/preparation/media/ffmpeg", "next-call", { format: "path" }],
  ["/preparation/media/ffprobe", "next-call", { format: "path" }],
  ["/storage/synchronous", "restart"],
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

const configurable: SettingsDefinition<Configured> = {
  schema,
  fields: Object.fromEntries(
    entries.map(([path, effect, extras]) => [
      path,
      setting(path, effect, extras),
    ]),
  ),
  validateEffective(value) {
    return [
      ...bindingIssues(value.models),
      ...taskIssues(value.models),
      ...listenerIssues(value.transports),
    ];
  },
};

function bindingIssues(models: Configured["models"]): SettingIssue[] {
  const issues: SettingIssue[] = [];
  for (const [name, binding] of Object.entries(models.bindings)) {
    const path = "/models/bindings/" + name;
    if (!Object.hasOwn(models.connections, binding.connection)) {
      issues.push({
        path: path + "/connection",
        messageKey: "model.connection_not_found",
      });
    }
    if (
      binding.capabilities.operations.includes("embed") &&
      !binding.embeddingSpace
    ) {
      issues.push({
        path: path + "/embeddingSpace",
        messageKey: "model.embedding_space_required",
      });
    }
  }
  return issues;
}

function preparationIssues(
  path: string,
  rules: readonly { mediaType: string; model?: string | undefined }[],
  bindings: Configured["models"]["bindings"],
): SettingIssue[] {
  const issues: SettingIssue[] = [];
  const patterns = new Set<string>();
  for (const rule of rules) {
    if (patterns.has(rule.mediaType)) {
      issues.push({
        path,
        messageKey: "input.duplicate_media_type",
        params: { type: rule.mediaType },
      });
    }
    patterns.add(rule.mediaType);
    if (rule.model !== undefined && !Object.hasOwn(bindings, rule.model)) {
      issues.push({ path, messageKey: "model.binding_not_found" });
    }
  }
  return issues;
}

function taskIssues(models: Configured["models"]): SettingIssue[] {
  return Object.entries(models.tasks).flatMap(([name, route]) => {
    const path = "/models/tasks/" + name;
    const bindings = [
      ["model", route.model] as const,
      ...(route.fallback ?? []).map(
        (model, index) => [`fallback/${index}`, model] as const,
      ),
    ];
    return [
      ...bindings
        .filter(([, model]) => !Object.hasOwn(models.bindings, model))
        .map(([field]) => ({
          path: `${path}/${field}`,
          messageKey: "model.binding_not_found",
        })),
      ...preparationIssues(
        path + "/preparation/representations",
        route.preparation?.representations ?? [],
        models.bindings,
      ),
      ...preparationIssues(
        path + "/preparation/models",
        route.preparation?.models ?? [],
        models.bindings,
      ),
    ];
  });
}

function isLoopback(host: string): boolean {
  const name = host.toLowerCase();
  return (
    ["localhost", "::1", "[::1]"].includes(name) ||
    (isIP(name) === 4 && name.startsWith("127."))
  );
}

function listenerIssues(transports: Configured["transports"]): SettingIssue[] {
  const issues: SettingIssue[] = [];
  if (!Object.keys(transports.authTokens).length) {
    for (const protocol of ["http", "grpc"] as const) {
      const listener = transports[protocol].listen;
      if (listener && !isLoopback(listener.host)) {
        issues.push({
          path: `/transports/${protocol}/listen/host`,
          messageKey: "config.listener_requires_auth",
        });
      }
    }
  }
  if (transports.mcp.mode === "http" && !transports.http.listen) {
    issues.push({
      path: "/transports/mcp/mode",
      messageKey: "config.mcp_requires_http",
    });
  }
  return issues;
}

export const applicationSettings = combineSettings(
  runtimeSettings,
  configurable,
);
