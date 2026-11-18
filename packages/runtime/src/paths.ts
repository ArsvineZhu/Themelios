import { instantSchema } from "@themelios/core";
import { z } from "zod";
import { join } from "node:path";
import type { ConfigurationFiles } from "./configuration/load.js";

export const instancePathsSchema = z.strictObject({
  root: z.string(),
  config: z.string(),
  state: z.string(),
  objects: z.string(),
  cache: z.string(),
  logs: z.string(),
  run: z.string(),
});

export const instanceInfoSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  applicationId: z.string().min(1),
  formatId: z.string().min(1),
  createdAt: instantSchema,
  paths: instancePathsSchema,
});

export type InstancePaths = z.infer<typeof instancePathsSchema>;
export type InstanceInfo = z.infer<typeof instanceInfoSchema>;

export function instancePaths(root: string): InstancePaths {
  return {
    root,
    config: join(root, "config"),
    state: join(root, "state"),
    objects: join(root, "objects"),
    cache: join(root, "cache"),
    logs: join(root, "logs"),
    run: join(root, "run"),
  };
}

export function configurationFiles(
  configRoot: string,
  paths: InstancePaths,
): ConfigurationFiles {
  return {
    installation: join(configRoot, "installation.toml"),
    instance: join(paths.config, "instance.toml"),
    managed: join(paths.config, "managed.toml"),
  };
}
