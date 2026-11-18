import { z } from "zod";
import { failure } from "./failure.js";
import { credentialSchema } from "./secrets.js";
import type { SettingMeta, SettingsDefinition } from "./settings-contract.js";

export type {
  Configuration,
  ConfigurationChange,
  SettingContribution,
  SettingDescription,
  SettingEffect,
  SettingExplanation,
  SettingIssue,
  SettingMeta,
  SettingPath,
  SettingScope,
  SettingsDefinition,
} from "./settings-contract.js";

export const httpUrlSchema = z.url({ protocol: /^https?$/ }).refine(
  (value) => {
    const url = new URL(value);
    return url.username === "" && url.password === "";
  },
  { message: "HTTP(S) URLs must omit user information" },
);

const schema = z.strictObject({
  locale: z.enum(["zh-CN", "en"]).default("zh-CN"),
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
    })
    .prefault({}),
  telemetry: z
    .strictObject({
      endpoint: httpUrlSchema.optional(),
      credential: credentialSchema.optional(),
      captureModelContent: z.boolean().default(false),
    })
    .prefault({}),
  network: z
    .strictObject({
      timeoutMs: z.int().min(1).max(3600000).default(60000),
      proxy: httpUrlSchema.optional(),
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
    "/telemetry/endpoint": field("telemetry/endpoint", "reload"),
    "/telemetry/credential": field("telemetry/credential", "reload", {
      format: "credential",
      dependsOn: ["/telemetry/endpoint"],
    }),
    "/telemetry/captureModelContent": field(
      "telemetry/captureModelContent",
      "next-call",
    ),
    "/network/timeoutMs": field("network/timeoutMs", "next-call", {
      unit: "ms",
    }),
    "/network/proxy": field("network/proxy", "reload"),
    "/network/proxyAuthorization": field(
      "network/proxyAuthorization",
      "reload",
      { format: "credential", dependsOn: ["/network/proxy"] },
    ),
    "/network/caFile": field("network/caFile", "reload", { format: "path" }),
  },
  validateEffective(settings) {
    const issues = [];
    if (!settings.network.proxy && settings.network.proxyAuthorization) {
      issues.push({
        path: "/network/proxyAuthorization",
        messageKey: "config.requires_proxy",
      });
    }
    if (!settings.telemetry.endpoint && settings.telemetry.credential) {
      issues.push({
        path: "/telemetry/credential",
        messageKey: "config.requires_telemetry_endpoint",
      });
    }
    return issues;
  },
};

export function combineSettings<A, B>(
  a: SettingsDefinition<A>,
  b: SettingsDefinition<B>,
): SettingsDefinition<A & B> {
  if (
    !(a.schema instanceof z.ZodObject) ||
    !(b.schema instanceof z.ZodObject)
  ) {
    throw failure("config.invalid", {
      issues: [{ path: "", messageKey: "config.object_required" }],
    });
  }
  const left = a.schema.shape;
  const right = b.schema.shape;
  const collision = Object.keys(left).find((key) => Object.hasOwn(right, key));
  if (collision) {
    throw failure("config.invalid", {
      issues: [
        { path: "/" + collision, messageKey: "config.duplicate_setting" },
      ],
    });
  }
  return {
    schema: z.strictObject({
      ...left,
      ...right,
    }) as unknown as SettingsDefinition<A & B>["schema"],
    fields: { ...a.fields, ...b.fields },
    validateEffective: (value) => [
      ...(a.validateEffective?.(value as Readonly<A>) ?? []),
      ...(b.validateEffective?.(value as Readonly<B>) ?? []),
    ],
  };
}
