import { randomUUID } from "node:crypto";
import {
  appError,
  AppError,
  systemClock,
  throwIfAborted,
  toAppError,
  type Clock,
  type InstanceManifest,
  type Json,
  type MessageParams,
} from "@themelios/core";
import { ActiveConfiguration } from "./configuration/configuration.js";
import { SettingFields } from "./configuration/definition.js";
import {
  loadCandidate,
  readLayers,
  type ConfigurationFiles,
} from "./configuration/load.js";
import {
  bootstrapDiagnostics,
  createRuntimeDiagnostics,
  type Diagnostics,
  type RuntimeDiagnostics,
} from "./diagnostics.js";
import {
  SessionExecution,
  type Closable,
  type Execution,
  type ResourceContext,
  type ResourceSlot,
} from "./execution.js";
import { createLocalizer, type Dictionaries } from "./locales.js";
import {
  openInstanceLock,
  type EndpointPublication,
  type Endpoints,
  type OwnedLock,
} from "./lock.js";
import { createSessionNetwork, type Network } from "./network.js";
import type { InstanceInfo, InstancePaths } from "./paths.js";
import { SessionResources } from "./resources.js";
import { createSecrets, type Secrets } from "./secrets.js";
import type { Configuration, SettingsDefinition } from "./settings.js";
import { shutdownGraceMsSchema } from "./settings.js";

export interface ProvisionEnvironment<S> {
  readonly paths: InstancePaths;
  readonly instance: InstanceManifest;
  readonly settings: Readonly<S>;
  readonly clock: Clock;
  readonly diagnostics: Diagnostics;
}

export interface OpenEnvironment<S> extends ProvisionEnvironment<S> {
  readonly mode: "read-write" | "read-only";
  readonly configuration: Configuration<S>;
  readonly execution: Execution;
  readonly network: Network;
  readonly secrets: Secrets;
  localize(key: string, params?: MessageParams, locale?: string): string;
  own<T extends Closable>(resource: T): T;
  /** Builds a reloadable resource keyed by its settings and by any earlier slots read by the factory. */
  bindResource<T extends Closable>(
    select: (settings: Readonly<S>) => Json,
    create: (context: ResourceContext<S>) => Promise<T>,
  ): Promise<ResourceSlot<T>>;
}

export interface ApplicationModule<Api, S> {
  readonly id: string;
  readonly formatId: string;
  readonly settings: SettingsDefinition<S>;
  /** Maps locale -> full messageKey -> i18next template. */
  readonly locales?: Dictionaries;
  provision(env: ProvisionEnvironment<S>): Promise<void>;
  open(env: OpenEnvironment<S>): Promise<Api>;
}

export interface OpenOptions {
  mode?: "read-write" | "read-only";
  signal?: AbortSignal;
}

export interface Session<Api, S> {
  readonly api: Api;
  readonly instance: InstanceInfo;
  readonly configuration: Configuration<S>;
  readonly languages: readonly string[];
  readonly locale: string;
  localize(key: string, params?: MessageParams, locale?: string): string;
  /** Replaces all endpoints currently recorded for this session. */
  setEndpoints(endpoints: Endpoints): Promise<void>;
  /** Registers these endpoints until the publication or session closes. */
  publishEndpoints(endpoints: Endpoints): Promise<EndpointPublication>;
  close(options?: { graceMs?: number }): Promise<void>;
}

export const clock = systemClock;

