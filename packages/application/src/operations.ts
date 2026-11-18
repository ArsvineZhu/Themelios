import { AsyncLocalStorage } from "node:async_hooks";
import {
  appError,
  createFlow,
  jsonSchema,
  parseValue,
  toErrorInfo,
  type Flow,
} from "@themelios/core";
import { modelNameSchema } from "@themelios/models";
import { z } from "zod";
import type {
  ApplicationApi,
  Operation,
  OperationContext,
  Permission,
  Principal,
  TaskResult,
} from "./contracts.js";
import * as shapes from "./operation-schemas.js";
import {
  createWireCodec,
  parseWireInline,
  wireAcceptSchema,
  wireCompletedSchema,
  wireOriginSchema,
  wirePreviewInputSchema,
  wirePreviewSchema,
  wireResultSchema,
  wireRunTaskSchema,
  wireSavedSchema,
  wireSelectionSchema,
} from "./wire.js";

type ExternalOperation = Operation<unknown, unknown>;
const invocation = new AsyncLocalStorage<OperationContext>();
export function operationLocale(): string | undefined {
  return invocation.getStore()?.locale;
}
export function resultBudget(): number | undefined {
  return invocation.getStore()?.maxJsonBytes;
}

export function defineOperation<I, O>(spec: Operation<I, O>): Operation<I, O> {
  if (!/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/.test(spec.id)) {
    throw appError("config.invalid", {
      details: {
        issues: [
          { path: spec.id, messageKey: "transport.invalid_operation_id" },
        ],
      },
    });
  }
  return Object.freeze(spec);
}

export function assertOperationPermission(
  operation: Pick<ExternalOperation, "id" | "permission">,
  principal: Principal,
): void {
  if (!principal.permissions.includes(operation.permission)) {
    throw appError("transport.access_denied", {
      details: { operation: operation.id, permission: operation.permission },
    });
  }
}

const binaryInput = z.strictObject({
  body: z.instanceof(ReadableStream<Uint8Array>),
  mediaType: z.string().min(1),
  name: z.string().min(1).optional(),
  origin: wireOriginSchema.optional(),
});

export function callOperation(
  directory: ReadonlyMap<string, ExternalOperation>,
  id: string,
  data: unknown,
  context: OperationContext,
): Promise<unknown> | Flow<unknown> {
  const operation = directory.get(id);
  if (!operation)
    throw appError("transport.not_found", { details: { operation: id } });
  assertOperationPermission(operation, context.principal);
  const isBinary =
    id === "materials.accept" &&
    typeof data === "object" &&
    data !== null &&
    "body" in data;
  const input = parseValue(
    isBinary ? binaryInput : operation.input,
    data,
    "transport.invalid_request",
  );
  return invocation.run(context, () => operation.execute(input, context));
}

const empty = z.strictObject({});
const taskId = z.strictObject({ task: modelNameSchema });
const path = z.strictObject({ path: z.string().min(1) });
type Codec = ReturnType<typeof createWireCodec>;

function encodeOutput(codec: Codec, value: TaskResult) {
  return "ref" in value ? value : codec.encodeCompleted(value);
}

function limitJson(value: unknown, context: OperationContext): void {
  if (context.maxJsonBytes === undefined) return;
  limitJsonBytes(
    Buffer.byteLength(JSON.stringify(value)),
    context.maxJsonBytes,
  );
}

function limitJsonBytes(bytes: number, maxJsonBytes: number): void {
  if (bytes > maxJsonBytes)
    throw appError("transport.result_too_large", {
      details: {
        actualBytes: bytes,
        maxJsonBytes,
        solution: "Use a Selection and persist the result",
      },
    });
}

