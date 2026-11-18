import { randomUUID } from "node:crypto";
import { AppError, throwIfAborted, toAppError } from "@themelios/core";
import type {
  ApplicationModule,
  Closable,
  InstanceInfo,
  OpenEnvironment,
  OpenOptions,
  Session,
} from "./contracts.js";
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
  type RuntimeDiagnostics,
} from "./diagnostics.js";
import { SessionExecution } from "./execution.js";
import { failure } from "./failure.js";
import { createLocalizer } from "./locales.js";
import { openInstanceLock, type Endpoints, type OwnedLock } from "./lock.js";
import { createSessionNetwork } from "./network.js";
import { SessionResources } from "./resources.js";
import { createSecrets } from "./secrets.js";
import { runtimeSettings } from "./settings.js";

const endpointUpdates = new WeakMap<
  object,
  (value: Endpoints) => Promise<void>
>();

export function updateSessionEndpoints<Api, S>(
  session: Session<Api, S>,
  endpoints: Endpoints,
): Promise<void> {
  const update = endpointUpdates.get(session);
  return update
    ? update(endpoints)
    : Promise.reject(failure("runtime.closed", { state: "closed" }));
}

export const clock = {
  now: () => new Date().toISOString(),
  monotonicMs: () => performance.now(),
};

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
    // Small custom apps may use only their own settings; the runtime's own defaults still apply.
    const getRuntime = (value: Readonly<S>) =>
      runtimeSettings.schema.parse(
        Object.fromEntries(
          Object.entries(value as Record<string, unknown>).filter(([key]) =>
            ["locale", "runtime", "logging", "telemetry", "network"].includes(
              key,
            ),
          ),
        ),
      );
    stage = "runtime.resources";
    const localize = await createLocalizer(application.locales);
    const secrets = createSecrets({ baseDir: paths.root });
    const ownedResources = new SessionResources<S>(
      secrets,
      getRuntime,
      (settings) =>
        createRuntimeDiagnostics({
          settings,
          secrets,
          logs: paths.logs,
          correlationId,
          level: () => {
            const captured =
              execution?.current()?.resources.settings ??
              configuration?.snapshot();
            return captured ? getRuntime(captured).logging.level : undefined;
          },
          capture: () => {
            const captured = execution?.current()?.resources.settings;
            return captured
              ? getRuntime(captured).telemetry.captureModelContent
              : undefined;
          },
        }),
      (settings, candidateDiagnostics) =>
        createSessionNetwork(
          {
            timeoutMs: settings.network.timeoutMs,
            ...(settings.network.proxy
              ? { proxy: settings.network.proxy }
              : {}),
            ...(settings.network.proxyAuthorization
              ? { proxyAuthorization: settings.network.proxyAuthorization }
              : {}),
            ...(settings.network.caFile
              ? { caFile: settings.network.caFile }
              : {}),
            secrets,
            diagnostics: candidateDiagnostics,
          },
          () => {
            const capture = execution?.current();
            const snapshot =
              capture?.resources.settings ?? configuration?.snapshot();
            return snapshot
              ? {
                  call: capture?.call,
                  diagnostics: capture?.resources.diagnostics ?? diagnostics,
                  timeoutMs: getRuntime(snapshot).network.timeoutMs,
                }
              : undefined;
          },
        ),
      closeFailure,
    );
    resources = ownedResources;
    const capturedExecution = new SessionExecution(() => ownedResources.active);
    execution = capturedExecution;
    const current = () => capturedExecution.current()?.resources;
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
      own<T extends Closable>(resource: T) {
        owners.add(resource);
        return resource;
      },
      bindResource: (select, create) =>
        ownedResources.bind(select, create, current),
    };
    const api = await application.open(env);
    throwIfAborted(options.signal);
    stage = "ready";
    diagnostics.log("info", "runtime.session_opened", {
      instanceId: identity.id,
      mode,
      locale: getRuntime(initial.value).locale,
    });
    const session: Session<Api, S> = {
      api,
      instance,
      configuration: settings,
      close(options) {
        if (closing) return closing;
        const graceMs =
          options?.graceMs ??
          getRuntime(settings.snapshot()).runtime.shutdownGraceMs;
        if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 300000) {
          return Promise.reject(
            failure("input.invalid", {
              issues: [{ path: ["graceMs"], reason: "Expected 0..300000 ms" }],
            }),
          );
        }
        capturedExecution.stop();
        endpointUpdates.delete(session);
        const updates = settings.stop();
        closing = (async () => {
          await capturedExecution.drain(graceMs);
          await updates;
          await ownedResources.close(closeOwned);
          await closeLock();
          if (failures.length)
            throw failure("runtime.close_failed", {
              owners: failures.map((error) => error.owner),
              codes: failures.map((error) => error.code),
            });
        })();
        return closing;
      },
    };
    endpointUpdates.set(session, (endpoints) => lock!.endpoints(endpoints));
    sessionPresentation.set(session, {
      format: (key, params, locale) =>
        localize(locale ?? getRuntime(settings.snapshot()).locale, key, params),
    });
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

type Presentation = {
  format: (
    key: string,
    params?: Readonly<Record<string, string | number | boolean>>,
    locale?: string,
  ) => string;
};
const sessionPresentation = new WeakMap<object, Presentation>();

export function sessionMessage<Api, S>(
  session: Session<Api, S>,
  key: string,
  params?: Readonly<Record<string, string | number | boolean>>,
  locale?: string,
): string {
  return sessionPresentation.get(session)?.format(key, params, locale) ?? key;
}
