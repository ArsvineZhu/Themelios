import { join } from "node:path";
import {
  createContent,
  createImageAdapter,
  imageNeedsOrientation,
  type Materials,
  type Representations,
  type Results,
} from "@themelios/content";
import { contentSchemaSql } from "@themelios/content/schema";
import {
  appError,
  createFlow,
  openCall,
  parseJson,
  throwIfAborted,
  toErrorInfo,
  type CallOptions,
  type InputUse,
  type Json,
  type Material,
} from "@themelios/core";
import {
  createModels,
  createPreparation,
  createPrompts,
  createTasks,
  describeTask,
  type ApplicationPrompts,
  type PreparationStore,
  type RepresentationAdapter,
  type SourceEntry,
  type TaskDefinition,
  type TaskRoute,
} from "@themelios/models";
import {
  createSourceDirectory,
  rangeDescription,
} from "@themelios/models/tasks";
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

export interface ApplicationApi<S = ApplicationSettings> {
  readonly materials: Materials;
  readonly results: Results;
  readonly prompts: ApplicationPrompts;
  readonly tasks: ApplicationTasks;
  readonly representations: Representations;
  readonly configuration: Configuration<S>;
  info(): InstanceInfo & { readonly paths: InstancePaths };
}

type RegisteredTask = TaskDefinition<Json, Json, unknown>;
type Environment = OpenEnvironment<ApplicationSettings>;

export interface ApplicationDefinition {
  id: string;
  formatId: string;
  resourceRoot: string;
  tasks: readonly { readonly id: string }[];
  adapters?: readonly RepresentationAdapter[];
  locales?: Dictionaries;
}

function taskCatalog(
  tasks: ApplicationDefinition["tasks"],
): ReadonlyMap<string, RegisteredTask> {
  const byId = new Map<string, RegisteredTask>();
  for (const task of tasks) {
    if (byId.has(task.id) || !("input" in task) || !("templates" in task)) {
      throw appError("config.invalid", {
        details: {
          issues: [{ path: task.id, messageKey: "tasks.invalid_definition" }],
        },
      });
    }
    byId.set(task.id, task as RegisteredTask);
  }
  return byId;
}

