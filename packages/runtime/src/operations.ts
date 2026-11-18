import {
  appError,
  parseValue,
  type CallOptions,
  type Flow,
  type FlowEvent,
  type Json,
} from "@themelios/core";
import { z } from "zod";
import { jsonSchema } from "@themelios/core";
import {
  instanceInfoSchema,
  type InstanceInfo,
  type InstancePaths,
} from "./paths.js";
import type { Configuration } from "./settings.js";

export type Permission = "read" | "write" | "admin";

export interface Principal {
  readonly id: string;
  readonly permissions: readonly Permission[];
}

export interface OperationContext {
  readonly principal: Principal;
  readonly locale: string;
  readonly options: CallOptions;
}

export type OperationKind = "unary" | "stream" | "binary-read";

export interface HttpRouteSpec {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly status?: number;
  readonly paramMap?: Readonly<Record<string, string>>;
  readonly queryStrings?: readonly string[];
  readonly queryNumbers?: readonly string[];
  readonly mergeParamsIntoBody?: boolean;
  readonly binaryInput?: z.ZodType;
}

export interface McpToolSpec {
  readonly expose?: boolean;
  readonly input?: z.ZodType;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
}

export interface CliArgHelpers {
  readonly cwd: string;
  readonly maxJsonBytes: number;
  readJsonInput(pathOrDash: string): Promise<Json>;
}

export interface CliOptionSpec {
  readonly flags: string;
  readonly description?: string;
}

export interface CliCommandSpec {
  readonly command: string;
  readonly description?: string;
  readonly options?: readonly CliOptionSpec[];
  parseInput?(
    args: readonly (string | undefined)[],
    opts: Record<string, unknown>,
    helpers: CliArgHelpers,
  ): unknown | Promise<unknown>;
}

export interface Operation<App = unknown, I = unknown, O = unknown> {
  readonly id: string;
  readonly description: string;
  readonly permission: Permission;
  readonly kind?: OperationKind;
  readonly input: z.ZodType<I>;
  readonly output?: z.ZodType;
  readonly http?: false | HttpRouteSpec | readonly HttpRouteSpec[];
  readonly mcp?: McpToolSpec;
  readonly cli?: CliCommandSpec | false;
  present?(
    output: O,
    app: App,
    context: OperationContext,
  ): string | Promise<string>;
  execute(
    app: App,
    input: I,
    context: OperationContext,
  ): O | Promise<O> | Flow<O>;
}

export type AnyOperation<App = any> = Operation<App, any, any>;
export type OperationDirectory<App = any> = ReadonlyMap<
  string,
  Operation<App, unknown, unknown>
>;

export function defineOperation<App, I, O>(
  spec: Operation<App, I, O>,
): Operation<App, I, O> {
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
  operation: Pick<AnyOperation, "id" | "permission">,
  principal: Principal,
): void {
  if (!principal.permissions.includes(operation.permission)) {
    throw appError("transport.access_denied", {
      details: { operation: operation.id, permission: operation.permission },
    });
  }
}

export function createOperationDirectory<App>(
  operations: readonly AnyOperation<App>[],
): OperationDirectory<App> {
  const directory = new Map<string, Operation<App, unknown, unknown>>();
  for (const operation of operations) {
    if (directory.has(operation.id)) {
      throw appError("config.invalid", {
        details: {
          issues: [
            {
              path: operation.id,
              messageKey: "transport.duplicate_operation_id",
            },
          ],
        },
      });
    }
    directory.set(operation.id, operation as Operation<App, unknown, unknown>);
  }
  return directory;
}

export interface BinaryReadResult {
  readonly info: {
    readonly mediaType: string;
    readonly ref?: string;
    readonly name?: string;
    readonly sizeBytes: number;
  };
  readonly body: ReadableStream<Uint8Array>;
}

export interface AgentRefBridge {
  resolveRef(ref: string): string;
  formatRef(ref: string): string;
}

function validateOutput(operation: AnyOperation, output: unknown): unknown {
  if (!operation.output) return output;
  const parsed = operation.output.safeParse(output);
  if (parsed.success) return parsed.data;
  throw appError("internal.unexpected", {
    details: { operation: operation.id },
    cause: parsed.error,
  });
}

function checkedFlow(
  operation: AnyOperation,
  flow: Flow<unknown>,
): Flow<unknown> {
  if (
    !flow ||
    typeof flow[Symbol.asyncIterator] !== "function" ||
    typeof flow.cancel !== "function"
  ) {
    throw appError("internal.unexpected", {
      details: { operation: operation.id },
    });
  }
  return {
    cancel: (reason) => flow.cancel(reason),
    async *[Symbol.asyncIterator](): AsyncGenerator<FlowEvent<unknown>> {
      for await (const event of flow) {
        yield event.type === "result"
          ? { type: "result", value: validateOutput(operation, event.value) }
          : event;
      }
    },
  };
}

