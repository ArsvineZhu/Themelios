import { defaultContentImportBytes } from "@themelios/content";
import {
  defaultImagePixels,
  defaultInlineMaterialBytes,
  defaultMediaInputBytes,
} from "@themelios/core";
import { sqliteSynchronousSchema } from "@themelios/storage";
import {
  modelConfigurationSchema,
  modelConfigurationIssues,
} from "@themelios/models";
import {
  combineSettings,
  defineSettings,
  settingMetadata,
  runtimeSettings,
  type RuntimeSettings,
  type SettingEffect,
  type SettingMeta,
} from "@themelios/runtime/settings";
import { z } from "zod";

const budget = (fallback: number) => z.int().positive().default(fallback);

export const preparationSettingsSchema = z
  .strictObject({
    maxMaterialBytes: budget(defaultMediaInputBytes),
    image: z
      .strictObject({ maxPixels: budget(defaultImagePixels) })
      .prefault({}),
    media: z
      .strictObject({
        ffmpeg: z.string().min(1).optional(),
        ffprobe: z.string().min(1).optional(),
      })
      .prefault({}),
  })
  .prefault({});

const schema = z.strictObject({
  models: modelConfigurationSchema,
  content: z
    .strictObject({
      maxImportBytes: budget(defaultContentImportBytes),
      maxInlineBytes: budget(defaultInlineMaterialBytes),
    })
    .prefault({}),
  preparation: preparationSettingsSchema,
  storage: z
    .strictObject({ synchronous: sqliteSynchronousSchema })
    .prefault({}),
});

export type ApplicationSettings = z.output<typeof schema> & RuntimeSettings;

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
];

const configurable = defineSettings({
  schema,
  fields: Object.fromEntries(
    entries.map(([path, effect, extras]) => [
      path,
      settingMetadata("settings", path, effect, extras),
    ]),
  ),
  validateEffective: ({ models }) => modelConfigurationIssues(models),
});

export const applicationSettings = combineSettings(
  runtimeSettings,
  configurable,
);
