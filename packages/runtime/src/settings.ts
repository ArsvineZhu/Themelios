import { z } from "zod";
import { jsonSchema, type Json, type MessageParams } from "@themelios/core";
import { defineSettings } from "./configuration/compose.js";
import { defaultLocale, isLanguageTag } from "./locales.js";
import { networkSettingsSchema, networkSettingIssues } from "./network.js";

const settingScopeSchema = z.enum(["installation", "instance", "task", "call"]);
const settingEffectSchema = z.enum(["next-call", "reload", "restart"]);
export type SettingScope = z.output<typeof settingScopeSchema>;
export type SettingEffect = z.output<typeof settingEffectSchema>;
export type SettingPath = string;
/** File layers in ascending precedence. */
export const configurationFileLayers = [
  "installation",
  "instance",
  "managed",
] as const;

export {
  combineSettings,
  defineSettings,
  type SettingsDefinition,
  type SettingsValues,
} from "./configuration/compose.js";

const settingMetadataSchema = z.strictObject({
  titleKey: z.string(),
  descriptionKey: z.string(),
  impactKey: z.string(),
  scopes: z.array(settingScopeSchema).readonly(),
  effect: settingEffectSchema,
  unit: z.string().optional(),
  format: z.enum(["path", "credential"]).optional(),
  sensitive: z.boolean().optional(),
  examples: z.array(jsonSchema).readonly().optional(),
  dependsOn: z.array(z.string()).readonly().optional(),
});
export type SettingMeta = z.output<typeof settingMetadataSchema>;

export interface SettingIssue {
  path: SettingPath;
  messageKey: string;
  params?: MessageParams;
}

export const settingDescriptionSchema = z.strictObject({
  path: z.string(),
  schema: jsonSchema,
  metadata: settingMetadataSchema,
});
export type SettingDescription = z.output<typeof settingDescriptionSchema>;

const settingContributionSchema = z.strictObject({
  layer: z.enum(["default", ...configurationFileLayers, "task", "call"]),
  value: jsonSchema,
  file: z.string().optional(),
});
export type SettingContribution = z.output<typeof settingContributionSchema>;

export const settingExplanationSchema = z.strictObject({
  field: settingDescriptionSchema,
  contributions: z.array(settingContributionSchema).readonly(),
  desired: jsonSchema.optional(),
  effective: jsonSchema.optional(),
  state: z.enum(["active", "restart-required"]),
});
export type SettingExplanation = z.output<typeof settingExplanationSchema>;

export const configurationChangeSchema = z.strictObject({
  changed: z.array(z.string()).readonly(),
  applied: z.array(z.string()).readonly(),
  restartRequired: z.array(z.string()).readonly(),
});
export type ConfigurationChange = z.output<typeof configurationChangeSchema>;

export interface Configuration<S> {
  snapshot(): Readonly<S>;
  describe(path?: SettingPath): readonly SettingDescription[];
  explain(path: SettingPath): SettingExplanation;
  set(path: SettingPath, value: Json): Promise<ConfigurationChange>;
  unset(path: SettingPath): Promise<ConfigurationChange>;
  reload(): Promise<ConfigurationChange>;
}

export const shutdownGraceMsSchema = z.int().min(0).max(300_000);

const schema = z.strictObject({
  locale: z.string().refine(isLanguageTag).default(defaultLocale),
  runtime: z
    .strictObject({
      shutdownGraceMs: shutdownGraceMsSchema.default(10_000),
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
  network: networkSettingsSchema.prefault({}),
});

export type RuntimeSettings = z.infer<typeof schema>;

export function settingMetadata(
  prefix: string,
  path: string,
  effect: SettingMeta["effect"],
  additions: Partial<SettingMeta> = {},
): SettingMeta {
  const key = [prefix, ...path.split("/").filter(Boolean)].join(".");
  return {
    titleKey: `${key}.title`,
    descriptionKey: `${key}.description`,
    impactKey: `${key}.impact`,
    scopes: ["installation", "instance"],
    effect,
    ...additions,
  };
}

export const runtimeSettings = defineSettings({
  schema,
  fields: {
    "/locale": settingMetadata("runtime.settings", "locale", "next-call", {
      scopes: ["installation", "instance", "call"],
    }),
    "/runtime/shutdownGraceMs": settingMetadata(
      "runtime.settings",
      "runtime/shutdownGraceMs",
      "next-call",
      {
        unit: "ms",
      },
    ),
    "/runtime/ioConcurrency": settingMetadata(
      "runtime.settings",
      "runtime/ioConcurrency",
      "reload",
      {
        unit: "requests",
      },
    ),
    "/logging/level": settingMetadata(
      "runtime.settings",
      "logging/level",
      "next-call",
    ),
    "/logging/file": settingMetadata(
      "runtime.settings",
      "logging/file",
      "reload",
    ),
    "/logging/rotateBytes": settingMetadata(
      "runtime.settings",
      "logging/rotateBytes",
      "reload",
      {
        unit: "bytes",
      },
    ),
    "/logging/maxFiles": settingMetadata(
      "runtime.settings",
      "logging/maxFiles",
      "reload",
    ),
    "/logging/captureModelContent": settingMetadata(
      "runtime.settings",
      "logging/captureModelContent",
      "next-call",
    ),
    "/network/timeoutMs": settingMetadata(
      "runtime.settings",
      "network/timeoutMs",
      "next-call",
      {
        unit: "ms",
      },
    ),
    "/network/proxy": settingMetadata(
      "runtime.settings",
      "network/proxy",
      "reload",
    ),
    "/network/noProxy": settingMetadata(
      "runtime.settings",
      "network/noProxy",
      "reload",
    ),
    "/network/proxyAuthorization": settingMetadata(
      "runtime.settings",
      "network/proxyAuthorization",
      "reload",
      { format: "credential", dependsOn: ["/network/proxy"] },
    ),
    "/network/caFile": settingMetadata(
      "runtime.settings",
      "network/caFile",
      "reload",
      { format: "path" },
    ),
  },
  validateEffective({ network }) {
    return networkSettingIssues(network);
  },
});