export function callOperation<App>(
  app: App,
  directory: OperationDirectory<App>,
  id: string,
  rawInput: unknown,
  context: OperationContext,
  inputSchema?: z.ZodType,
): Promise<unknown> | Flow<unknown> {
  const operation = directory.get(id);
  if (!operation) {
    throw appError("transport.not_found", { details: { operation: id } });
  }
  assertOperationPermission(operation, context.principal);
  const input = parseValue(
    inputSchema ?? operation.input,
    rawInput,
    "transport.invalid_request",
  );
  const result = operation.execute(app, input, context);
  return operation.kind === "stream"
    ? checkedFlow(operation, result as Flow<unknown>)
    : Promise.resolve(result).then((output) =>
        validateOutput(operation, output),
      );
}

export interface InstanceOperationTarget {
  info(): InstanceInfo & { readonly paths: InstancePaths };
}

export interface ConfigurationOperationTarget<S = unknown> {
  readonly configuration: Configuration<S>;
}

const emptySchema = z.strictObject({});
const pathSchema = z.strictObject({ path: z.string().min(1) });
const settingMetaSchema = z.strictObject({
  titleKey: z.string(),
  descriptionKey: z.string(),
  impactKey: z.string(),
  effect: z.enum(["next-call", "reload", "restart"]),
  scopes: z.array(z.enum(["installation", "instance", "task", "call"])),
  unit: z.string().optional(),
  format: z.enum(["path", "credential"]).optional(),
  sensitive: z.boolean().optional(),
  examples: z.array(jsonSchema).optional(),
  dependsOn: z.array(z.string()).optional(),
});
const settingDescriptionSchema = z.strictObject({
  path: z.string(),
  metadata: settingMetaSchema,
  schema: jsonSchema,
});
const settingExplanationSchema = z.strictObject({
  field: settingDescriptionSchema,
  desired: jsonSchema.optional(),
  effective: jsonSchema.optional(),
  state: z.enum(["active", "restart-required"]),
  contributions: z.array(
    z.strictObject({
      layer: z.enum([
        "default",
        "installation",
        "instance",
        "managed",
        "task",
        "call",
      ]),
      file: z.string().optional(),
      value: jsonSchema,
    }),
  ),
});

export function instanceOperations<
  App extends InstanceOperationTarget,
>(): readonly AnyOperation<App>[] {
  return [
    defineOperation<App, Record<string, never>, unknown>({
      id: "instance.info",
      description: "Read instance identity and paths.",
      permission: "read",
      input: emptySchema,
      output: instanceInfoSchema,
      mcp: { expose: false, readOnlyHint: true, idempotentHint: true },
      http: { method: "GET", path: "/instance" },
      execute: (app) => app.info(),
    }),
  ];
}

export function configurationOperations<
  App extends ConfigurationOperationTarget,
>(): readonly AnyOperation<App>[] {
  return [
    defineOperation<App, { path?: string | undefined }, unknown>({
      id: "configuration.describe",
      description: "Describe the available settings.",
      permission: "read",
      input: z.strictObject({ path: z.string().optional() }),
      output: z.array(settingDescriptionSchema),
      mcp: { readOnlyHint: true, idempotentHint: true },
      http: { method: "GET", path: "/configuration", queryStrings: ["path"] },
      execute: (app, { path }) => app.configuration.describe(path),
    }),
    defineOperation<App, { path: string }, unknown>({
      id: "configuration.explain",
      description:
        "Explain the source, desired and effective value of a setting.",
      permission: "read",
      input: pathSchema,
      output: settingExplanationSchema,
      mcp: { readOnlyHint: true, idempotentHint: true },
      http: { method: "POST", path: "/configuration/explain" },
      execute: (app, { path }) => app.configuration.explain(path),
    }),
    defineOperation<
      App,
      { path: string; value: z.infer<typeof jsonSchema> },
      unknown
    >({
      id: "configuration.set",
      description: "Update a managed setting.",
      permission: "admin",
      input: pathSchema.extend({ value: jsonSchema }),
      output: jsonSchema,
      mcp: { expose: false, destructiveHint: true },
      http: { method: "POST", path: "/configuration/set" },
      execute: (app, { path, value }) => app.configuration.set(path, value),
    }),
    defineOperation<App, { path: string }, unknown>({
      id: "configuration.unset",
      description: "Remove a managed setting.",
      permission: "admin",
      input: pathSchema,
      output: jsonSchema,
      mcp: { expose: false, destructiveHint: true },
      http: { method: "POST", path: "/configuration/unset" },
      execute: (app, { path }) => app.configuration.unset(path),
    }),
    defineOperation<App, Record<string, never>, unknown>({
      id: "configuration.reload",
      description: "Read updated configuration from disk.",
      permission: "admin",
      input: emptySchema,
      output: jsonSchema,
      mcp: { expose: false },
      http: { method: "POST", path: "/configuration/reload" },
      execute: (app) => app.configuration.reload(),
    }),
  ];
}