export async function openSession<Api, S>(
  application: ApplicationModule<Api, S>,
  locate: () => Promise<InstanceInfo>,
  filesFor: (info: InstanceInfo) => ConfigurationFiles,
  options: OpenOptions,
): Promise<Session<Api, S>> {
  const correlationId = randomUUID();
  const boot = bootstrapDiagnostics(correlationId);
  const mode = options.mode ?? "read-write";
  let stage = "instance.locate";
  let lock: OwnedLock | undefined;
  let resources: SessionResources<S> | undefined;
  let execution: SessionExecution<S> | undefined;
  let configuration: ActiveConfiguration<S> | undefined;
  let diagnostics: RuntimeDiagnostics | undefined;
  let closing: Promise<void> | undefined;
  const owners = new Set<Closable>();
  const failures: { owner: string; code: string }[] = [];
  const closeFailure = (owner: string, error: unknown) => {
    const { code } = toAppError(error);
    failures.push({ owner, code });
    (diagnostics ?? boot).log("warn", "runtime.resource_close_failed", {
      owner,
      code,
    });
  };
  const closeOwned = async () => {
    for (const resource of [...owners].reverse()) {
      try {
        await resource.close();
      } catch (error) {
        closeFailure(resource.constructor.name || "owned", error);
      }
    }
    owners.clear();
  };
  const closeLock = async () => {
    try {
      await lock?.close();
    } catch (error) {
      closeFailure("instance.lock", error);
    }
  };
  try {
    throwIfAborted(options.signal);
    const instance = await locate();
    const { paths, ...identity } = instance;
    stage = "instance.lock";
    lock = await openInstanceLock(paths, identity.id, options.signal);
    stage = "configuration.load";
    const fields = new SettingFields(application.settings);
    const files = filesFor(instance);
    const initial = loadCandidate(fields, files, await readLayers(files));
    throwIfAborted(options.signal);
    stage = "runtime.resources";
    const localize = await createLocalizer(application.locales);
    const secrets = createSecrets({ baseDir: paths.root });
    let capturedExecution!: SessionExecution<S>;
    const ownedResources: SessionResources<S> = new SessionResources<S>(
      secrets,
      (settings) =>
        createRuntimeDiagnostics({
          settings,
          logs: paths.logs,
          correlationId,
          level: () => {
            try {
              return (
                capturedExecution.currentResources()?.runtime.logging.level ??
                ownedResources.active.runtime.logging.level
              );
            } catch {
              return undefined;
            }
          },
          capture: () => {
            try {
              return (
                capturedExecution.currentResources()?.runtime.logging
                  .captureModelContent ??
                ownedResources.active.runtime.logging.captureModelContent
              );
            } catch {
              return undefined;
            }
          },
          traceScope: {
            current: () => capturedExecution.currentTrace(),
            enter: (frame, work) => capturedExecution.enterTrace(frame, work),
          },
        }),
      (settings, candidateDiagnostics) =>
        createSessionNetwork(settings.network, {
          secrets,
          diagnostics: candidateDiagnostics,
          current() {
            const capture = capturedExecution.current();
            try {
              const active =
                capturedExecution.currentResources() ?? ownedResources.active;
              return {
                call: capture?.call,
                diagnostics: active.diagnostics,
                timeoutMs: active.runtime.network.timeoutMs,
              };
            } catch {
              return undefined;
            }
          },
        }),
      closeFailure,
    );
    resources = ownedResources;
    capturedExecution = new SessionExecution(() => ownedResources.active);
    execution = capturedExecution;
    const current = () => capturedExecution.currentResources();
    (await ownedResources.prepare(initial.value)).activate();
    diagnostics = ownedResources.active.diagnostics;
    const settings = new ActiveConfiguration(
      fields,
      files,
      initial,
      mode,
      () => current()?.settings,
      async (candidate) => {
        const prepared = await ownedResources.prepare(candidate);
        return {
          ...prepared,
          activate() {
            prepared.activate();
            diagnostics = ownedResources.active.diagnostics;
          },
        };
      },
    );
    configuration = settings;
    throwIfAborted(options.signal);
    stage = "application.open";
    const env: OpenEnvironment<S> = {
      paths,
      instance: identity,
      clock,
      mode,
      configuration: settings,
      execution: capturedExecution,
      secrets,
      get settings() {
        return settings.snapshot();
      },
      get diagnostics() {
        return (current() ?? ownedResources.active).diagnostics;
      },
      get network() {
        return (current() ?? ownedResources.active).network;
      },
      localize(key, params, locale) {
        return localize(
          locale ?? (current() ?? ownedResources.active).runtime.locale,
          key,
          params,
        );
      },
      own<T extends Closable>(resource: T) {
        owners.add(resource);
        return resource;
      },
      bindResource: (select, create) =>
        settings.serialize(() =>
          ownedResources.bind(
            select,
            (candidate) =>
              capturedExecution.withPreparingResources(candidate, () =>
                create(candidate),
              ),
            current,
          ),
        ),
    };
    const api = await application.open(env);
    throwIfAborted(options.signal);
    stage = "ready";
    diagnostics!.log("info", "runtime.session_opened", {
      instanceId: identity.id,
      mode,
      locale: ownedResources.active.runtime.locale,
    });
    const session: Session<Api, S> = {
      api,
      instance,
      configuration: settings,
      languages: localize.languages,
      get locale() {
        return (current() ?? ownedResources.active).runtime.locale;
      },
      localize: env.localize,
      setEndpoints(endpoints) {
        if (closing || !lock)
          return Promise.reject(
            appError("runtime.closed", { details: { state: "closed" } }),
          );
        return lock.setEndpoints(endpoints);
      },
      publishEndpoints(endpoints) {
        if (closing || !lock)
          return Promise.reject(
            appError("runtime.closed", { details: { state: "closed" } }),
          );
        return lock.publishEndpoints(endpoints);
      },
      close(options) {
        if (closing) return closing;
        const graceMs =
          options?.graceMs ??
          ownedResources.active.runtime.runtime.shutdownGraceMs;
        const grace = shutdownGraceMsSchema.safeParse(graceMs);
        if (!grace.success) {
          return Promise.reject(
            appError("input.invalid", {
              details: {
                issues: [
                  { path: ["graceMs"], reason: grace.error.issues[0]!.message },
                ],
              },
            }),
          );
        }
        capturedExecution.stop();
        const updates = settings.stop();
        closing = (async () => {
          await capturedExecution.drain(grace.data);
          await updates;
          await ownedResources.close(closeOwned);
          await closeLock();
          if (failures.length)
            throw appError("runtime.close_failed", {
              details: {
                owners: failures.map((error) => error.owner),
                codes: failures.map((error) => error.code),
              },
            });
        })();
        return closing;
      },
    };
    return session;
  } catch (error) {
    execution?.stop();
    const updates = configuration?.stop();
    const mapped = toAppError(error);
    (diagnostics ?? boot).log("error", "runtime.start_failed", {
      stage,
      code: mapped.code,
      ...(error instanceof AppError && error.details !== undefined
        ? { details: error.details }
        : {}),
    });
    await execution?.drain(0);
    await updates;
    if (resources) await resources.close(closeOwned);
    else await closeOwned();
    await closeLock();
    throw mapped;
  }
}
