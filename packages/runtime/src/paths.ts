import { join } from "node:path";
import type { InstancePaths } from "./contracts.js";
import type { ConfigurationFiles } from "./configuration/load.js";

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
