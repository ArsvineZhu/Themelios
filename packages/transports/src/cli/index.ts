import { resolve } from "node:path";
import {
  assertOperationPermission,
  callOperation,
  createOperations,
  type ApplicationApi,
  type OperationContext,
  type Principal,
} from "@themelios/application";
import type { MaterialRead } from "@themelios/content";
import {
  appError,
  parseJson,
  type CallOptions,
  type Flow,
  type Json,
} from "@themelios/core";
import {
  sessionMessage,
  type Installation,
  type Session,
} from "@themelios/runtime";
import { Command, CommanderError, InvalidArgumentError } from "commander";
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

export interface OfflineRequest {
  readonly action: "backup" | "restore" | "collect" | "verify" | "migrate";
  readonly instance: string;
  readonly installation?: string;
  readonly path?: string;
  readonly retainSince?: string;
  readonly signal?: AbortSignal;
}

export interface CliOptions<S> {
  readonly principal: Principal;
  readonly signal?: AbortSignal;
  readonly cwd?: string;
  readonly limits?: () => Readonly<TransportLimits>;
  readonly useInstallation?: (
    path: string,
  ) => Installation<ApplicationApi<S>, S>;
  readonly offline?: (request: OfflineRequest) => Promise<unknown>;
  readonly serve?: (
    session: Session<ApplicationApi<S>, S>,
    mode: "serve" | "stdio",
    signal?: AbortSignal,
  ) => Promise<void>;
}

function nonnegative(value: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number))
    throw new InvalidArgumentError("Expected a nonnegative integer.");
  return number;
}

function inputError(reason: string, cause?: unknown): never {
  throw appError("transport.invalid_request", { details: { reason }, cause });
}

function jsonInput(text: string): Json {
  try {
    return parseJson(JSON.parse(text));
  } catch (cause) {
    return inputError("Expected a valid JSON value", cause);
  }
}

function objectInput(input: Json): Record<string, Json> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return inputError("Expected a JSON object");
  return input;
}

async function readInput(
  path: string,
  cwd: string,
  maxBytes: number,
): Promise<Json> {
  if (path !== "-") {
    const file = Bun.file(resolve(cwd, path));
    if (file.size > maxBytes)
      throw appError("transport.request_too_large", {
        details: { maxJsonBytes: maxBytes },
      });
    return jsonInput(await file.text());
  }
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maxBytes)
        throw appError("transport.request_too_large", {
          details: { maxJsonBytes: maxBytes },
        });
      chunks.push(item.value);
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
  return jsonInput(Buffer.concat(chunks, size).toString("utf8"));
}

type GlobalOptions = {
  installation?: string;
  instance: string;
  json?: boolean;
  locale?: string;
  debug?: boolean;
  timeoutMs?: number;
};

