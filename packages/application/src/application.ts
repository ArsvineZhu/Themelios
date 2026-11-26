import { join } from "node:path";
import {
  createContent,
  createImageAdapter,
  createWaveAdapter,
  materialOperationIds,
  resultOperationIds,
  type Materials,
  type Representations,
  type Results,
} from "@themelios/content";
import { contentSchemaSql } from "@themelios/content/schema";
import {
  appError,
  instanceConfigurationFiles,
  mapFlowResult,
  parseJson,
  throwIfAborted,
  toErrorInfo,
  type CallOptions,
  type Completed,
  type Flow,
  type Json,
  type RepresentationAdapter,
} from "@themelios/core";
import {
  createModels,
  createPrompts,
  describeTask,
  presentTask,
  type ApplicationPrompts,
  type Models,
  type TaskDefinition,
} from "@themelios/models";
import type {
  ApplicationModule,
  InstanceInfo,
  InstancePaths,
  OpenEnvironment,
} from "@themelios/runtime";
import type { Dictionaries } from "@themelios/runtime/locales";
import type {
  Configuration,
  SettingsDefinition,
} from "@themelios/runtime/settings";
import { Cas, Database, databaseFileName } from "@themelios/storage";
import PQueue from "p-queue";
import {
  preparationSettingsSchema,
  type ApplicationSettings,
} from "./settings.js";
import {
  taskOperationIds,
  promptOperationIds,
  type ApplicationTasks,
  type BatchItemResult,
  type RunTaskInput,
  type TaskResult,
} from "./task-operations.js";

export interface ApplicationApi<S = ApplicationSettings> {
  readonly materials: Materials;
  readonly results: Results;
  readonly prompts: ApplicationPrompts;
  readonly tasks: ApplicationTasks;
  readonly representations: Representations;
  readonly configuration: Configuration<S>;
  info(): InstanceInfo & { readonly paths: InstancePaths };
}

type RegisteredTask = ApplicationDefinition["tasks"][number];
type Environment<S extends ApplicationSettings> = OpenEnvironment<S>;

export interface ApplicationDefinition<
  S extends ApplicationSettings = ApplicationSettings,
> {
  id: string;
  formatId: string;
  settings: SettingsDefinition<S>;
  resourceRoot: string;
  tasks: readonly TaskDefinition<Json, Json, unknown>[];
  schemaSql?: string;
  adapters?(
    settings: ApplicationSettings["preparation"],
  ): readonly RepresentationAdapter[];
  locales?: Dictionaries;
}

/** Builds the standard inventory and the application's additional media recipes. */
export function applicationAdapters(
  settings: ApplicationSettings["preparation"] = preparationSettingsSchema.parse(
    {},
  ),
  additional?: ApplicationDefinition["adapters"],
): readonly RepresentationAdapter[] {
  const { maxMaterialBytes, image } = settings;
  return [
    createImageAdapter({
      maxPixels: image.maxPixels,
      maxBytes: maxMaterialBytes,
    }),
    createWaveAdapter({ maxBytes: maxMaterialBytes }),
    ...(additional?.(settings) ?? []),
  ];
}

export interface ApplicationContext<S extends ApplicationSettings> {
  readonly env: OpenEnvironment<S>;
  readonly database: Database;
  readonly api: ApplicationApi<S>;
  /** Use the model client captured by the current Runtime call. */
  models(): Models;
}

function taskCatalog(
  tasks: ApplicationDefinition["tasks"],
): ReadonlyMap<string, RegisteredTask> {
  const byId = new Map<string, RegisteredTask>();
  for (const task of tasks) {
    if (byId.has(task.id)) {
      throw appError("config.invalid", {
        details: {
          issues: [{ path: task.id, messageKey: "tasks.invalid_definition" }],
        },
      });
    }
    byId.set(task.id, task);
  }
  return byId;
}