export function createOperations<S>(
  api: ApplicationApi<S>,
): ReadonlyMap<string, ExternalOperation> {
  const directory = new Map<string, ExternalOperation>();
  const register = <I, O>(
    id: string,
    description: string,
    permission: Permission,
    input: z.ZodType<I>,
    output: z.ZodType,
    execute: (data: I, ctx: OperationContext) => O | Promise<O>,
  ) => {
    directory.set(
      id,
      defineOperation({
        id,
        description,
        permission,
        mode: "unary",
        input,
        output,
        async execute(value, context) {
          const result = await execute(value, context);
          if (id !== "materials.read") limitJson(result, context);
          return result;
        },
      }) as ExternalOperation,
    );
  };
  const { materials, results, tasks, prompts, configuration } = api;
  register(
    "instance.info",
    "Read instance identity and paths.",
    "read",
    empty,
    shapes.instanceInfo,
    () => api.info(),
  );
  register(
    "materials.accept",
    "Import bytes as immutable material.",
    "write",
    wireAcceptSchema,
    wireSelectionSchema,
    (value, context) => {
      if ("body" in value) {
        const { body, mediaType, name, origin } = parseValue(
          binaryInput,
          value,
          "transport.invalid_request",
        );
        return materials.accept(
          {
            body,
            mediaType,
            ...(name === undefined ? {} : { name }),
            ...(origin === undefined ? {} : { origin }),
          },
          context.options,
        );
      }
      return materials.accept(parseWireInline(value), context.options);
    },
  );
  register(
    "materials.inspect",
    "Inspect material metadata.",
    "read",
    shapes.requiredRef,
    shapes.artifact,
    ({ ref }) => materials.inspect(ref),
  );
  register(
    "materials.read",
    "Read original bytes and metadata.",
    "read",
    shapes.requiredRef,
    shapes.binary,
    ({ ref }, ctx) => materials.read(ref, ctx.options),
  );
  register(
    "materials.text",
    "Read a text or JSON selection.",
    "read",
    wireSelectionSchema,
    z.strictObject({ text: z.string() }),
    async (selection, ctx) => ({
      text: await materials.text(selection, ctx.options),
    }),
  );
  register(
    "materials.structure",
    "Read text blocks with source coordinates.",
    "read",
    shapes.requiredRef,
    shapes.textBlocks,
    ({ ref }, ctx) => materials.structure(ref, ctx.options),
  );
  register(
    "materials.sources",
    "Trace links from material or result to its sources.",
    "read",
    shapes.requiredRef.extend({ depth: z.int().positive().optional() }),
    shapes.sourceLinks,
    ({ ref, depth }) =>
      materials.sources(ref, depth === undefined ? {} : { depth }),
  );
  register(
    "materials.list",
    "List material metadata at a commit cut.",
    "read",
    shapes.listMaterials,
    z.array(shapes.artifact),
    ({ at, after, limit }) =>
      materials.list({
        ...(at === undefined ? {} : { at }),
        ...(after === undefined ? {} : { after }),
        ...(limit === undefined ? {} : { limit }),
      }),
  );
  register(
    "materials.retain",
    "Retain a material as a root.",
    "write",
    shapes.requiredRef,
    z.null(),
    ({ ref }) => {
      materials.retain(ref);
      return null;
    },
  );
  register(
    "materials.release",
    "Release a retained material root.",
    "write",
    shapes.requiredRef,
    z.null(),
    ({ ref }) => {
      materials.release(ref);
      return null;
    },
  );
  register(
    "results.save",
    "Save a completed value and its source graph.",
    "write",
    wireCompletedSchema,
    wireSavedSchema,
    async (wire, { options }) =>
      results.save(
        await createWireCodec(results, options).decodeCompleted(wire),
        options,
      ),
  );
  register(
    "results.read",
    "Read a saved result and its precise source references.",
    "read",
    shapes.requiredRef,
    wireSavedSchema,
    ({ ref }, ctx) => results.read(ref, ctx.options),
  );
  register(
    "tasks.list",
    "List registered tasks.",
    "read",
    empty,
    shapes.taskList,
    () => tasks.list(),
  );
  register(
    "tasks.describe",
    "Describe variables, output, requirements and templates of a task.",
    "read",
    taskId,
    shapes.taskDescription,
    ({ task }) => tasks.describe(task),
  );
  register(
    "tasks.preview",
    "Compile the prompt and show planned media preparation.",
    "read",
    wirePreviewInputSchema,
    wirePreviewSchema,
    async (wire, ctx) => {
      const codec = createWireCodec(results, ctx.options);
      return codec.encodePreview(
        await tasks.preview(await codec.decodeTask(wire), ctx.options),
      );
    },
  );
  register(
    "tasks.run",
    "Run a task on a group of materials; optionally save it.",
    "write",
    wireRunTaskSchema,
    wireResultSchema,
    async (wire, ctx) => {
      const codec = createWireCodec(results, ctx.options);
      const input = await codec.decodeTask(wire);
      if (!input.persist) limitJson(wire, ctx);
      return encodeOutput(codec, await tasks.run(input, ctx.options));
    },
  );
  register(
    "tasks.runMany",
    "Run independent requests in order, with item-level errors.",
    "write",
    z.strictObject({ inputs: z.array(wireRunTaskSchema) }),
    shapes.batch,
    async ({ inputs }, ctx) => {
      const codec = createWireCodec(results, ctx.options);
      const decoded = await Promise.all(
        inputs.map(async (wire, index) => {
          try {
            return { index, value: await codec.decodeTask(wire) };
          } catch (error) {
            return { index, error: toErrorInfo(error) };
          }
        }),
      );
      const valid = decoded.flatMap((item) => (item.value ? [item.value] : []));
      const outcomes = (await tasks.runMany(valid, ctx.options))[
        Symbol.iterator
      ]();
      return decoded.map((item) => {
        if (item.error) return { ok: false, error: item.error };
        const result = outcomes.next().value!;
        return result.ok
          ? { ok: true, result: encodeOutput(codec, result.result) }
          : result;
      });
    },
  );
  directory.set(
    "tasks.stream",
    defineOperation({
      id: "tasks.stream",
      description: "Stream progress, text and the final task result.",
      permission: "write",
      mode: "stream",
      input: wireRunTaskSchema,
      output: wireResultSchema,
      execute(wire, ctx) {
        return createFlow(
          "tasks.stream",
          async function* (call) {
            const options = { signal: call.signal };
            const codec = createWireCodec(results, options);
            const data = await codec.decodeTask(wire);
            if (!data.persist) limitJson(wire, ctx);
            let size = 0;
            const stream = invocation.run(ctx, () =>
              tasks.stream(data, options),
            );
            for await (const event of stream) {
              if (event.type === "result") {
                const output = encodeOutput(codec, event.value);
                limitJson(output, ctx);
                return output;
              }
              if (event.type === "text-delta")
                size += Buffer.byteLength(event.text);
              if (ctx.maxJsonBytes !== undefined && !data.persist)
                limitJsonBytes(size, ctx.maxJsonBytes);
              yield event;
            }
            throw appError("model.incomplete", {
              details: { stage: "stream" },
            });
          },
          ctx.options,
        );
      },
    }) as ExternalOperation,
  );
  register(
    "prompts.read",
    "Read the active system and user templates.",
    "read",
    taskId,
    shapes.promptTemplates,
    ({ task }) => prompts.read(task),
  );
  register(
    "prompts.describe",
    "Describe prompt variables, output and template sources.",
    "read",
    taskId,
    shapes.promptDescription,
    ({ task }) => prompts.describe(task),
  );
  register(
    "prompts.diff",
    "Get builtin and instance override templates.",
    "read",
    taskId,
    shapes.promptDiff,
    ({ task }) => prompts.diff(task),
  );
  register(
    "prompts.setOverride",
    "Compile and save an instance template override.",
    "admin",
    taskId.extend({ role: shapes.promptPart, template: z.string() }),
    shapes.promptDescription,
    ({ task, role, template }) => prompts.setOverride(task, { role, template }),
  );
  register(
    "prompts.reset",
    "Reset one or both templates to builtin values.",
    "admin",
    taskId.extend({ role: shapes.promptPart.optional() }),
    shapes.promptDescription,
    ({ task, role }) => prompts.reset(task, role),
  );
  register(
    "configuration.describe",
    "Describe the available settings.",
    "read",
    z.strictObject({ path: z.string().optional() }),
    shapes.settings,
    ({ path }) => configuration.describe(path),
  );
  register(
    "configuration.explain",
    "Explain the source, desired and effective value of a setting.",
    "read",
    path,
    shapes.explainSetting,
    ({ path }) => configuration.explain(path),
  );
  register(
    "configuration.set",
    "Update a managed setting.",
    "admin",
    path.extend({ value: jsonSchema }),
    shapes.changedSettings,
    ({ path, value }) => configuration.set(path, value),
  );
  register(
    "configuration.unset",
    "Remove a managed setting.",
    "admin",
    path,
    shapes.changedSettings,
    ({ path }) => configuration.unset(path),
  );
  register(
    "configuration.reload",
    "Read updated configuration from disk.",
    "admin",
    empty,
    shapes.changedSettings,
    () => configuration.reload(),
  );
  return directory;
}
