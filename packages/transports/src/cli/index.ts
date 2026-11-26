import { resolve } from "node:path";
import {
  assertOperationPermission,
  callOperation,
  standardPermission,
  type AnyOperation,
  type OperationContext,
  type OperationOutcome,
  type Permission,
  type Principal,
} from "@themelios/runtime/operations";
import { appError, openCall, type CallOptions } from "@themelios/core";
import type { Installation, Session } from "@themelios/runtime";
import { defaultLocale } from "@themelios/runtime/locales";
import { Command, CommanderError } from "commander";
import { resolveDirectory } from "../directory.js";
import {
  cliExitCode,
  normalizeError,
  type ErrorPresentation,
} from "../errors.js";
import { defaultMaxJsonBytes, jsonText } from "../json.js";
import type { TransportLimits } from "../types.js";
import {
  ensureNewFile,
  publishOutput,
  streamStdout,
  writeStdout,
} from "./output.js";
import { nonnegativeInt, readCliInput } from "./input.js";
export {
  cliInputError,
  jsonCliInput,
  nonnegativeInt,
  objectCliInput,
  readCliInput,
} from "./input.js";
export { writeStdout } from "./output.js";

export interface CliWiring<App> {
  readonly program: Command;
  readonly cwd: string;
  readonly signal: AbortSignal | undefined;
  isJson(): boolean;
  emit(value: unknown, max?: number): Promise<void>;
  permission(id: string): void;
  session<T>(
    work: (
      api: App,
      ctx: OperationContext & { maxJsonBytes: number },
    ) => Promise<T>,
  ): Promise<T>;
  /** Invokes an operation and delivers stdout or publishes its final JSON result to a new file. */
  invoke(
    id: string,
    get: (max: number) => unknown | Promise<unknown>,
    options?: { output?: string },
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

export const cliServeMode = Object.freeze({
  serve: "serve",
  stdio: "stdio",
} as const);

export type CliServeMode = (typeof cliServeMode)[keyof typeof cliServeMode];

export interface CliOptions<App = unknown, S = unknown> {
  readonly name?: string;
  readonly description?: string;
  readonly principal: Principal;
  readonly operations: readonly AnyOperation<App>[];
  readonly signal?: AbortSignal;
  readonly cwd?: string;
  readonly limits?: (session: Session<App, S>) => Readonly<TransportLimits>;
  readonly useInstallation?: (path: string) => Installation<App, S>;
  readonly configure?: (wiring: CliWiring<App>) => void;
  readonly mountOperationCommands?: boolean;
  readonly offline?: (request: OfflineRequest) => Promise<unknown>;
  readonly serve?: (
    session: Session<App, S>,
    mode: CliServeMode,
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
  const program = new Command(options.name ?? "application").description(
    options.description ?? "Application commands.",
  );
  if (options.useInstallation)
    program.option("--installation <path>", "installation root");
  program
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
  const emit = (value: unknown, max = defaultMaxJsonBytes) =>
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
    const locale = flags().locale ?? opened.locale;
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
            options.limits?.(opened).maxJsonBytes ?? defaultMaxJsonBytes,
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
    outcome: Extract<OperationOutcome, { kind: "stream" }>,
    ctx: OperationContext & { maxJsonBytes: number },
    output?: string,
  ) {
    const json = flags().json;
    const limit = ctx.maxJsonBytes;
    let wroteText = false;
    for await (const event of outcome.flow) {
      if (event.type === "result" && output !== undefined)
        await publishOutput(output, event.value);
      if (json) await emit(event, limit);
      else if (event.type === "text-delta") {
        await writeStdout(event.text, ctx.options.signal);
        wroteText = true;
      } else if (event.type === "result")
        await finishTextStream(outcome, event.value, ctx, wroteText, output);
    }
  }

  async function finishTextStream(
    outcome: Extract<OperationOutcome, { kind: "stream" }>,
    value: unknown,
    ctx: OperationContext & { maxJsonBytes: number },
    wroteText: boolean,
    output?: string,
  ) {
    const text =
      output === undefined ? await outcome.present(value) : undefined;
    if (text !== undefined) await emit(text, ctx.maxJsonBytes);
    else if (wroteText) await writeStdout("\n", ctx.options.signal);
    else if (output === undefined) await emit(value, ctx.maxJsonBytes);
  }

  const invoke: CliWiring<App>["invoke"] = async (
    id: string,
    get: (max: number) => unknown | Promise<unknown>,
    invocation = {},
  ) => {
    const { output } = invocation;
    if (output !== undefined) await ensureNewFile(output);
    await runSession(async (api, ctx) => {
      const limit = ctx.maxJsonBytes;
      const data = await get(limit);
      const outcome = callOperation(
        api,
        directory,
        id,
        data,
        ctx,
        output === undefined ? undefined : { accepts: ["unary", "stream"] },
      );
      if (outcome.kind === "stream") return printFlow(outcome, ctx, output);
      if (outcome.kind === "binary-read") {
        return streamStdout((await outcome.result).body, ctx.options.signal);
      }
      const value = await outcome.result;
      if (output !== undefined) return publishOutput(output, value);
      const text = flags().json ? undefined : await outcome.present();
      await emit(text ?? value, limit);
    });
  };

  const wiring: CliWiring<App> = {
    program,
    cwd,
    signal: options.signal,
    isJson: () => Boolean(flags().json),
    emit,
    permission(id) {
      const operation = directory.get(id);
      if (!operation)
        throw appError("transport.not_found", { details: { operation: id } });
      assertOperationPermission(operation, options.principal);
    },
    session: (work) => runSession((api, ctx) => work(api, ctx)),
    invoke,
  };
  program
    .command("instance")
    .description("Initialize or inspect an instance")
    .command("init")
    .action(async () => {
      permission("instance.init", standardPermission.admin);
      await emit(await current().init());
    });
  options.configure?.(wiring);

  if (options.offline) {
    const storage = program
      .command("storage")
      .description("Maintain an offline instance");
    const offline = async (
      action: OfflineRequest["action"],
      path?: string,
      retainSince?: string,
    ) => {
      permission("storage." + action, standardPermission.admin);
      const root = flags().installation;
      const call = openCall("storage." + action, localOptions());
      try {
        const result = await options.offline!({
          action,
          instance: flags().instance,
          ...(root === undefined ? {} : { installation: resolve(cwd, root) }),
          ...(path === undefined ? {} : { path: resolve(cwd, path) }),
          ...(retainSince === undefined ? {} : { retainSince }),
          signal: call.signal,
        });
        await emit(result);
      } finally {
        call.close();
      }
    };
    storage.command("backup <destination>").action((p) => offline("backup", p));
    storage.command("restore <backup>").action((p) => offline("restore", p));
    storage
      .command("collect")
      .option("--retain-since <cut>")
      .action((opts) => offline("collect", undefined, opts.retainSince));
    storage.command("verify").action(() => offline("verify"));
  }

  const serve = options.serve;
  if (serve) {
    const commands = {
      [cliServeMode.serve]: cliServeMode.serve,
      mcp: cliServeMode.stdio,
    };
    for (const [command, mode] of Object.entries(commands)) {
      program.command(command).action(async () => {
        await runSession((_api, _ctx, opened) =>
          serve(opened, mode, options.signal),
        );
      });
    }
  }

  if (options.mountOperationCommands !== false) {
    try {
      mountCustomOperations(program, directory, cwd, invoke);
    } catch (error) {
      try {
        program.parseOptions([...argv]);
      } catch {
        // Report the configuration error that prevented command registration.
      }
      return reportFailure(program, error, errorPresentation);
    }
  }

  return dispatch(program, argv, () => errorPresentation);
}

function registerOperationCommand(
  parent: Command,
  declaration: string,
  operation: string,
): Command {
  const name = declaration.trim().split(/\s+/, 1)[0]!;
  if (
    parent.commands.some(
      (command) => command.name() === name || command.aliases().includes(name),
    )
  ) {
    throw appError("config.invalid", {
      details: {
        reason: "duplicate_cli_command",
        command: parent.parent ? `${parent.name()} ${name}` : name,
        operation,
      },
    });
  }
  return parent.command(declaration);
}

function mountCustomOperations<App>(
  program: Command,
  directory: ReturnType<typeof resolveDirectory<App>>,
  cwd: string,
  invoke: CliWiring<App>["invoke"],
) {
  const groups = new Map(
    program.commands
      .filter((command) => command.commands.length)
      .map((command) => [command.name(), command]),
  );
  for (const op of directory.values()) {
    if (op.cli === null) continue;
    if (op.cli) {
      const cmd = registerOperationCommand(
        program,
        op.cli.command,
        op.id,
      ).description(op.cli.description ?? op.description);
      for (const opt of op.cli.options ?? []) {
        cmd.option(opt.flags, opt.description);
      }
      const spec = op.cli;
      cmd.action((...actionArgs: unknown[]) => {
        const opts = (actionArgs.at(-2) ?? {}) as Record<string, unknown>;
        const args = actionArgs
          .slice(0, -2)
          .map((a) => (a === undefined ? undefined : String(a)));
        return invoke(op.id, async (max) =>
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
      group = registerOperationCommand(program, groupName, op.id);
      groups.set(groupName, group);
    }
    registerOperationCommand(group, actionName, op.id)
      .description(op.description)
      .option("--input <file|->")
      .action((opts) =>
        invoke(op.id, (max) =>
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
    locale: flags.locale ?? presentation.locale ?? defaultLocale,
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