export function createApplicationModule<S extends ApplicationSettings>(
  definition: ApplicationDefinition<S>,
): ApplicationModule<ApplicationApi<S>, S>;
export function createApplicationModule<S extends ApplicationSettings, Api>(
  definition: ApplicationDefinition<S>,
  open: (context: ApplicationContext<S>) => Api | Promise<Api>,
): ApplicationModule<Api, S>;
/** The module owns the instance resources shared by standard and composed applications. */
export function createApplicationModule<S extends ApplicationSettings, Api>(
  definition: ApplicationDefinition<S>,
  open?: (context: ApplicationContext<S>) => Api | Promise<Api>,
): ApplicationModule<ApplicationApi<S> | Api, S> {
  const catalog = taskCatalog(definition.tasks);
  const { id, formatId, locales } = definition;
  return {
    id,
    formatId,
    settings: definition.settings,
    ...(locales === undefined ? {} : { locales }),
    async provision({ paths, settings, clock }) {
      const database = Database.init({
        path: join(paths.state, databaseFileName),
        formatId,
        synchronous: settings.storage.synchronous,
        schemaSql: [contentSchemaSql, definition.schemaSql]
          .filter(Boolean)
          .join("\n"),
        now: clock.now,
      });
      database.close();
      const cas = await Cas.open(paths.objects);
      await cas.close();
    },
    async open(env) {
      const database = env.own(
        Database.open({
          path: join(env.paths.state, databaseFileName),
          formatId,
          synchronous: env.settings.storage.synchronous,
          readonly: env.mode === "read-only",
          now: env.clock.now,
        }),
      );
      const cas = env.own(await Cas.open(env.paths.objects));
      const localize = (
        locale: string,
        key: string,
        params?: Record<string, string | number | boolean>,
      ) => env.localize(key, params, locale);
      const content = createContent({
        database,
        cas,
        get adapters() {
          return modelResource.get().adapters;
        },
        get maxImportBytes() {
          return env.settings.content.maxImportBytes;
        },
        get maxInlineBytes() {
          return env.settings.content.maxInlineBytes;
        },
      });
      const assertWritable = (operation: string) => {
        if (env.mode === "read-only") {
          throw appError("runtime.read_only", { details: { operation } });
        }
      };
      const queue = new PQueue({
        concurrency: env.settings.runtime.ioConcurrency,
      });
      const queueIo = <T>(signal: AbortSignal, work: () => Promise<T>) => {
        queue.concurrency = env.settings.runtime.ioConcurrency;
        return queueWork(queue, signal, work);
      };
      const runIo = <T>(
        operation: string,
        work: (options: CallOptions) => Promise<T>,
        options?: CallOptions,
      ) =>
        env.execution.run(
          operation,
          (signal) => queueIo(signal, () => work({ signal })),
          options,
        );
      function read(
        ref: Parameters<Materials["read"]>[0],
        options?: CallOptions,
      ): ReturnType<Materials["read"]> {
        const opened =
          Promise.withResolvers<Awaited<ReturnType<Materials["read"]>>>();
        const operation = env.execution.start(
          materialOperationIds.read,
          (signal) =>
            queueIo(signal, async () => {
              throwIfAborted(signal);
              const material = await content.materials.read(ref, { signal });
              const bridge = new TransformStream<Uint8Array, Uint8Array>();
              opened.resolve({ info: material.info, body: bridge.readable });
              await material.body.pipeTo(bridge.writable, { signal });
            }),
          options,
        );
        void operation.result.catch(opened.reject);
        return opened.promise;
      }

      const materials: Materials = {
        accept: (input, opts) =>
          runIo(
            materialOperationIds.accept,
            (call) => content.materials.accept(input, { ...opts, ...call }),
            opts,
          ),
        adopt: (input, attach, opts) =>
          runIo(
            materialOperationIds.adopt,
            (call) =>
              content.materials.adopt(input, attach, { ...opts, ...call }),
            opts,
          ),
        adoptAnalyzed: (input, adoption, opts) =>
          runIo(
            materialOperationIds.adoptAnalyzed,
            (call) =>
              content.materials.adoptAnalyzed(input, adoption, {
                ...opts,
                ...call,
              }),
            opts,
          ),
        inspect: (ref) => content.materials.inspect(ref),
        resolve: (ref) => content.materials.resolve(ref),
        agentRef: (ref) => content.materials.agentRef(ref),
        read,
        text: (selection, opts) =>
          runIo(
            materialOperationIds.text,
            (call) => content.materials.text(selection, call),
            opts,
          ),
        structure: (ref, opts) =>
          runIo(
            materialOperationIds.structure,
            (call) => content.materials.structure(ref, call),
            opts,
          ),
        sources: (ref, opts) => content.materials.sources(ref, opts),
        listRetained: (opts) => content.materials.listRetained(opts),
        retain: content.materials.retain,
        release: content.materials.release,
        export: (ref, destination, opts) =>
          runIo(
            materialOperationIds.export,
            (call) => content.materials.export(ref, destination, call),
            opts,
          ),
      };

      const results: Results = {
        save: (completed, opts) =>
          runIo(
            resultOperationIds.save,
            (call) => content.results.save(completed, { ...opts, ...call }),
            opts,
          ),
        adopt: (completed, attach, opts) =>
          runIo(
            resultOperationIds.adopt,
            (call) =>
              content.results.adopt(completed, attach, { ...opts, ...call }),
            opts,
          ),
        read: (ref, opts) =>
          runIo(
            resultOperationIds.read,
            (call) => content.results.read(ref, { ...opts, ...call }),
            opts,
          ),
      };

      const store = {
        materials,
        results,
        representations: content.representations,
      };
      const promptStore = createPrompts({
        resourceRoot: definition.resourceRoot,
        overrideRoot: join(
          env.paths.config,
          instanceConfigurationFiles.prompts,
        ),
      });
      const modelResource = await env.bindResource(
        (settings) =>
          parseJson({
            models: settings.models,
            preparation: settings.preparation,
            maxInlineBytes: settings.content.maxInlineBytes,
          }),
        async ({ settings, diagnostics, network, secrets }) => {
          const adapters = applicationAdapters(
            settings.preparation,
            definition.adapters,
          );
          const client = createModels(settings.models, {
            fetch: network.fetch,
            diagnostics,
            resolveCredential: secrets.resolve,
            prompts: promptStore,
            adapters,
            preparation: {
              store,
              maxMaterialBytes: settings.preparation.maxMaterialBytes,
              maxInlineBytes: settings.content.maxInlineBytes,
            },
          });
          return { client, adapters, close: () => client.close() };
        },
      );

      const findTask = (name: string) => {
        const task = catalog.get(name);
        if (!task)
          throw appError("tasks.not_found", { details: { task: name } });
        return task;
      };
      const prompts: ApplicationPrompts = {
        read: (task) =>
          env.execution.run(promptOperationIds.read, () =>
            promptStore.read(findTask(task)),
          ),
        describe: (task) =>
          env.execution.run(promptOperationIds.describe, () =>
            promptStore.describe(findTask(task)),
          ),
        diff: (task) =>
          env.execution.run(promptOperationIds.diff, () =>
            promptStore.diff(findTask(task)),
          ),
        setOverride(task, change) {
          assertWritable(promptOperationIds.setOverride);
          return env.execution.run(promptOperationIds.setOverride, () =>
            promptStore.setOverride(findTask(task), change),
          );
        },
        reset(task, part) {
          assertWritable(promptOperationIds.reset);
          return env.execution.run(promptOperationIds.reset, () =>
            promptStore.reset(findTask(task), part),
          );
        },
      };

      const tasks = bindTasks(
        env,
        findTask,
        catalog,
        promptStore,
        () => modelResource.get().client,
        results,
        (operation) => database.requireWritable(operation),
        localize,
      );
      const api: ApplicationApi<S> = {
        ...store,
        prompts,
        tasks,
        configuration: env.configuration,
        info: () => ({ ...env.instance, paths: env.paths }),
      };
      return open
        ? open({ env, database, api, models: () => modelResource.get().client })
        : api;
    },
  };
}

