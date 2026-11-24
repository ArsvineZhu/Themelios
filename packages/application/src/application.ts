import { join } from "node:path";
import {
  createContent,
  createImageAdapter,
  createWaveAdapter,
  type Materials,
  type Representations,
  type Results,
} from "@themelios/content";
import { contentSchemaSql } from "@themelios/content/schema";
import {
  appError,
  mapFlowResult,
  parseJson,
  throwIfAborted,
  toErrorInfo,
  type CallOptions,
  type InputUse,
  type Json,
  type RepresentationAdapter,
} from "@themelios/core";
import {
  createModels,
  createPreparation,
  createPrompts,
  createTasks,
  describeTask,
  type ApplicationPrompts,
  type PreparationStore,
  type SourceEntry,
  type TaskDefinition,
} from "@themelios/models";
import { createSourceDirectory } from "@themelios/models/tasks";
import type {
  ApplicationModule,
  InstanceInfo,
  InstancePaths,
  OpenEnvironment,
} from "@themelios/runtime";
import type { Dictionaries } from "@themelios/runtime/locales";
import type { Configuration } from "@themelios/runtime/settings";
import { Cas, Database } from "@themelios/storage";
import PQueue from "p-queue";
import type { ZodType } from "zod";
import { applicationSettings, type ApplicationSettings } from "./settings.js";
import type {
  ApplicationTasks,
  BatchItemResult,
  RunTaskInput,
  TaskResult,
} from "./task-operations.js";
import type { BinaryReadResult } from "@themelios/runtime/operations";
import type { WireInputUse } from "./wire.js";

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
type Environment = OpenEnvironment<ApplicationSettings>;

function modelConfiguration({ models }: Readonly<ApplicationSettings>) {
  const { bindings, connections, timeoutMs, maxAttempts, concurrency } = models;
  return {
    bindings,
    connections,
    defaults: { timeoutMs, maxAttempts, concurrency },
  };
}

