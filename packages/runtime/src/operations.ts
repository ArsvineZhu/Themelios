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
import { instanceInfoSchema, type InstanceInfo } from "./paths.js";
import {
  configurationChangeSchema,
  settingDescriptionSchema,
  settingExplanationSchema,
  type Configuration,
} from "./settings.js";

export type Permission = string;
export const standardPermission = Object.freeze({
  read: "read",
  write: "write",
  admin: "admin",
} as const);
export const standardPermissionSchema = z.enum(standardPermission);

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
export type HttpMethod = "GET" | "HEAD" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface HttpRouteSpec {
  readonly method: HttpMethod;
  readonly path: string;
  readonly status?: number;
  readonly paramMap?: Readonly<Record<string, string>>;
  readonly queryStrings?: readonly string[];
  readonly queryNumbers?: readonly string[];
  readonly mergeParamsIntoBody?: boolean;
  readonly binaryBody?: boolean;
}

export interface McpToolSpec<I = unknown> {
  readonly expose?: boolean;
  readonly input?: z.ZodType<I>;
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

export type Operation<App = unknown, I = unknown, O = unknown, R = O> = {
  readonly id: string;
  readonly description: string;
  readonly permission: Permission;
  readonly input: z.ZodType<I>;
  readonly binaryInput?: z.ZodType<I>;
  readonly http?: readonly HttpRouteSpec[];
  readonly mcp?: McpToolSpec<I>;
  readonly cli?: CliCommandSpec | null;
  present?(
    output: R,
    app: App,
    context: OperationContext,
  ): string | Promise<string>;
} & (
  | {
      readonly kind?: "unary";
      readonly output: z.ZodType;
      execute(app: App, input: I, context: OperationContext): O | Promise<O>;
    }
  | {
      readonly kind: "stream";
      readonly output: z.ZodType;
      execute(app: App, input: I, context: OperationContext): Flow<O>;
    }
  | {
      readonly kind: "binary-read";
      readonly output?: never;
      execute(
        app: App,
        input: I,
        context: OperationContext,
      ): BinaryReadResult | Promise<BinaryReadResult>;
    }
);

export type AnyOperation<App = unknown> = Operation<App>;
export type OperationDirectory<App = unknown> = ReadonlyMap<
  string,
  AnyOperation<App>
>;

export type OperationValue<T> = T extends object
  ? { readonly [Key in keyof T]: OperationValue<T[Key]> }
  : T;

/** Bind a host API while inferring an operation's contract from its schemas. */
export function defineOperation<App>() {
  return <Input extends z.ZodType, Output extends z.ZodType>(
    spec: Operation<
      App,
      z.output<NoInfer<Input>>,
      OperationValue<z.input<NoInfer<Output>>>,
      z.output<NoInfer<Output>>
    > & { readonly input: Input; readonly output?: Output },
  ) => {
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
  };
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
  const directory = new Map<string, AnyOperation<App>>();
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
    directory.set(operation.id, operation);
  }
  return directory;
}

export interface BinaryReadResult {
  readonly info: {
    readonly mediaType: string;
    readonly ref?: string;
    readonly name?: string | undefined;
    readonly sizeBytes: number;
  };
  readonly body: ReadableStream<Uint8Array>;
}

export interface AgentRefBridge {
  resolveRef(ref: string): string;
  formatRef(ref: string): string;
}

export type OperationInputMode = "default" | "binary" | "mcp";

export interface OperationCallOptions {
  /** Selects the operation's input schema for the transport representation. */
  readonly input?: OperationInputMode;
  /** Restricts which operations the caller can deliver through this entry point. */
  readonly accepts?: readonly OperationKind[];
}

export type OperationOutcome =
  | {
      readonly kind: "unary";
      readonly result: Promise<unknown>;
      present(): Promise<string | undefined>;
    }
  | {
      readonly kind: "stream";
      readonly flow: Flow<unknown>;
      present(value: unknown): Promise<string | undefined>;
    }
  | {
      readonly kind: "binary-read";
      readonly result: Promise<BinaryReadResult>;
    };