/** Cancellation removes queued work. Active work holds its slot until cleanup finishes. */
async function queueWork<T>(
  queue: PQueue,
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const admission = new AbortController();
  const abort = () => admission.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await queue.add(
      () => {
        signal.removeEventListener("abort", abort);
        return work();
      },
      { signal: admission.signal },
    );
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function bindTasks<S extends ApplicationSettings>(
  env: Environment<S>,
  findTask: (name: string) => RegisteredTask,
  catalog: ReadonlyMap<string, RegisteredTask>,
  prompts: ReturnType<typeof createPrompts>,
  models: () => Models,
  results: Results,
  assertWritable: (name: string) => void,
  localize: (
    locale: string,
    key: string,
    params?: Record<string, string | number | boolean>,
  ) => string,
): ApplicationTasks {
  const timeoutOpts = (opts?: CallOptions, task?: string): CallOptions => ({
    timeoutMs: models().tasks.timeoutMs(task),
    ...opts,
  });

  type TaskCompletion<R extends TaskResult> = {
    beforeRun?(): void;
    finish(completed: Completed, signal: AbortSignal): Promise<R>;
  };
  const returnCompletion = {
    finish: async (completed: Completed) => completed,
  };
  const saveCompletion = {
    beforeRun: () => assertWritable(resultOperationIds.save),
    finish: (completed: Completed, signal: AbortSignal) =>
      results.save(completed, { signal }),
  };

  function runSingle<R extends TaskResult>(
    captured: RunTaskInput,
    opts: CallOptions | undefined,
    completion: TaskCompletion<R>,
  ): Promise<R> {
    return env.execution.run(
      taskOperationIds.run,
      async (signal) => {
        completion.beforeRun?.();
        const done = await models().tasks.run(
          findTask(captured.task),
          captured,
          {
            signal,
            ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
          },
        );
        return completion.finish(done, signal);
      },
      timeoutOpts(opts, captured.task),
    );
  }

  function runStream<R extends TaskResult>(
    input: RunTaskInput,
    opts: CallOptions | undefined,
    completion: TaskCompletion<R>,
  ): Flow<R> {
    const captured = structuredClone(input);
    return env.execution.flow(
      taskOperationIds.stream,
      (signal) => {
        completion.beforeRun?.();
        return mapFlowResult(
          models().tasks.stream(findTask(captured.task), captured, { signal }),
          (done) => completion.finish(done, signal),
        );
      },
      timeoutOpts(opts, captured.task),
    );
  }

  return {
    run: (input, opts) =>
      runSingle(structuredClone(input), opts, returnCompletion),
    runAndSave: (input, opts) =>
      runSingle(structuredClone(input), opts, saveCompletion),
    stream: (input, opts) => runStream(input, opts, returnCompletion),
    streamAndSave: (input, opts) => runStream(input, opts, saveCompletion),
    runMany(inputs, opts): Promise<readonly BatchItemResult[]> {
      const captured = structuredClone(inputs);
      return env.execution.run(
        taskOperationIds.runMany,
        async (signal) => {
          const queue = new PQueue({
            concurrency: models().tasks.concurrency,
          });
          const locale = env.settings.locale;
          const outcomes = await Promise.all(
            captured.map(async (input): Promise<BatchItemResult> => {
              try {
                const { persist, ...request } = input;
                const result = await queueWork<TaskResult>(queue, signal, () =>
                  persist
                    ? runSingle(request, { signal }, saveCompletion)
                    : runSingle(request, { signal }, returnCompletion),
                );
                return { ok: true, result };
              } catch (error) {
                return {
                  ok: false,
                  error: toErrorInfo(error, (key, params) =>
                    localize(locale, key, params),
                  ),
                };
              }
            }),
          );
          const succeeded = outcomes.filter((item) => item.ok).length;
          const failed = outcomes.length - succeeded;
          env.diagnostics.log("info", "tasks.batch.completed", {
            outcome:
              failed === 0
                ? "complete"
                : succeeded === 0
                  ? "all-failed"
                  : "partial",
            succeeded,
            failed,
          });
          return outcomes;
        },
        timeoutOpts(opts),
      );
    },
    preview(input, opts) {
      const captured = structuredClone(input);
      return env.execution.run(
        taskOperationIds.preview,
        (signal) =>
          models().tasks.preview(findTask(captured.task), captured, {
            signal,
          }),
        timeoutOpts(opts, captured.task),
      );
    },
    describe: (name, locale) =>
      env.execution.run(taskOperationIds.describe, () =>
        describeTask(findTask(name), prompts, (key) =>
          localize(locale ?? env.configuration.snapshot().locale, key),
        ),
      ),
    list: (locale = env.configuration.snapshot().locale) =>
      [...catalog.values()].map((task) => {
        const resolvedTitle =
          task.titleKey !== task.id
            ? localize(locale, task.titleKey)
            : task.title;
        const resolvedPurpose =
          task.purposeKey !== task.id
            ? localize(locale, task.purposeKey)
            : task.purpose;
        return {
          id: task.id,
          title: resolvedTitle === task.titleKey ? task.title : resolvedTitle,
          purpose:
            resolvedPurpose === task.purposeKey
              ? task.purpose
              : resolvedPurpose,
        };
      }),
    present(taskName, result, locale = env.configuration.snapshot().locale) {
      return presentTask(findTask(taskName), result, locale);
    },
  };
}
