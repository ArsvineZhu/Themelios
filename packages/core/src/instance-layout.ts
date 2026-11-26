import { z } from "zod";
import { instantSchema } from "./time.js";

/** The identity and directory layout stored on disk for a Themelios instance. */
export const instanceManifestFile = "instance.json";
export const instanceManifestSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1),
  applicationId: z.string().min(1),
  formatId: z.string().min(1),
  createdAt: instantSchema,
});
export type InstanceManifest = z.infer<typeof instanceManifestSchema>;

export const installationDirectories = {
  config: "config",
  instances: "instances",
} as const;

export const instanceDirectories = {
  config: "config",
  state: "state",
  objects: "objects",
  cache: "cache",
  logs: "logs",
  run: "run",
} as const;

export const instanceConfigurationFiles = {
  installation: "installation.toml",
  instance: "instance.toml",
  managed: "managed.toml",
  prompts: "prompts",
} as const;