/** Resolves the schema used to decode an operation's selected input form. */
export function operationInputSchema(
  operation: Pick<AnyOperation, "input" | "binaryInput" | "mcp">,
  mode: OperationInputMode,
) {
  if (mode === "binary") return operation.binaryInput;
  if (mode === "mcp") return operation.mcp?.input ?? operation.input;
  return operation.input;
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

/** Authorizes and decodes one registered operation, then executes it and validates its result. */
export function callOperation<App>(
  app: App,
  directory: OperationDirectory<App>,
  id: string,
  rawInput: unknown,
  context: OperationContext,
  options: OperationCallOptions = {},
): OperationOutcome {
  const operation = directory.get(id);
  if (!operation) {
    throw appError("transport.not_found", { details: { operation: id } });
  }
  assertOperationPermission(operation, context.principal);
  const kind = operation.kind ?? "unary";
  if (options.accepts && !options.accepts.includes(kind)) {
    throw appError("transport.invalid_request", {
      details: { operation: id, reason: "unsupported_operation_kind", kind },
    });
  }
  const schema = operationInputSchema(operation, options.input ?? "default");
  if (!schema)
    throw appError("transport.invalid_request", {
      details: { operation: id, reason: "binary_input_not_supported" },
    });
  const input = parseValue(schema, rawInput, "transport.invalid_request");
  if (operation.kind === "stream") {
    return {
      kind: operation.kind,
      flow: checkedFlow(operation, operation.execute(app, input, context)),
      async present(value) {
        return operation.present?.(value, app, context);
      },
    };
  }
  if (operation.kind === "binary-read") {
    return {
      kind: operation.kind,
      result: Promise.resolve(operation.execute(app, input, context)),
    };
  }
  const result = Promise.resolve(operation.execute(app, input, context)).then(
    (output) => validateOutput(operation, output),
  );
  return {
    kind: "unary",
    result,
    async present() {
      return operation.present?.(await result, app, context);
    },
  };
}

export interface InstanceOperationTarget {
  info(): InstanceInfo;
}

export interface ConfigurationOperationTarget<S = unknown> {
  readonly configuration: Configuration<S>;
}

const emptySchema = z.strictObject({});
const pathSchema = z.strictObject({ path: z.string().min(1) });

export const instanceOperationIds = Object.freeze({ info: "instance.info" });
export const configurationOperationIds = Object.freeze({
  describe: "configuration.describe",
  explain: "configuration.explain",
  set: "configuration.set",
  unset: "configuration.unset",
  reload: "configuration.reload",
});

export function instanceOperations<
  App extends InstanceOperationTarget,
>(): readonly AnyOperation<App>[] {
  return [
    defineOperation<App>()({
      id: instanceOperationIds.info,
      description: "Read instance identity and paths.",
      permission: standardPermission.read,
      input: emptySchema,
      output: instanceInfoSchema,
      mcp: { expose: false, readOnlyHint: true, idempotentHint: true },
      http: [{ method: "GET", path: "/instance" }],
      execute: (app) => app.info(),
    }),
  ];
}

export function configurationOperations<
  App extends ConfigurationOperationTarget,
>(): readonly AnyOperation<App>[] {
  return [
    defineOperation<App>()({
      id: configurationOperationIds.describe,
      description: "Describe the available settings.",
      permission: standardPermission.read,
      input: z.strictObject({ path: z.string().optional() }),
      output: z.array(settingDescriptionSchema),
      mcp: { readOnlyHint: true, idempotentHint: true },
      http: [{ method: "GET", path: "/configuration", queryStrings: ["path"] }],
      execute: (app, { path }) => app.configuration.describe(path),
    }),
    defineOperation<App>()({
      id: configurationOperationIds.explain,
      description:
        "Explain the source, desired and effective value of a setting.",
      permission: standardPermission.read,
      input: pathSchema,
      output: settingExplanationSchema,
      mcp: { readOnlyHint: true, idempotentHint: true },
      http: [{ method: "POST", path: "/configuration/explain" }],
      execute: (app, { path }) => app.configuration.explain(path),
    }),
    defineOperation<App>()({
      id: configurationOperationIds.set,
      description: "Update a managed setting.",
      permission: standardPermission.admin,
      input: pathSchema.extend({ value: jsonSchema }),
      output: configurationChangeSchema,
      mcp: { expose: false, destructiveHint: true },
      http: [{ method: "POST", path: "/configuration/set" }],
      execute: (app, { path, value }) => app.configuration.set(path, value),
    }),
    defineOperation<App>()({
      id: configurationOperationIds.unset,
      description: "Remove a managed setting.",
      permission: standardPermission.admin,
      input: pathSchema,
      output: configurationChangeSchema,
      mcp: { expose: false, destructiveHint: true },
      http: [{ method: "POST", path: "/configuration/unset" }],
      execute: (app, { path }) => app.configuration.unset(path),
    }),
    defineOperation<App>()({
      id: configurationOperationIds.reload,
      description: "Read updated configuration from disk.",
      permission: standardPermission.admin,
      input: emptySchema,
      output: configurationChangeSchema,
      mcp: { expose: false },
      http: [{ method: "POST", path: "/configuration/reload" }],
      execute: (app) => app.configuration.reload(),
    }),
  ];
}
