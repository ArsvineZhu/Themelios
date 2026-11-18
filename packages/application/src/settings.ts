import { isIP } from "node:net";
import { jsonSchema } from "@themelios/core";
import {
  connectionSchema,
  mimePatternSchema,
  modelBindingSchema,
  modelNameSchema,
  modelParametersSchema,
} from "@themelios/models";
import {
  combineSettings,
  runtimeSettings,
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
const size = (fallback: number, max: number) =>
  z.int().min(1).max(max).default(fallback);

const policy = z.strictObject({
  representations: z
    .array(
      z.strictObject({
        mediaType: mimePatternSchema,
        recipe: modelNameSchema,
        parameters: jsonSchema.optional(),
      }),
    )
    .optional(),
  models: z
    .array(
      z.strictObject({
        mediaType: mimePatternSchema,
        recipe: z.enum(["media.describe", "speech.transcribe"]),
        model: modelNameSchema,
      }),
    )
    .optional(),
});
const taskRoute = z.strictObject({
  model: modelNameSchema,
  parameters: modelParametersSchema.optional(),
  preparation: policy.optional(),
});
const listen = z.strictObject({
  host: z.string().min(1).default("127.0.0.1"),
  port: z.int().min(1).max(65535),
});
const schema = z.strictObject({
  models: z
    .strictObject({
      timeoutMs: size(120_000, 3_600_000),
      maxAttempts: size(1, 5),
      concurrency: size(4, 64),
      bindings: z.record(modelNameSchema, modelBindingSchema).default({}),
      connections: z.record(modelNameSchema, connectionSchema).default({}),
      tasks: z.record(modelNameSchema, taskRoute).default({}),
    })
    .prefault({}),
  content: z
    .strictObject({
      maxImportBytes: size(1_073_741_824, Number.MAX_SAFE_INTEGER),
      maxInlineBytes: size(8_388_608, 67_108_864),
    })
    .prefault({}),
  preparation: z
    .strictObject({
      maxMaterialBytes: size(67_108_864, 1_073_741_824),
      image: z
        .strictObject({ maxPixels: size(40_000_000, 268_435_456) })
        .prefault({}),
    })
    .prefault({}),
  storage: z
    .strictObject({ synchronous: z.enum(["FULL", "NORMAL"]).default("FULL") })
    .prefault({}),
  transports: z
    .strictObject({
      maxJsonBytes: size(8_388_608, 1_073_741_824),
      authTokens: z
        .record(
          modelNameSchema,
          z.strictObject({ secret: fileCredential, permissions }),
        )
        .default({}),
      http: z
        .strictObject({
          listen: listen.optional(),
          allowedHosts: z
            .array(z.string().min(1))
            .default(["localhost", "127.0.0.1", "[::1]"]),
          allowedOrigins: z.array(z.url({ protocol: /^https?$/ })).default([]),
        })
        .prefault({}),
      mcp: z
        .strictObject({ mode: z.enum(["stdio", "http"]).optional() })
        .prefault({}),
    })
    .prefault({}),
});

type Configured = z.infer<typeof schema>;
export type ApplicationSettings = Configured &
  import("@themelios/runtime/settings").RuntimeSettings;

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
    { scopes: ["installation", "instance", "task"] },
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
  ["/storage/synchronous", "restart"],
  ["/transports/maxJsonBytes", "next-call", { unit: "bytes" }],
  ["/transports/http/listen", "restart"],
  ["/transports/http/allowedHosts", "reload"],
  ["/transports/http/allowedOrigins", "reload"],
  ["/transports/mcp/mode", "restart"],
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
    const primary = Object.hasOwn(models.bindings, route.model)
      ? []
      : [{ path: path + "/model", messageKey: "model.binding_not_found" }];
    return [
      ...primary,
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
    const listen = transports.http.listen;
    if (listen && !isLoopback(listen.host)) {
      issues.push({
        path: "/transports/http/listen/host",
        messageKey: "config.listener_requires_auth",
      });
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
