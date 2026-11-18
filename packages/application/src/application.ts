import { join } from "node:path";
import {
  createContent,
  type MaterialRead,
  type Materials,
  type Results,
  type ScheduleContentWrite,
} from "@themelios/content";
import { contentSchemaSql } from "@themelios/content/schema";
import {
  appError,
  type ArtifactRef,
  type CallOptions,
  createFlow,
  type Json,
  openCall,
  parseJson,
  throwIfAborted,
  toErrorInfo,
} from "@themelios/core";
import { createModels } from "@themelios/models";
import {
  createPrompts,
  type ApplicationPrompts,
} from "@themelios/models/prompts";
import type { TaskDefinition } from "@themelios/models/tasks";
import type { ApplicationModule, OpenEnvironment } from "@themelios/runtime";
import { createLocalizer, type Dictionaries } from "@themelios/runtime/locales";
import { Cas, Database } from "@themelios/storage";
import { timeSchemaSql } from "@themelios/storage/time";
import PQueue from "p-queue";
import type { ZodType } from "zod";
import type {
  ApplicationApi,
  ApplicationTasks,
  RunTaskInput,
  TaskResult,
} from "./contracts.js";
import type { RepresentationAdapter } from "./input-contracts.js";
import { operationLocale, resultBudget } from "./operations.js";
import { createPreparation } from "./preparation.js";
import { applicationSettings, type ApplicationSettings } from "./settings.js";
import { describeTask } from "./task-description.js";
import type { TaskRoute } from "./task-route.js";
import { createTasks } from "./tasks.js";
import { createWireCodec } from "./wire.js";

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
    // Once selected, the task parses its own unknown input and checks its own output before we expose a result.
    byId.set(task.id, task as RegisteredTask);
  }
  return byId;
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
        schemaSql: [contentSchemaSql, timeSchemaSql].join("\n"),
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
      const localize = await createLocalizer(locales);
      const getLocale = () =>
        operationLocale() ?? env.configuration.snapshot().locale;
      const translate = (key: string) => localize(getLocale(), key);
      const getContent = (scheduleWrite?: ScheduleContentWrite) =>
        createContent({
          database,
          cas,
          ...env.configuration.snapshot().content,
          ...(scheduleWrite === undefined ? {} : { scheduleWrite }),
        });
      const modelResources = await env.bindResource(
        (settings) =>
          parseJson({
            locale: settings.locale,
            connections: settings.models.connections,
            bindings: settings.models.bindings,
            ioConcurrency: settings.runtime.ioConcurrency,
            defaults: {
              timeoutMs: settings.models.timeoutMs,
              maxAttempts: settings.models.maxAttempts,
              concurrency: settings.models.concurrency,
            },
          }),
        async (context) => {
          const settings = context.settings.models;
          const models = createModels({
            connections: settings.connections,
            bindings: settings.bindings,
            fetch: context.network.fetch,
            diagnostics: context.diagnostics,
            resolveCredential: (ref) => context.secrets.resolve(ref),
            defaults: {
              timeoutMs: settings.timeoutMs,
              maxAttempts: settings.maxAttempts,
              concurrency: settings.concurrency,
            },
          });
          const prompts = createPrompts({
            resourceRoot: definition.resourceRoot,
            overrideRoot: join(env.paths.config, "prompts"),
            locale: context.settings.locale,
          });
          for (const task of catalog.values()) await prompts.read(task);
          const queue = new PQueue({
            concurrency: context.settings.runtime.ioConcurrency,
          });
          return {
            models,
            prompts,
            queue,
            async close() {
              await queue.onIdle();
              await models.close();
            },
          };
        },
      );
      const assertWritable = (operation: string) => {
        if (env.mode === "read-only")
          throw appError("runtime.read_only", { details: { operation } });
      };
      const runIo = <T>(
        operation: string,
        work: (options: CallOptions) => Promise<T>,
        options?: CallOptions,
      ) =>
        env.execution.run(
          operation,
          (signal) => modelResources.get().queue.add(() => work({ signal })),
          options,
        );
      const scheduleContentWrite: ScheduleContentWrite = (
        operation,
        capture,
        options,
      ) =>
        env.execution.run(
          operation,
          (signal) => {
            assertWritable(operation);
            const work = capture();
            return modelResources.get().queue.add(() => work(signal));
          },
          options,
        );
      function read(
        ref: ArtifactRef,
        options?: CallOptions,
      ): Promise<MaterialRead> {
        const opened = Promise.withResolvers<MaterialRead>();
        const operation = env.execution.start(
          "materials.read",
          (signal) =>
            modelResources.get().queue.add(async () => {
              throwIfAborted(signal);
              const material = await getContent().materials.read(ref, {
                signal,
              });
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
          getContent(scheduleContentWrite).materials.accept(input, opts),
        prepare: (input, opts) =>
          getContent(scheduleContentWrite).materials.prepare(input, opts),
        inspect: (ref) => getContent().materials.inspect(ref),
        read,
        text: (selection, opts) =>
          runIo(
            "materials.text",
            (call) => getContent().materials.text(selection, call),
            opts,
          ),
        structure: (ref, opts) =>
          runIo(
            "materials.structure",
            (call) => getContent().materials.structure(ref, call),
            opts,
          ),
        sources: (ref, opts) => getContent().materials.sources(ref, opts),
        list: (opts) => getContent().materials.list(opts),
        retain(ref) {
          assertWritable("materials.retain");
          getContent().materials.retain(ref);
        },
        release(ref) {
          assertWritable("materials.release");
          getContent().materials.release(ref);
        },
        export: (ref, destination, opts) =>
          runIo(
            "materials.export",
            (call) => getContent().materials.export(ref, destination, call),
            opts,
          ),
      };
      const results: Results = {
        save: (completed, opts) =>
          getContent(scheduleContentWrite).results.save(completed, opts),
        prepare: (completed, opts) =>
          getContent(scheduleContentWrite).results.prepare(completed, opts),
        read: <T extends Json>(
          ref: ArtifactRef,
          schema?: ZodType<T> | CallOptions,
          opts?: CallOptions,
        ) => {
          const isSchema = schema && "safeParse" in schema;
          return runIo(
            "results.read",
            (call) =>
              isSchema
                ? getContent().results.read(ref, schema, call)
                : getContent().results.read(ref, call),
            isSchema ? opts : schema,
          );
        },
      } as Results;
      const find = (name: string) => {
        const task = catalog.get(name);
        if (!task)
          throw appError("tasks.not_found", { details: { task: name } });
        return task;
      };
      const prompts: ApplicationPrompts = {
        read: (task) => modelResources.get().prompts.read(find(task)),
        describe: (task) => modelResources.get().prompts.describe(find(task)),
        diff: (task) => modelResources.get().prompts.diff(find(task)),
        async setOverride(task, change) {
          assertWritable("prompts.setOverride");
          return env.execution.run("prompts.setOverride", () =>
            modelResources.get().prompts.setOverride(find(task), change),
          );
        },
        async reset(task, part) {
          assertWritable("prompts.reset");
          return env.execution.run("prompts.reset", () =>
            modelResources.get().prompts.reset(find(task), part),
          );
        },
      };
      const tasks = bindTasks(
        env,
        definition,
        find,
        catalog,
        modelResources.get,
        getContent,
        translate,
        assertWritable,
      );
      const representations = {
        find: getContent().representations.find,
        set: (
          representation: Parameters<
            ApplicationApi["representations"]["set"]
          >[0],
        ) => {
          assertWritable("representations.set");
          getContent().representations.set(representation);
        },
        remove: (
          ...args: Parameters<ApplicationApi["representations"]["remove"]>
        ) => {
          assertWritable("representations.remove");
          getContent().representations.remove(...args);
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
  definition: ApplicationDefinition,
  find: (name: string) => RegisteredTask,
  catalog: ReadonlyMap<string, RegisteredTask>,
  modelResources: () => {
    models: ReturnType<typeof createModels>;
    prompts: ReturnType<typeof createPrompts>;
  },
  getContent: () => ReturnType<typeof createContent>,
  translate: (key: string) => string,
  assertWritable: (name: string) => void,
): ApplicationTasks {
  function runner(maxJsonBytes?: number) {
    const { models, prompts } = modelResources();
    const settings = env.configuration.snapshot();
    const preparation = createPreparation({
      models,
      prompts,
      materials: getContent().materials,
      maxMaterialBytes: settings.preparation.maxMaterialBytes,
      maxInlineBytes: settings.content.maxInlineBytes,
      maxImagePixels: settings.preparation.image.maxPixels,
      ...(definition.adapters === undefined
        ? {}
        : { adapters: definition.adapters }),
    });
    return createTasks({
      models,
      prompts,
      preparation,
      routes: settings.models.tasks as Readonly<Record<string, TaskRoute>>,
      concurrency: settings.models.concurrency,
      timeoutMs: settings.models.timeoutMs,
      ...(maxJsonBytes === undefined
        ? {}
        : {
            reserveResult(completed) {
              const known = createWireCodec(
                getContent().results,
              ).encodeCompleted(completed);
              const bytes = Buffer.byteLength(JSON.stringify(known)) - 4; // null is a placeholder for the eventual value.
              if (bytes >= maxJsonBytes)
                throw appError("transport.result_too_large", {
                  details: {
                    actualBytes: bytes,
                    maxJsonBytes,
                    solution: "Use a Selection and persist the result",
                  },
                });
              return maxJsonBytes - bytes;
            },
          }),
    });
  }
  function options(options?: CallOptions): CallOptions {
    return {
      timeoutMs: env.configuration.snapshot().models.timeoutMs,
      ...options,
    };
  }
  async function run(
    input: RunTaskInput,
    opts?: CallOptions,
  ): Promise<TaskResult> {
    parseJson(input.variables);
    const captured = structuredClone(input);
    return env.execution.run(
      "tasks.run",
      async (signal) => {
        if (captured.persist) assertWritable("tasks.run.save");
        const done = await runner(
          captured.persist ? undefined : resultBudget(),
        ).run(find(captured.task), captured, { signal });
        return captured.persist
          ? getContent().results.save(done, { signal })
          : done;
      },
      options(opts),
    );
  }
  return {
    run: run as ApplicationTasks["run"],
    stream(input, opts) {
      parseJson(input.variables);
      const captured = structuredClone(input);
      const maxJsonBytes = captured.persist ? undefined : resultBudget();
      return env.execution.flow(
        "tasks.stream",
        (signal) =>
          createFlow(
            "tasks.stream",
            async function* (call) {
              if (captured.persist) assertWritable("tasks.stream.save");
              for await (const event of runner(maxJsonBytes).stream(
                find(captured.task),
                captured,
                { signal: call.signal },
              )) {
                if (event.type === "result")
                  return captured.persist
                    ? getContent().results.save(event.value, {
                        signal: call.signal,
                      })
                    : event.value;
                yield event;
              }
              throw appError("model.incomplete", {
                details: { stage: "stream" },
              });
            },
            { signal },
          ),
        options(opts),
      );
    },
    async runMany(inputs, opts) {
      const call = openCall("tasks.runMany", options(opts));
      const queue = new PQueue({
        concurrency: env.configuration.snapshot().models.concurrency,
      });
      try {
        const captured = structuredClone(inputs);
        return await Promise.all(
          captured.map((input) =>
            queue.add(async () => {
              try {
                call.throwIfAborted("queue");
                return {
                  ok: true as const,
                  result: await run(input, { signal: call.signal }),
                };
              } catch (error) {
                return {
                  ok: false as const,
                  error: toErrorInfo(error, translate),
                };
              }
            }),
          ),
        );
      } finally {
        call.close();
      }
    },
    preview(input, opts) {
      parseJson(input.variables);
      const captured = structuredClone(input);
      return env.execution.run(
        "tasks.preview",
        (signal) => runner().preview(find(captured.task), captured, { signal }),
        options(opts),
      );
    },
    describe: (name) =>
      describeTask(find(name), modelResources().prompts, translate),
    list: () =>
      [...catalog.values()].map((task) => ({
        id: task.id,
        title: translate(task.titleKey),
        purpose: translate(task.purposeKey),
      })),
  };
}