function describeUse(
  use: InputUse,
  index: number,
  materials: Materials,
): SourceEntry {
  const key = `S${index + 1}`;
  const source = use.source;
  const info =
    "ref" in source
      ? materials.inspect(source.ref)
      : "bytes" in source
        ? {
            mediaType: source.mediaType,
            name: source.name,
            extent: { kind: "text" as const, bytes: source.bytes.byteLength },
          }
        : {
            mediaType: "application/json",
            extent: { kind: "unknown" as const },
          };
  const originalExtent =
    "ref" in source
      ? rangeDescription({
          ...("range" in source && source.range !== undefined
            ? { range: source.range }
            : {}),
        })
      : "bytes" in source
        ? "全文"
        : (source.output ?? "result");
  const deliveredExtent = use.delivered.map((item) => {
    if ("ref" in item) {
      return rangeDescription({
        ...(item.range === undefined ? {} : { range: item.range }),
      });
    }
    return "bytes" in item
      ? (item.name ?? item.mediaType)
      : (item.output ?? "result");
  });
  return {
    key,
    mediaType: info.mediaType,
    ...(info.name === undefined ? {} : { name: info.name }),
    originalExtent,
    deliveredExtent,
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
      const content = env.own(
        createContent({
          database,
          cas,
          get maxImportBytes() {
            return env.settings.content.maxImportBytes;
          },
          get maxInlineBytes() {
            return env.settings.content.maxInlineBytes;
          },
        }),
      );
      const store: PreparationStore = {
        inspect: (ref) => content.materials.inspect(ref),
        read: (ref, call) => materials.read(ref, call),
        text: (selection, call) => materials.text(selection, call),
        readResult: (ref, call) => results.read(ref, call),
        findRepresentation: (source, purpose, recipe) =>
          content.representations.find(source, purpose, recipe),
      };
      const resources = await env.bindResource(
        (settings) =>
          parseJson({
            locale: settings.locale,
            connections: settings.models.connections,
            bindings: settings.models.bindings,
            tasks: settings.models.tasks,
            preparation: settings.preparation,
            content: settings.content,
            defaults: {
              timeoutMs: settings.models.timeoutMs,
              maxAttempts: settings.models.maxAttempts,
              concurrency: settings.models.concurrency,
            },
          }),
        async (context) => {
          const settings = context.settings;
          const models = createModels({
            connections: settings.models.connections,
            bindings: settings.models.bindings,
            fetch: context.network.fetch,
            diagnostics: context.diagnostics,
            resolveCredential: (ref) => context.secrets.resolve(ref),
            defaults: {
              timeoutMs: settings.models.timeoutMs,
              maxAttempts: settings.models.maxAttempts,
              concurrency: settings.models.concurrency,
            },
          });
          const prompts = createPrompts({
            resourceRoot: definition.resourceRoot,
            overrideRoot: join(env.paths.config, "prompts"),
            locale: settings.locale,
          });
          for (const task of catalog.values()) await prompts.read(task);
          const imageAdapter = createImageAdapter({
            maxPixels: settings.preparation.image.maxPixels,
            maxBytes: settings.preparation.maxMaterialBytes,
          }) as unknown as RepresentationAdapter;
          const preparation = createPreparation({
            store,
            models,
            prompts,
            modelIdentity(name) {
              const binding = models.describe(name);
              const connection =
                settings.models.connections[binding.connection];
              return parseJson({
                binding,
                protocol: connection?.protocol ?? null,
                baseURL: connection?.baseURL ?? null,
              });
            },
            adapters: [imageAdapter, ...(definition.adapters ?? [])],
            imageNeedsOrientation: (input, call) =>
              imageNeedsOrientation(
                input as unknown as Parameters<typeof imageNeedsOrientation>[0],
                settings.preparation.image.maxPixels,
                call,
                settings.preparation.maxMaterialBytes,
              ),
            maxMaterialBytes: settings.preparation.maxMaterialBytes,
            maxInlineBytes: settings.content.maxInlineBytes,
          });
          const tasks = createTasks({
            models,
            prompts,
            preparation,
            routes: settings.models.tasks as Readonly<
              Record<string, TaskRoute>
            >,
            concurrency: settings.models.concurrency,
            timeoutMs: settings.models.timeoutMs,
          });
          return {
            models,
            prompts,
            tasks,
            async close() {
              await models.close();
            },
          };
        },
      );

      const assertWritable = (operation: string) => {
        if (env.mode === "read-only") {
          throw appError("runtime.read_only", { details: { operation } });
        }
      };
      const queue = new PQueue({
        concurrency: env.settings.runtime.ioConcurrency,
      });
      const queueIo = <T>(work: () => Promise<T>) => {
        queue.concurrency = env.settings.runtime.ioConcurrency;
        return queue.add(work);
      };
      const runIo = <T>(
        operation: string,
        work: (options: CallOptions) => Promise<T>,
        options?: CallOptions,
      ) =>
        env.execution.run(
          operation,
          (signal) => queueIo(() => work({ signal })),
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
            queueIo(async () => {
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
        read: (task) => resources.get().prompts.read(findTask(task)),
        describe: (task) => resources.get().prompts.describe(findTask(task)),
        diff: (task) => resources.get().prompts.diff(findTask(task)),
        setOverride(task, change) {
          assertWritable("prompts.setOverride");
          return env.execution.run("prompts.setOverride", () =>
            resources.get().prompts.setOverride(findTask(task), change),
          );
        },
        reset(task, part) {
          assertWritable("prompts.reset");
          return env.execution.run("prompts.reset", () =>
            resources.get().prompts.reset(findTask(task), part),
          );
        },
      };

      const tasks = bindTasks(
        env,
        findTask,
        catalog,
        resources.get,
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

function bindTasks(
  env: Environment,
  findTask: (name: string) => RegisteredTask,
  catalog: ReadonlyMap<string, RegisteredTask>,
  getResources: () => {
    prompts: ReturnType<typeof createPrompts>;
    tasks: ReturnType<typeof createTasks>;
  },
  content: ReturnType<typeof createContent>,
  materials: Materials,
  assertWritable: (name: string) => void,
  localize: (
    locale: string,
    key: string,
    params?: Record<string, string | number | boolean>,
  ) => string,
): ApplicationTasks {
  const timeoutOpts = (opts?: CallOptions): CallOptions => ({
    timeoutMs: env.configuration.snapshot().models.timeoutMs,
    ...opts,
  });

  async function runSingle(
    input: RunTaskInput,
    opts?: CallOptions,
  ): Promise<TaskResult> {
    parseJson(input.variables);
    const captured = structuredClone(input);
    return env.execution.run(
      "tasks.run",
      async (signal) => {
        if (captured.persist) assertWritable("tasks.run.save");
        const done = await getResources().tasks.run(
          findTask(captured.task),
          captured,
          {
            signal,
            ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
          },
        );
        return captured.persist ? content.results.save(done, { signal }) : done;
      },
      timeoutOpts(opts),
    );
  }

  return {
    run: runSingle,
    stream(input, opts) {
      parseJson(input.variables);
      const captured = structuredClone(input);
      return env.execution.flow(
        "tasks.stream",
        (signal) =>
          createFlow(
            "tasks.stream",
            async function* (call) {
              if (captured.persist) assertWritable("tasks.stream.save");
              for await (const event of getResources().tasks.stream(
                findTask(captured.task),
                captured,
                { signal: call.signal },
              )) {
                if (event.type === "result") {
                  return captured.persist
                    ? content.results.save(event.value, { signal: call.signal })
                    : event.value;
                }
                yield event;
              }
              throw appError("model.incomplete", {
                details: { stage: "stream" },
              });
            },
            { signal },
          ),
        timeoutOpts(opts),
      );
    },
    runMany(inputs, opts): Promise<readonly BatchItemResult[]> {
      return env.execution.run(
        "tasks.runMany",
        async (signal) => {
          const call = openCall("tasks.runMany", { signal });
          const queue = new PQueue({
            concurrency: env.configuration.snapshot().models.concurrency,
          });
          try {
            const captured = structuredClone(inputs);
            return await Promise.all(
              captured.map((input) =>
                queue.add(async (): Promise<BatchItemResult> => {
                  try {
                    call.throwIfAborted("queue");
                    return {
                      ok: true,
                      result: await runSingle(input, { signal: call.signal }),
                    };
                  } catch (error) {
                    const locale = env.configuration.snapshot().locale;
                    return {
                      ok: false,
                      error: toErrorInfo(error, (key, params) =>
                        localize(locale, key, params),
                      ),
                    };
                  }
                }),
              ),
            );
          } finally {
            call.close();
          }
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
          getResources().tasks.preview(findTask(captured.task), captured, {
            signal,
          }),
        timeoutOpts(opts),
      );
    },
    describe: (name) =>
      describeTask(findTask(name), getResources().prompts, (key) =>
        localize(env.configuration.snapshot().locale, key),
      ),
    list: () =>
      [...catalog.values()].map((task) => {
        const locale = env.configuration.snapshot().locale;
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
    present(taskName, result) {
      const task = findTask(taskName);
      if (!task.present) return JSON.stringify(result, null, 2);
      const directory = createSourceDirectory(
        (result.inputs as InputUse<Material>[]).map((use, index) =>
          describeUse(use, index, materials),
        ),
      );
      return task.present(result.value, directory);
    },
  };
}
