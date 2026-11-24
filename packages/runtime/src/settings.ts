import { z } from "zod";
import { appError, type Json } from "@themelios/core";
import { isLanguageTag } from "./locales.js";
import { networkTimeoutSchema, noProxySchema } from "./network.js";
import { credentialSchema } from "./secrets.js";

export type SettingScope = "installation" | "instance" | "task" | "call";
export type SettingEffect = "next-call" | "reload" | "restart";
export type SettingPath = string;

export interface SettingMeta {
  titleKey: string;
  descriptionKey: string;
  impactKey: string;
  scopes: readonly SettingScope[];
  effect: SettingEffect;
  unit?: string;
  format?: "path" | "credential";
  sensitive?: boolean;
  examples?: readonly Json[];
  dependsOn?: readonly SettingPath[];
}

export interface SettingIssue {
  path: SettingPath;
  messageKey: string;
  params?: Readonly<Record<string, string | number | boolean>>;
}

export interface SettingsDefinition<S> {
  schema: z.ZodType<S>;
  fields: Readonly<Record<SettingPath, SettingMeta>>;
  validateEffective?(value: Readonly<S>): readonly SettingIssue[];
}

export interface SettingDescription {
  path: SettingPath;
  schema: Json;
  metadata: SettingMeta;
}

export interface SettingContribution {
  layer: "default" | "installation" | "instance" | "managed" | "task" | "call";
  value: Json;
  file?: string;
}

export interface SettingExplanation {
  field: SettingDescription;
  contributions: readonly SettingContribution[];
  desired?: Json;
  effective?: Json;
  state: "active" | "restart-required";
}

export interface ConfigurationChange {
  changed: readonly SettingPath[];
  applied: readonly SettingPath[];
  restartRequired: readonly SettingPath[];
}

export interface Configuration<S> {
  snapshot(): Readonly<S>;
  describe(path?: SettingPath): readonly SettingDescription[];
  explain(path: SettingPath): SettingExplanation;
  set(path: SettingPath, value: Json): Promise<ConfigurationChange>;
  unset(path: SettingPath): Promise<ConfigurationChange>;
  reload(): Promise<ConfigurationChange>;
}

export const httpUrlSchema = z.url({ protocol: /^https?$/ }).refine(
  (value) => {
    const url = new URL(value);
    return url.username === "" && url.password === "";
  },
  { message: "HTTP(S) URLs must omit user information" },
);

const schema = z.strictObject({
  locale: z.string().refine(isLanguageTag).default("zh-CN"),
  runtime: z
    .strictObject({
      shutdownGraceMs: z.int().min(0).max(300000).default(10000),
      ioConcurrency: z.int().min(1).max(64).default(4),
    })
    .prefault({}),
  logging: z
    .strictObject({
      level: z.enum(["debug", "info", "warn", "error"]).default("info"),
      file: z.boolean().default(true),
      rotateBytes: z.int().min(65536).max(1073741824).default(10485760),
      maxFiles: z.int().min(1).max(100).default(5),
      captureModelContent: z.boolean().default(false),
    })
    .prefault({}),
  network: z
    .strictObject({
      timeoutMs: networkTimeoutSchema,
      proxy: httpUrlSchema.optional(),
      noProxy: noProxySchema.default([]),
      proxyAuthorization: credentialSchema.optional(),
      caFile: z.string().min(1).optional(),
    })
    .prefault({}),
});

export type RuntimeSettings = z.infer<typeof schema>;

function field(
  path: string,
  effect: SettingMeta["effect"],
  additions: Partial<SettingMeta> = {},
): SettingMeta {
  const key = `runtime.settings.${path.replaceAll("/", ".")}`;
  return {
    titleKey: `${key}.title`,
    descriptionKey: `${key}.description`,
    impactKey: `${key}.impact`,
    scopes: ["installation", "instance"],
    effect,
    ...additions,
  };
}

export const runtimeSettings: SettingsDefinition<RuntimeSettings> = {
  schema,
  fields: {
    "/locale": field("locale", "next-call", {
      scopes: ["installation", "instance", "call"],
    }),
    "/runtime/shutdownGraceMs": field("runtime/shutdownGraceMs", "next-call", {
      unit: "ms",
    }),
    "/runtime/ioConcurrency": field("runtime/ioConcurrency", "reload", {
      unit: "requests",
    }),
    "/logging/level": field("logging/level", "next-call"),
    "/logging/file": field("logging/file", "reload"),
    "/logging/rotateBytes": field("logging/rotateBytes", "reload", {
      unit: "bytes",
    }),
    "/logging/maxFiles": field("logging/maxFiles", "reload"),
    "/logging/captureModelContent": field(
      "logging/captureModelContent",
      "next-call",
    ),
    "/network/timeoutMs": field("network/timeoutMs", "next-call", {
      unit: "ms",
    }),
    "/network/proxy": field("network/proxy", "reload"),
    "/network/noProxy": field("network/noProxy", "reload"),
    "/network/proxyAuthorization": field(
      "network/proxyAuthorization",
      "reload",
      { format: "credential", dependsOn: ["/network/proxy"] },
    ),
    "/network/caFile": field("network/caFile", "reload", { format: "path" }),
  },
  validateEffective(settings) {
    const issues: SettingIssue[] = [];
    if (!settings.network.proxy && settings.network.proxyAuthorization) {
      issues.push({
        path: "/network/proxyAuthorization",
        messageKey: "config.requires_proxy",
      });
    }
    return issues;
  },
};

export function extractRuntimeSettings<S>(value: Readonly<S>): RuntimeSettings {
  const record = value as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of ["locale", "runtime", "logging", "network"]) {
    if (Object.hasOwn(record, key)) picked[key] = record[key];
  }
  return runtimeSettings.schema.parse(picked);
}

export function combineSettings<A, B>(
  a: SettingsDefinition<A>,
  b: SettingsDefinition<B>,
): SettingsDefinition<A & B> {
  if (
    !(a.schema instanceof z.ZodObject) ||
    !(b.schema instanceof z.ZodObject)
  ) {
    throw appError("config.invalid", {
      details: {
        issues: [{ path: "", messageKey: "config.object_required" }],
      },
    });
  }
  const left = a.schema.shape;
  const right = b.schema.shape;
  const collision = Object.keys(left).find((key) => Object.hasOwn(right, key));
  if (collision) {
    throw appError("config.invalid", {
      details: {
        issues: [
          { path: "/" + collision, messageKey: "config.duplicate_setting" },
        ],
      },
    });
  }
  return {
    // Each section validates its own values. Zod rejects keys absent from both sections.
    schema: z.intersection(a.schema.strict(), b.schema.strict()) as z.ZodType<
      A & B
    >,
    fields: { ...a.fields, ...b.fields },
    validateEffective: (value) => [
      ...(a.validateEffective?.(value as Readonly<A>) ?? []),
      ...(b.validateEffective?.(value as Readonly<B>) ?? []),
    ],
  };
}
