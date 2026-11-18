import { resolve } from "node:path";
import {
  assertOperationPermission,
  callOperation,
  type AnyOperation,
  type BinaryReadResult,
  type OperationDirectory,
  type Operation,
  type OperationContext,
  type Permission,
  type Principal,
} from "@themelios/runtime/operations";
import { appError, type CallOptions, type Flow } from "@themelios/core";
import type { Installation, Session } from "@themelios/runtime";
import { Command, CommanderError } from "commander";
import { resolveDirectory } from "../directory.js";
import {
  cliExitCode,
  normalizeError,
  type ErrorPresentation,
} from "../errors.js";
import { defaultMaxJsonBytes, jsonText } from "../json.js";
import type { TransportLimits } from "../types.js";
import { streamStdout, writeStdout } from "./output.js";
import { nonnegativeInt, readCliInput } from "./input.js";
export {
  cliInputError,
  jsonCliInput,
  nonnegativeInt,
  objectCliInput,
  readCliInput,
} from "./input.js";
export {
  ensureNewFile,
  publishOutput,
  streamStdout,
  writeStdout,
} from "./output.js";

export interface CliWiring<App> {
  readonly program: Command;
  readonly cwd: string;
  readonly signal: AbortSignal | undefined;
  readonly directory: OperationDirectory<App>;
  isJson(): boolean;
  baseLimit(): number;
  emit(value: unknown, max?: number): Promise<void>;
  permission(id: string, permission: Permission): void;
  session<T>(
    work: (
      api: App,
      ctx: OperationContext & { maxJsonBytes: number },
    ) => Promise<T>,
  ): Promise<T>;
  unary(
    id: string,
    get: (max: number) => unknown | Promise<unknown>,
  ): Promise<void>;
}

export interface OfflineRequest {
  readonly action: "backup" | "restore" | "collect" | "verify";
  readonly instance: string;
  readonly installation?: string;
  readonly path?: string;
  readonly retainSince?: string;
  readonly signal?: AbortSignal;
}

export interface CliOptions<App = unknown, S = unknown> {
  readonly name?: string;
  readonly description?: string;
  readonly principal: Principal;
  readonly operations: readonly AnyOperation<App>[];
  readonly signal?: AbortSignal;
  readonly cwd?: string;
  readonly limits?: () => Readonly<TransportLimits>;
  readonly useInstallation?: (path: string) => Installation<App, S>;
  readonly configure?: (wiring: CliWiring<App>) => void;
  readonly offline?: (request: OfflineRequest) => Promise<unknown>;
  readonly serve?: (
    session: Session<App, S>,
    mode: "serve" | "stdio",
    signal?: AbortSignal,
  ) => Promise<void>;
}

type GlobalOptions = {
  installation?: string;
  instance: string;
  json?: boolean;
  locale?: string;
  debug?: boolean;
  timeoutMs?: number;
};