export async function runCli<S>(
  installation: Installation<ApplicationApi<S>, S>,
  argv: readonly string[],
  options: CliOptions<S>,
): Promise<number> {
  const program = new Command("themelios")
    .description("Import materials, run tasks, and trace saved results.")
    .option("--installation <path>", "installation root")
    .option("--instance <name>", "instance name", "default")
    .option("--json", "machine-readable JSON or NDJSON")
    .option("--debug", "print the local error cause")
    .option("--locale <locale>", "message language")
    .option(
      "--timeout-ms <milliseconds>",
      "total operation timeout",
      nonnegative,
    )
    .exitOverride()
    .configureOutput({ writeErr: () => undefined });
  const cwd = options.cwd ?? process.cwd();
  let errorPresentation: ErrorPresentation = { local: true };
  const flags = () => program.opts<GlobalOptions>();
  const selected = (): Installation<ApplicationApi<S>, S> =>
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
  async function session<T>(
    work: (
      api: ApplicationApi<S>,
      ctx: OperationContext,
      opened: Session<ApplicationApi<S>, S>,
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
      translate: (key, params) => sessionMessage(opened, key, params, locale),
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
  async function unary(
    id: string,
    get: (max: number) => unknown | Promise<unknown>,
  ) {
    await session(async (api, ctx) => {
      const limit = ctx.maxJsonBytes ?? baseLimit();
      const data = await get(limit);
      await emit(
        await callOperation(createOperations(api), id, data, ctx),
        limit,
      );
    });
  }
  function permission(id: string, permission: "read" | "write" | "admin") {
    assertOperationPermission({ id, permission }, options.principal);
  }
  const instance = program
    .command("instance")
    .description("Initialize or inspect an instance");
  instance.command("init").action(async () => {
    permission("instance.init", "admin");
    await emit(await current().init());
  });
  instance
    .command("info")
    .action(async () => unary("instance.info", () => ({})));

  const material = program
    .command("material")
    .description("Import, read and trace materials");
  material
    .command("import")
    .option("--file <path>")
    .option("--text <text>")
    .option("--stdin")
    .option("--input <file|->")
    .option("--mime <type>")
    .option("--name <name>")
    .action(async (opts) => {
      const modes = [
        opts.file !== undefined,
        opts.text !== undefined,
        opts.stdin === true,
        opts.input !== undefined,
      ];
      if (modes.filter(Boolean).length !== 1)
        return inputError(
          "Choose exactly one of --file, --text, --stdin or --input.",
        );
      if (opts.input !== undefined)
        return unary("materials.accept", (max) =>
          readInput(opts.input, cwd, max),
        );
      permission("materials.accept", "write");
      await session(async (api, ctx) => {
        const display =
          opts.name === undefined ? {} : { name: opts.name as string };
        const media = opts.mime as string | undefined;
        const payload =
          opts.file !== undefined
            ? {
                file: resolve(cwd, opts.file),
                ...display,
                ...(media === undefined ? {} : { mediaType: media }),
              }
            : opts.stdin
              ? {
                  body: Bun.stdin.stream(),
                  mediaType: media ?? "application/octet-stream",
                  ...display,
                }
              : {
                  bytes: new TextEncoder().encode(opts.text),
                  mediaType: media ?? "text/plain",
                  ...display,
                };
        await emit(
          await api.materials.accept(payload, ctx.options),
          ctx.maxJsonBytes,
        );
      });
    });
  for (const operation of [
    "inspect",
    "structure",
    "retain",
    "release",
  ] as const) {
    material
      .command(operation + " <ref>")
      .action(async (ref) => unary("materials." + operation, () => ({ ref })));
  }
  material
    .command("sources <ref>")
    .option("--depth <count>", "maximum depth", nonnegative)
    .action(async (ref, { depth }) =>
      unary("materials.sources", () => ({
        ref,
        ...(depth === undefined ? {} : { depth }),
      })),
    );
  material
    .command("list")
    .option("--at <cut>")
    .option("--after <ref>")
    .option("--limit <count>", "maximum items", nonnegative)
    .action(async (opts) => unary("materials.list", () => opts));
  material
    .command("text [ref]")
    .option("--input <file|->")
    .action(async (ref, opts) =>
      unary("materials.text", (max) =>
        opts.input === undefined ? { ref } : readInput(opts.input, cwd, max),
      ),
    );
  material.command("read <ref>").action(async (ref) =>
    session(async (api, ctx) => {
      const response = (await callOperation(
        createOperations(api),
        "materials.read",
        { ref },
        ctx,
      )) as MaterialRead;
      await streamStdout(response.body, options.signal);
    }),
  );
  material
    .command("export <ref> <destination>")
    .action(async (ref, destination) => {
      permission("materials.read", "read");
      await session(async (api, ctx) => {
        await api.materials.export(ref, resolve(cwd, destination), ctx.options);
      });
    });

  const result = program
    .command("result")
    .description("Save and reopen completed results");
  result
    .command("save")
    .requiredOption("--input <file|->")
    .action(async (opts) =>
      unary("results.save", (max) => readInput(opts.input, cwd, max)),
    );
  result
    .command("read <ref>")
    .action(async (ref) => unary("results.read", () => ({ ref })));

  const task = program
    .command("task")
    .description("Inspect, preview and run model tasks");
  task.command("list").action(async () => unary("tasks.list", () => ({})));
  task
    .command("describe <task>")
    .action(async (id) => unary("tasks.describe", () => ({ task: id })));
  function request(task: string | undefined, path: string, max: number) {
    return readInput(path, cwd, max)
      .then(objectInput)
      .then((value) => (task === undefined ? value : { ...value, task }));
  }
  task
    .command("preview [task]")
    .requiredOption("--input <file|->")
    .action(async (id, opts) =>
      unary("tasks.preview", (max) => request(id, opts.input, max)),
    );
  task
    .command("run-many")
    .requiredOption("--input <file|->")
    .action(async (opts) =>
      unary("tasks.runMany", (max) => readInput(opts.input, cwd, max)),
    );
  task
    .command("run [task]")
    .requiredOption("--input <file|->")
    .option("--stream")
    .option("--save")
    .option("--output <file>")
    .action(async (id, opts) => {
      const destination =
        opts.output === undefined ? undefined : resolve(cwd, opts.output);
      if (destination !== undefined) await ensureNewFile(destination);
      await session(async (api, ctx) => {
        const max = ctx.maxJsonBytes ?? baseLimit();
        const wire = await request(id, opts.input, max);
        if (opts.save) wire.persist = true;
        const directory = createOperations(api);
        const deliver = async (value: unknown) => {
          if (destination !== undefined)
            await publishOutput(
              destination,
              jsonText(value, max) + "\n",
              value,
            );
          else await emit(value, max);
        };
        if (!opts.stream)
          return deliver(
            await callOperation(directory, "tasks.run", wire, ctx),
          );
        const stream = callOperation(
          directory,
          "tasks.stream",
          wire,
          ctx,
        ) as Flow<unknown>;
        for await (const event of stream) {
          if (event.type === "result" && destination !== undefined)
            await deliver(event.value);
          if (flags().json) await emit(event, max);
          else if (event.type === "text-delta")
            await writeStdout(event.text, options.signal);
          else if (event.type === "result") await writeStdout("\n");
        }
      });
    });

  const prompt = program
    .command("prompt")
    .description("Read and edit task prompts");
  prompt
    .command("read <task>")
    .option("--part <role>")
    .action(async (task, opts) => {
      if (opts.part === undefined)
        return unary("prompts.read", () => ({ task }));
      if (opts.part !== "user" && opts.part !== "system")
        return inputError("Use --part user or --part system.");
      await session(async (api, ctx) => {
        const templates = (await callOperation(
          createOperations(api),
          "prompts.read",
          { task },
          ctx,
        )) as Record<string, string>;
        const text = templates[opts.part]!;
        if (flags().json) await emit(text, ctx.maxJsonBytes);
        else await writeStdout(text);
      });
    });
  for (const action of ["describe", "diff"] as const) {
    prompt
      .command(action + " <task>")
      .action(async (task) => unary("prompts." + action, () => ({ task })));
  }
  prompt
    .command("edit <task>")
    .requiredOption("--file <path>")
    .requiredOption("--part <role>")
    .action(async (task, opts) =>
      unary("prompts.setOverride", async (max) => {
        const file = Bun.file(resolve(cwd, opts.file));
        if (file.size > max)
          throw appError("transport.request_too_large", {
            details: { maxJsonBytes: max },
          });
        return { task, role: opts.part, template: await file.text() };
      }),
    );
  prompt
    .command("reset <task>")
    .option("--part <role>")
    .action(async (task, opts) =>
      unary("prompts.reset", () => ({
        task,
        ...(opts.part === undefined ? {} : { role: opts.part }),
      })),
    );

  const config = program
    .command("config")
    .description("Inspect or change effective configuration");
  config
    .command("describe [path]")
    .action(async (path) =>
      unary("configuration.describe", () => (path ? { path } : {})),
    );
  config
    .command("explain <path>")
    .action(async (path) => unary("configuration.explain", () => ({ path })));
  config
    .command("set <path> <json>")
    .action(async (path, value) =>
      unary("configuration.set", () => ({ path, value: jsonInput(value) })),
    );
  config
    .command("unset <path>")
    .action(async (path) => unary("configuration.unset", () => ({ path })));
  config
    .command("reload")
    .action(async () => unary("configuration.reload", () => ({})));

  const storage = program
    .command("storage")
    .description("Maintain an offline instance");
  async function offline(
    action: OfflineRequest["action"],
    path?: string,
    retainSince?: string,
  ) {
    permission("storage." + action, "admin");
    if (!options.offline)
      throw appError("runtime.invalid_operation", {
        details: { operation: "storage." + action },
      });
    const root = flags().installation;
    await emit(
      await options.offline({
        action,
        instance: flags().instance,
        ...(root === undefined ? {} : { installation: resolve(cwd, root) }),
        ...(path === undefined ? {} : { path: resolve(cwd, path) }),
        ...(retainSince === undefined ? {} : { retainSince }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    );
  }
  storage
    .command("backup <destination>")
    .action(async (path) => offline("backup", path));
  storage
    .command("restore <backup>")
    .action(async (path) => offline("restore", path));
  storage
    .command("collect")
    .option("--retain-since <cut>")
    .action(async (opts) => offline("collect", undefined, opts.retainSince));
  storage.command("verify").action(async () => offline("verify"));
  storage.command("migrate").action(async () => offline("migrate"));
  for (const entry of ["serve", "mcp"] as const) {
    program.command(entry).action(async () => {
      if (!options.serve)
        throw appError("runtime.invalid_operation", {
          details: { operation: entry },
        });
      await session((_api, _ctx, opened) =>
        options.serve!(
          opened,
          entry === "mcp" ? "stdio" : "serve",
          options.signal,
        ),
      );
    });
  }
  return dispatch(program, argv, () => errorPresentation);
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
