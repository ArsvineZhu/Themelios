import {
  instanceConfigurationFiles,
  instanceDirectories,
  instanceManifestSchema,
} from "@themelios/core";
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

export const instanceInfoSchema = instanceManifestSchema.extend({
  paths: instancePathsSchema,
});

export type InstancePaths = z.infer<typeof instancePathsSchema>;
export type InstanceInfo = z.infer<typeof instanceInfoSchema>;

export function instancePaths(root: string): InstancePaths {
  return {
    root,
    config: join(root, instanceDirectories.config),
    state: join(root, instanceDirectories.state),
    objects: join(root, instanceDirectories.objects),
    cache: join(root, instanceDirectories.cache),
    logs: join(root, instanceDirectories.logs),
    run: join(root, instanceDirectories.run),
  };
}

export function configurationFiles(
  configRoot: string,
  paths: InstancePaths,
): ConfigurationFiles {
  return {
    installation: installationConfigurationPath(configRoot),
    instance: join(paths.config, instanceConfigurationFiles.instance),
    managed: join(paths.config, instanceConfigurationFiles.managed),
  };
}

export function installationConfigurationPath(configRoot: string): string {
  return join(configRoot, instanceConfigurationFiles.installation);
}