export async function runApplicationCli<App, S>(
  installation: Installation<App, S>,
  argv: readonly string[],
  options: CliOptions<App, S>,
): Promise<number> {
  const program = new Command(options.name ?? "application")
    .description(options.description ?? "Application commands.")
    .option("--installation <path>", "installation root")
    .option("--instance <name>", "instance name", "default")
    .option("--json", "machine-readable JSON or NDJSON")
    .option("--debug", "print the local error cause")
    .option("--locale <locale>", "message language")
    .option(
      "--timeout-ms <milliseconds>",
      "total operation timeout",
      nonnegativeInt,
    )
    .exitOverride()
    .configureOutput({ writeErr: () => undefined });

  const cwd = options.cwd ?? process.cwd();
  let errorPresentation: ErrorPresentation = { local: true };
  const flags = () => program.opts<GlobalOptions>();
  const selected = () =>
    flags().installation && options.useInstallation
      ? options.useInstallation(resolve(cwd, flags().installation!))
      : installation;
  const current = () => selected().instance(flags().instance);
  const localOptions = (): CallOptions => ({
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(flags().timeoutMs === undefined
      ? {}
      : { timeoutMs: flags().timeoutMs! }),
  });
  const baseLimit = () =>
    options.limits?.().maxJsonBytes ?? defaultMaxJsonBytes;
  const emit = (value: unknown, max = baseLimit()) =>
    writeStdout(
      flags().json
        ? jsonText(value, max) + "\n"
        : typeof value === "string"
          ? value.endsWith("\n")
            ? value
            : value + "\n"
          : JSON.stringify(value, null, 2) + "\n",
    );

  async function runSession<T>(
    work: (
      api: App,
      ctx: OperationContext & { maxJsonBytes: number },
      opened: Session<App, S>,
    ) => Promise<T>,
  ) {
    const opened = await current().open(
      options.signal ? { signal: options.signal } : {},
    );
    const config = opened.configuration.snapshot() as {
      locale?: string;
      transports?: TransportLimits;
    };
    const locale = flags().locale ?? config.locale ?? "zh-CN";
    errorPresentation = {
      locale,
      local: true,
      translate: (key, params) => opened.localize(key, params, locale),
    };
    try {
      return await work(
        opened.api,
        {
          principal: options.principal,
          locale,
          options: localOptions(),
          maxJsonBytes:
            options.limits?.().maxJsonBytes ??
            config.transports?.maxJsonBytes ??
            defaultMaxJsonBytes,
        },
        opened,
      );
    } finally {
      await opened.close();
    }
  }

  const directory = resolveDirectory(options.operations);

  function permission(id: string, perm: Permission) {
    assertOperationPermission({ id, permission: perm }, options.principal);
  }

  async function printFlow(
    flow: Flow<unknown>,
    operation: Operation<App, unknown, unknown>,
    api: App,
    ctx: OperationContext & { maxJsonBytes: number },
  ) {
    const json = flags().json;
    const limit = ctx.maxJsonBytes;
    for await (const event of flow) {
      if (json) await emit(event, limit);
      else if (event.type === "text-delta") await writeStdout(event.text);
      else if (event.type === "result")
        await emit(
          operation.present
            ? await operation.present(event.value, api, ctx)
            : event.value,
          limit,
        );
    }
  }

  async function unary(
    id: string,
    get: (max: number) => unknown | Promise<unknown>,
  ) {
    await runSession(async (api, ctx) => {
      const limit = ctx.maxJsonBytes ?? baseLimit();
      const data = await get(limit);
      const op = directory.get(id);
      const outcome = callOperation(api, directory, id, data, ctx);
      if (op?.kind === "stream")
        return printFlow(outcome as Flow<unknown>, op, api, ctx);
      const value = await outcome;
      if (op?.kind === "binary-read") {
        await streamStdout(
          (value as BinaryReadResult).body,
          ctx.options.signal,
        );
        return;
      }
      if (!flags().json && op?.present) {
        await emit(await op.present(value, api, ctx), limit);
      } else {
        await emit(value, limit);
      }
    });
  }

  const wiring: CliWiring<App> = {
    program,
    cwd,
    signal: options.signal,
    directory,
    isJson: () => Boolean(flags().json),
    baseLimit,
    emit,
    permission,
    session: (work) => runSession((api, ctx) => work(api, ctx)),
    unary,
  };
  program
    .command("instance")
    .description("Initialize or inspect an instance")
    .command("init")
    .action(async () => {
      permission("instance.init", "admin");
      await emit(await current().init());
    });
  options.configure?.(wiring);
  mountCustomOperations(program, directory, cwd, unary);

  if (options.offline) {
    const storage = program
      .command("storage")
      .description("Maintain an offline instance");
    const offline = async (
      action: OfflineRequest["action"],
      path?: string,
      retainSince?: string,
    ) => {
      permission("storage." + action, "admin");
      const root = flags().installation;
      await emit(
        await options.offline!({
          action,
          instance: flags().instance,
          ...(root === undefined ? {} : { installation: resolve(cwd, root) }),
          ...(path === undefined ? {} : { path: resolve(cwd, path) }),
          ...(retainSince === undefined ? {} : { retainSince }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
      );
    };
    storage.command("backup <destination>").action((p) => offline("backup", p));
    storage.command("restore <backup>").action((p) => offline("restore", p));
    storage
      .command("collect")
      .option("--retain-since <cut>")
      .action((opts) => offline("collect", undefined, opts.retainSince));
    storage.command("verify").action(() => offline("verify"));
  }

  if (options.serve) {
    for (const entry of ["serve", "mcp"] as const) {
      program.command(entry).action(async () => {
        await runSession((_api, _ctx, opened) =>
          options.serve!(
            opened,
            entry === "mcp" ? "stdio" : "serve",
            options.signal,
          ),
        );
      });
    }
  }

  return dispatch(program, argv, () => errorPresentation);
}

function mountCustomOperations<App>(
  program: Command,
  directory: ReturnType<typeof resolveDirectory<App>>,
  cwd: string,
  unary: (
    id: string,
    get: (max: number) => unknown | Promise<unknown>,
  ) => Promise<void>,
) {
  const groups = new Map(
    program.commands.map((command) => [command.name(), command]),
  );
  for (const op of directory.values()) {
    if (op.cli === false) continue;
    if (op.cli) {
      const cmd = program
        .command(op.cli.command)
        .description(op.cli.description ?? op.description);
      for (const opt of op.cli.options ?? []) {
        cmd.option(opt.flags, opt.description);
      }
      const spec = op.cli;
      cmd.action((...actionArgs: unknown[]) => {
        const opts = (actionArgs.at(-2) ?? {}) as Record<string, unknown>;
        const args = actionArgs
          .slice(0, -2)
          .map((a) => (a === undefined ? undefined : String(a)));
        return unary(op.id, async (max) =>
          spec.parseInput
            ? spec.parseInput(args, opts, {
                cwd,
                maxJsonBytes: max,
                readJsonInput: (p) => readCliInput(p, cwd, max),
              })
            : {},
        );
      });
      continue;
    }
    const [groupName, ...rest] = op.id.split(".");
    const actionName = rest.join("-");
    if (!groupName || !actionName) continue;
    let group = groups.get(groupName);
    if (!group) {
      group = program.command(groupName);
      groups.set(groupName, group);
    }
    group
      .command(actionName)
      .description(op.description)
      .option("--input <file|->")
      .action((opts) =>
        unary(op.id, (max) =>
          opts.input === undefined ? {} : readCliInput(opts.input, cwd, max),
        ),
      );
  }
}

async function dispatch(
  program: Command,
  argv: readonly string[],
  presentation: () => ErrorPresentation,
): Promise<number> {
  if (!argv.length) {
    program.outputHelp();
    return 0;
  }
  try {
    await program.parseAsync([...argv], { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    return reportFailure(program, error, presentation());
  }
}

function reportFailure(
  program: Command,
  error: unknown,
  presentation: ErrorPresentation,
): number {
  const flags = program.opts<GlobalOptions>();
  const syntax = error instanceof CommanderError;
  const cause = syntax
    ? appError("transport.invalid_request", {
        details: { reason: error.message },
      })
    : error;
  const normalized = normalizeError(cause, {
    ...presentation,
    locale: flags.locale ?? presentation.locale ?? "zh-CN",
  });
  const human =
    normalized.code +
    ": " +
    normalized.message +
    (normalized.details ? " " + JSON.stringify(normalized.details) : "");
  process.stderr.write(
    (flags.json ? JSON.stringify({ error: normalized }) : human) + "\n",
  );
  if (flags.debug) process.stderr.write(Bun.inspect(error) + "\n");
  if (syntax && !flags.json) process.stderr.write(program.helpInformation());
  return cliExitCode(normalized.code);
}
