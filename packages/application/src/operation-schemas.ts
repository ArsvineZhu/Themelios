import {
  artifactRefSchema as ref,
  commitPointSchema,
  errorInfoSchema,
  jsonSchema,
} from "@themelios/core";
import { instantSchema } from "@themelios/core/time";
import {
  taskRequirementsSchema,
  taskExampleSourceSchema,
} from "@themelios/models/tasks";
import { z } from "zod";
import {
  wireOriginSchema,
  wireResultSchema,
  wireSelectionSchema as selection,
} from "./wire.js";

const size = z.int().nonnegative();
const extent = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), bytes: size }),
  z.strictObject({
    kind: z.literal("image"),
    width: size,
    height: size,
    frames: size,
  }),
  z.strictObject({ kind: z.literal("pages"), pages: size }),
  z.strictObject({
    kind: z.literal("time"),
    durationMs: z.number().nonnegative(),
  }),
  z.strictObject({ kind: z.literal("unknown") }),
]);

export const artifact = z.strictObject({
  ref,
  kind: z.enum(["material", "result"]),
  mediaType: z.string(),
  sizeBytes: size,
  name: z.string().optional(),
  extent,
  createdAt: instantSchema,
  createdAtCut: commitPointSchema,
  origin: wireOriginSchema.optional(),
});

export const instanceInfo = z.strictObject({
  id: z.string(),
  name: z.string(),
  applicationId: z.string(),
  formatId: z.string(),
  createdAt: instantSchema,
  paths: z.strictObject({
    root: z.string(),
    config: z.string(),
    state: z.string(),
    objects: z.string(),
    cache: z.string(),
    logs: z.string(),
    run: z.string(),
  }),
});
export const binary = z.strictObject({
  info: artifact,
  body: z.instanceof(ReadableStream),
});
export const requiredRef = z.strictObject({ ref });
export const listMaterials = z.strictObject({
  at: commitPointSchema.optional(),
  after: ref.optional(),
  limit: z.int().positive().optional(),
});
export const textBlocks = z.array(
  z.strictObject({
    kind: z.enum([
      "heading",
      "paragraph",
      "list",
      "code",
      "quote",
      "table",
      "thematic-break",
    ]),
    selection,
    depth: z.int().positive().optional(),
    text: z.string(),
  }),
);
export const sourceLinks = z.array(
  z.strictObject({
    selection,
    relation: z.enum(["input", "file", "copy", "representation-source"]),
  }),
);

export const promptPart = z.enum(["system", "user"]);
const promptInfo = z.strictObject({
  role: promptPart,
  path: z.string(),
  source: z.enum(["builtin", "override"]),
});
export const promptTemplates = z.strictObject({
  system: z.string(),
  user: z.string(),
  files: z.array(promptInfo),
});
export const promptDescription = z.strictObject({
  files: z.array(promptInfo),
  variablesSchema: jsonSchema,
  outputSchema: jsonSchema.optional(),
  requirements: taskRequirementsSchema,
});
export const promptDiff = z.array(
  z.strictObject({
    role: promptPart,
    builtin: z.string(),
    override: z.string().optional(),
  }),
);
export const taskList = z.array(
  z.strictObject({ id: z.string(), title: z.string(), purpose: z.string() }),
);
export const taskDescription = z.strictObject({
  id: z.string(),
  title: z.string(),
  purpose: z.string(),
  inputSchema: jsonSchema,
  sourcesSchema: jsonSchema,
  output: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("text") }),
    z.strictObject({ kind: z.literal("json"), schema: jsonSchema }),
  ]),
  requirements: taskRequirementsSchema,
  templates: z.array(promptInfo),
  outputRules: z.array(z.string()),
  examples: z.array(
    z.strictObject({
      name: z.string(),
      variables: jsonSchema,
      sources: z.array(taskExampleSourceSchema),
      output: jsonSchema,
    }),
  ),
});
export const batch = z.array(
  z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), result: wireResultSchema }),
    z.strictObject({ ok: z.literal(false), error: errorInfoSchema }),
  ]),
);

const settingMeta = z.strictObject({
  titleKey: z.string(),
  descriptionKey: z.string(),
  impactKey: z.string(),
  scopes: z.array(z.enum(["installation", "instance", "task", "call"])),
  effect: z.enum(["next-call", "reload", "restart"]),
  unit: z.string().optional(),
  format: z.enum(["path", "credential"]).optional(),
  sensitive: z.boolean().optional(),
  examples: z.array(jsonSchema).optional(),
  dependsOn: z.array(z.string()).optional(),
});
const setting = z.strictObject({
  path: z.string(),
  schema: jsonSchema,
  metadata: settingMeta,
});
export const settings = z.array(setting);
export const explainSetting = z.strictObject({
  field: setting,
  contributions: z.array(
    z.strictObject({
      layer: z.enum([
        "default",
        "installation",
        "instance",
        "managed",
        "task",
        "call",
      ]),
      value: jsonSchema,
      file: z.string().optional(),
    }),
  ),
  desired: jsonSchema.optional(),
  effective: jsonSchema.optional(),
  state: z.enum(["active", "restart-required"]),
});
export const changedSettings = z.strictObject({
  changed: z.array(z.string()),
  applied: z.array(z.string()),
  restartRequired: z.array(z.string()),
});