export interface ApplicationDefinition {
  id: string;
  formatId: string;
  resourceRoot: string;
  tasks: readonly TaskDefinition<Json, Json, unknown>[];
  adapters?: readonly RepresentationAdapter[];
  createAdapters?(
    settings: ApplicationSettings["preparation"],
  ): readonly RepresentationAdapter[];
  locales?: Dictionaries;
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

function describeUse(
  use: InputUse | WireInputUse,
  index: number,
  materials: Materials,
): SourceEntry {
  const key = `S${index + 1}`;
  const source = use.source;
  const info =
    "ref" in source
      ? materials.inspect(materials.resolve(source.ref))
      : "bytes" in source
        ? {
            mediaType: source.mediaType,
            name: source.name,
            extent: { kind: "text" as const, bytes: source.bytes.byteLength },
          }
        : "inline" in source
          ? {
              mediaType: source.inline.mediaType,
              name: source.inline.name,
              extent: { kind: "unknown" as const },
            }
          : {
              mediaType: "application/json",
              extent: { kind: "unknown" as const },
            };
  return {
    key,
    mediaType: info.mediaType,
    ...("name" in info && info.name !== undefined ? { name: info.name } : {}),
    ...(use.coverage ?? {
      originalExtent: info.extent,
      requestedRange: "ref" in source ? (source.range ?? null) : null,
      delivered: [],
    }),
    role: use.role,
  };
}

export function createApplicationModule(
  definition: ApplicationDefinition,
): ApplicationModule<ApplicationApi<ApplicationSettings>, ApplicationSettings> {
  const catalog = taskCatalog(definition.tasks);
  const { id, formatId, locales } = definition;
  return {
    id,
    formatId,
    settings: applicationSettings,
    ...(locales === undefined ? {} : { locales }),
    async provision({ paths, settings }) {
      const database = Database.init({
        path: join(paths.state, "main.sqlite"),
        formatId,
        synchronous: settings.storage.synchronous,
        schemaSql: contentSchemaSql,
      });
      database.close();
      const cas = await Cas.open(paths.objects);
      await cas.close();
    },
    async open(env) {
      const database = env.own(
        Database.open({
          path: join(env.paths.state, "main.sqlite"),
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
        get maxImportBytes() {
          return env.settings.content.maxImportBytes;
        },
        get maxInlineBytes() {
          return env.settings.content.maxInlineBytes;
        },
      });
      const store: PreparationStore = {
        inspect: (ref) => content.materials.inspect(ref),
        read: (ref, call) => materials.read(ref, call),
        text: (selection, call) => materials.text(selection, call),
        readResult: (ref, call) => results.read(ref, call),
        findRepresentation: (source, purpose, recipe) =>
          content.representations.find(source, purpose, recipe),
      };
      const modelResource = await env.bindResource(
        (settings) => parseJson(modelConfiguration(settings)),
        async (context) =>
          createModels({
            ...modelConfiguration(context.settings),
            fetch: context.network.fetch,
            diagnostics: context.diagnostics,
            resolveCredential: (ref) => context.secrets.resolve(ref),
          }),
      );
      const promptStore = createPrompts({
        resourceRoot: definition.resourceRoot,
        overrideRoot: join(env.paths.config, "prompts"),
      });
      const taskExecutors = new WeakMap<
        Readonly<ApplicationSettings>,
        ReturnType<typeof createTasks>
      >();
      function taskExecutor() {
        const settings = env.settings;
        const existing = taskExecutors.get(settings);
        if (existing) return existing;
        const models = modelResource.get();
        const imageAdapter = createImageAdapter({
          maxPixels: settings.preparation.image.maxPixels,
          maxBytes: settings.preparation.maxMaterialBytes,
        });
        const preparation = createPreparation({
          store,
          models,
          prompts: promptStore,
          ...(settings.models.tasks["media.describe"]?.variables === undefined
            ? {}
            : {
                mediaDescriptionDefaults:
                  settings.models.tasks["media.describe"].variables,
              }),
          adapters: [
            imageAdapter,
            createWaveAdapter({
              maxBytes: settings.preparation.maxMaterialBytes,
            }),
            ...(definition.adapters ?? []),
            ...(definition.createAdapters?.(settings.preparation) ?? []),
          ],
          maxMaterialBytes: settings.preparation.maxMaterialBytes,
          maxInlineBytes: settings.content.maxInlineBytes,
        });
        const tasks = createTasks({
          models,
          prompts: promptStore,
          preparation,
          diagnostics: env.diagnostics,
          routes: settings.models.tasks,
          concurrency: settings.models.concurrency,
          timeoutMs: settings.models.timeoutMs,
        });
        taskExecutors.set(settings, tasks);
        return tasks;
      }

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
      ): Promise<
        BinaryReadResult & { info: ReturnType<Materials["inspect"]> }
      > {
        const opened =
          Promise.withResolvers<Awaited<ReturnType<Materials["read"]>>>();
        const operation = env.execution.start(
          "materials.read",
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
            "materials.accept",
            (call) => {
              assertWritable("materials.accept");
              return content.materials.accept(input, call);
            },
            opts,
          ),
        prepare: (input, opts) =>
          runIo(
            "materials.prepare",
            (call) => {
              assertWritable("materials.prepare");
              return content.materials.prepare(input, call);
            },
            opts,
          ),
        inspect: (ref) => content.materials.inspect(ref),
        resolve: (ref) => content.materials.resolve(ref),
        agentRef: (ref) => content.materials.agentRef(ref),
        read: read as Materials["read"],
        text: (selection, opts) =>
          runIo(
            "materials.text",
            (call) => content.materials.text(selection, call),
            opts,
          ),
        structure: (ref, opts) =>
          runIo(
            "materials.structure",
            (call) => content.materials.structure(ref, call),
            opts,
          ),
        sources: (ref, opts) => content.materials.sources(ref, opts),
        list: (opts) => content.materials.list(opts),
        retain(ref) {
          assertWritable("materials.retain");
          content.materials.retain(ref);
        },
        release(ref) {
          assertWritable("materials.release");
          content.materials.release(ref);
        },
        export: (ref, destination, opts) =>
          runIo(
            "materials.export",
            (call) => content.materials.export(ref, destination, call),
            opts,
          ),
      };

      const results: Results = {
        save: (completed, opts) =>
          runIo(
            "results.save",
            (call) => {
              assertWritable("results.save");
              return content.results.save(completed, call);
            },
            opts,
          ),
        prepare: (completed, opts) =>
          runIo(
            "results.prepare",
            (call) => {
              assertWritable("results.prepare");
              return content.results.prepare(completed, call);
            },
            opts,
          ),
        read: (<T extends Json>(
          ref: Parameters<Results["read"]>[0],
          schema?: ZodType<T> | CallOptions,
          opts?: CallOptions,
        ) => {
          const isSchema = schema && "safeParse" in schema;
          return runIo(
            "results.read",
            (call) =>
              isSchema
                ? content.results.read(ref, schema, call)
                : content.results.read(ref, call),
            isSchema ? opts : schema,
          );
        }) as Results["read"],
      };

      const findTask = (name: string) => {
        const task = catalog.get(name);
        if (!task)
          throw appError("tasks.not_found", { details: { task: name } });
        return task;
      };
      const prompts: ApplicationPrompts = {
        read: (task) =>
          env.execution.run("prompts.read", () =>
            promptStore.read(findTask(task)),
          ),
        describe: (task) =>
          env.execution.run("prompts.describe", () =>
            promptStore.describe(findTask(task)),
          ),
        diff: (task) =>
          env.execution.run("prompts.diff", () =>
            promptStore.diff(findTask(task)),
          ),
        setOverride(task, change) {
          assertWritable("prompts.setOverride");
          return env.execution.run("prompts.setOverride", () =>
            promptStore.setOverride(findTask(task), change),
          );
        },
        reset(task, part) {
          assertWritable("prompts.reset");
          return env.execution.run("prompts.reset", () =>
            promptStore.reset(findTask(task), part),
          );
        },
      };

      taskExecutor();
      const tasks = bindTasks(
        env,
        findTask,
        catalog,
        promptStore,
        taskExecutor,
        content,
        materials,
        assertWritable,
        localize,
      );
      const representations: Representations = {
        find: content.representations.find,
        set(representation) {
          assertWritable("representations.set");
          content.representations.set(representation);
        },
        remove(...args) {
          assertWritable("representations.remove");
          content.representations.remove(...args);
        },
      };

      return {
        materials,
        results,
        prompts,
        tasks,
        representations,
        configuration: env.configuration,
        info: () => ({ ...env.instance, paths: env.paths }),
      };
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

function bindTasks(
  env: Environment,
  findTask: (name: string) => RegisteredTask,
  catalog: ReadonlyMap<string, RegisteredTask>,
  prompts: ReturnType<typeof createPrompts>,
  getTasks: () => ReturnType<typeof createTasks>,
  content: ReturnType<typeof createContent>,
  materials: Materials,
  assertWritable: (name: string) => void,
  localize: (
    locale: string,
    key: string,
    params?: Record<string, string | number | boolean>,
  ) => string,
): ApplicationTasks {
  const timeoutOpts = (opts?: CallOptions, task?: string): CallOptions => {
    const { models } = env.settings;
    const route =
      task && Object.hasOwn(models.tasks, task)
        ? models.tasks[task]
        : undefined;
    return { timeoutMs: route?.timeoutMs ?? models.timeoutMs, ...opts };
  };

  async function runSingle(
    captured: RunTaskInput,
    opts?: CallOptions,
  ): Promise<TaskResult> {
    parseJson(captured.variables);
    return env.execution.run(
      "tasks.run",
      async (signal) => {
        if (captured.persist) assertWritable("tasks.run.save");
        const done = await getTasks().run(findTask(captured.task), captured, {
          signal,
          ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
        });
        return captured.persist ? content.results.save(done, { signal }) : done;
      },
      timeoutOpts(opts, captured.task),
    );
  }

  return {
    run: (input, opts) => runSingle(structuredClone(input), opts),
    stream(input, opts) {
      parseJson(input.variables);
      const captured = structuredClone(input);
      return env.execution.flow<TaskResult>(
        "tasks.stream",
        (signal) => {
          if (captured.persist) assertWritable("tasks.stream.save");
          const flow = getTasks().stream(findTask(captured.task), captured, {
            signal,
          });
          return captured.persist
            ? mapFlowResult(flow, (result) =>
                content.results.save(result, { signal }),
              )
            : flow;
        },
        timeoutOpts(opts, captured.task),
      );
    },
    runMany(inputs, opts): Promise<readonly BatchItemResult[]> {
      const captured = structuredClone(inputs);
      return env.execution.run(
        "tasks.runMany",
        async (signal) => {
          const queue = new PQueue({
            concurrency: env.configuration.snapshot().models.concurrency,
          });
          const locale = env.settings.locale;
          const outcomes = await Promise.all(
            captured.map(async (input): Promise<BatchItemResult> => {
              try {
                const result = await queueWork(queue, signal, () =>
                  runSingle(input, { signal }),
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
      parseJson(input.variables);
      const captured = structuredClone(input);
      return env.execution.run(
        "tasks.preview",
        (signal) =>
          getTasks().preview(findTask(captured.task), captured, {
            signal,
          }),
        timeoutOpts(opts, captured.task),
      );
    },
    describe: (name, locale) =>
      env.execution.run("tasks.describe", () =>
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
      const task = findTask(taskName);
      if (!task.present) return JSON.stringify(result, null, 2);
      const directory = createSourceDirectory(
        result.inputs.map((use, index) => describeUse(use, index, materials)),
      );
      return task.present(result.value, directory, locale);
    },
  };
}
