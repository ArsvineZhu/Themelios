import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  appError,
  errorCode,
  AppError,
  instantSchema,
  throwIfAborted,
} from "@themelios/core";
import { z } from "zod";
import { SettingFields } from "./configuration/definition.js";
import { loadCandidate, readLayers } from "./configuration/load.js";
import { bootstrapDiagnostics } from "./diagnostics.js";
import { openInstanceLock } from "./lock.js";
import {
  configurationFiles,
  instancePaths,
  type InstanceInfo,
} from "./paths.js";
import {
  clock,
  openSession,
  type ApplicationModule,
  type OpenOptions,
  type Session,
} from "./session.js";

export interface InstallationOptions {
  configRoot?: string;
  dataRoot?: string;
}

export interface Instance<Api, S> {
  init(): Promise<InstanceInfo>;
  locate(): Promise<InstanceInfo>;
  open(options?: OpenOptions): Promise<Session<Api, S>>;
}

const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const manifestSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1),
  applicationId: z.string().min(1),
  formatId: z.string().min(1),
  createdAt: instantSchema,
});
type Manifest = z.infer<typeof manifestSchema>;

export class Installation<Api, S> {
  private constructor(
    private readonly application: ApplicationModule<Api, S>,
    private readonly configRoot: string,
    private readonly dataRoot: string,
  ) {}

  static at<Api, S>(
    root: string,
    application: ApplicationModule<Api, S>,
    options: InstallationOptions = {},
  ): Installation<Api, S> {
    const absolute = resolve(root);
    return new Installation(
      application,
      resolve(absolute, options.configRoot ?? "config"),
      resolve(absolute, options.dataRoot ?? "instances"),
    );
  }

  instance(name: string): Instance<Api, S> {
    if (!namePattern.test(name))
      throw appError("runtime.instance_name_invalid", { details: { name } });
    return this.#at(join(this.dataRoot, name), name, true);
  }

  external(root: string): Instance<Api, S> {
    const absolute = resolve(root);
    return this.#at(absolute, basename(absolute));
  }

  #at(root: string, name: string, createConfigRoot = false): Instance<Api, S> {
    const application = this.application;
    const paths = instancePaths(root);
    const filesFor = (info: InstanceInfo) =>
      configurationFiles(this.configRoot, info.paths);
    const locate = async (): Promise<InstanceInfo> => {
      const manifest = await readManifest(root);
      if (manifest.applicationId !== application.id) {
        throw appError("runtime.application_mismatch", {
          details: {
            expected: application.id,
            actual: manifest.applicationId,
          },
        });
      }
      if (manifest.formatId !== application.formatId) {
        throw appError("runtime.format_mismatch", {
          details: {
            expected: application.formatId,
            actual: manifest.formatId,
          },
        });
      }
      return { ...manifest, paths };
    };
    return {
      init: () =>
        initialize(application, this.configRoot, root, name, createConfigRoot),
      locate,
      open: (options = {}) =>
        openSession(application, locate, filesFor, options),
    };
  }
}

export async function withOfflineInstance<Api, S, T>(
  instance: Instance<Api, S>,
  work: (info: InstanceInfo) => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  throwIfAborted(options.signal);
  const info = await instance.locate();
  const lock = await openInstanceLock(info.paths, info.id, options.signal);
  try {
    return await work(info);
  } finally {
    await lock.close();
  }
}

export async function withInstanceLock<T>(
  root: string,
  work: () => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const paths = instancePaths(resolve(root));
  const lock = await openInstanceLock(paths, undefined, options.signal);
  try {
    return await work();
  } finally {
    await lock.close();
  }
}

async function readManifest(root: string): Promise<Manifest> {
  const file = join(root, "instance.json");
  try {
    return manifestSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      throw appError("runtime.instance_not_found", { cause: error });
    throw appError("runtime.instance_invalid", {
      details: { path: file },
      cause: error,
    });
  }
}

async function targetState(path: string): Promise<"missing" | "empty"> {
  let directory: boolean;
  try {
    directory = (await lstat(path)).isDirectory();
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
  }
  if (directory) {
    const entries = await readdir(path);
    if (!entries.length) return "empty";
    if (entries.includes("instance.json")) {
      let id: string | undefined;
      try {
        id = (await readManifest(path)).id;
      } catch {
        /* Keep the occupied manifest in place. */
      }
      throw appError(
        "runtime.instance_exists",
        id ? { details: { instanceId: id } } : {},
      );
    }
  }
  throw appError("runtime.instance_not_empty", { details: { path } });
}

async function initialize<Api, S>(
  application: ApplicationModule<Api, S>,
  configRoot: string,
  target: string,
  name: string,
  createConfigRoot: boolean,
): Promise<InstanceInfo> {
  const diagnostics = bootstrapDiagnostics(randomUUID());
  const parent = dirname(target);
  let staging: string | undefined;
  try {
    await mkdir(parent, { recursive: true });
    await targetState(target);
    if (createConfigRoot) await mkdir(configRoot, { recursive: true });
    staging = await mkdtemp(join(parent, "." + name + ".init-"));
    const paths = instancePaths(staging);
    await Promise.all(
      [
        paths.config,
        paths.state,
        paths.objects,
        paths.cache,
        paths.logs,
        paths.run,
      ].map((path) => mkdir(path)),
    );
    await mkdir(join(paths.config, "prompts"));
    const files = configurationFiles(configRoot, paths);
    await writeFile(files.managed, "", { flag: "wx" });
    const instance: Manifest = {
      id: randomUUID(),
      applicationId: application.id,
      formatId: application.formatId,
      name,
      createdAt: clock.now(),
    };
    const fields = new SettingFields(application.settings);
    const settings = loadCandidate(
      fields,
      files,
      await readLayers(files),
    ).value;
    await application.provision({
      paths,
      instance,
      settings,
      clock,
      diagnostics,
    });
    await writeFile(
      join(staging, "instance.json"),
      JSON.stringify(instance, null, 2) + "\n",
      { flag: "wx", flush: true },
    );
    await publishInstance(staging, target);
    return { ...instance, paths: instancePaths(target) };
  } catch (error) {
    if (staging !== undefined) {
      diagnostics.log("error", "runtime.init_failed", {
        staging,
        cleanup: await removeStaging(staging),
        ...(error instanceof AppError && error.details !== undefined
          ? { details: error.details }
          : {}),
        code:
          error instanceof AppError
            ? error.code
            : (errorCode(error) ?? "runtime.init_failed"),
      });
    }
    if (error instanceof AppError) throw error;
    throw appError("runtime.init_failed", {
      details: { path: target },
      cause: error,
    });
  }
}

async function publishInstance(staging: string, target: string): Promise<void> {
  await preparePublicationTarget(target);
  let firstSharingError: unknown;
  const delays = process.platform === "win32" ? [0, 10, 30, 60] : [0];
  for (const waitMs of delays) {
    if (waitMs) {
      await Bun.sleep(waitMs);
      if ((await targetState(target)) !== "missing") throw firstSharingError;
    }
    try {
      await rename(staging, target);
      return;
    } catch (error) {
      const state = await targetState(target);
      if (
        state !== "missing" ||
        process.platform !== "win32" ||
        errorCode(error) !== "EPERM"
      )
        throw error;
      firstSharingError ??= error;
    }
  }
  throw firstSharingError;
}

async function preparePublicationTarget(target: string): Promise<void> {
  if ((await targetState(target)) === "missing") return;
  try {
    await rmdir(target);
  } catch (error) {
    if (
      errorCode(error) !== "ENOENT" &&
      (await targetState(target)) !== "missing"
    )
      throw error;
  }
}

async function removeStaging(path: string): Promise<string> {
  try {
    await rm(path, { recursive: true, force: true });
    return "removed";
  } catch (error) {
    return errorCode(error) ?? "cleanup_failed";
  }
}
