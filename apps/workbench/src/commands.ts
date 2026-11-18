import { basename, resolve } from "node:path";
import {
  callOperation,
  type BinaryReadResult,
  type OperationDirectory,
} from "@themelios/runtime/operations";
import { appError, type Flow } from "@themelios/core";
import {
  cliInputError,
  jsonCliInput,
  nonnegativeInt,
  objectCliInput,
  readCliInput,
  ensureNewFile,
  publishOutput,
  streamStdout,
  writeStdout,
  type CliWiring,
} from "@themelios/transports/cli";

function rawMaterialInput<App>(directory: OperationDirectory<App>) {
  const routes = directory.get("materials.accept")?.http;
  if (!routes) return;
  return (Array.isArray(routes) ? routes : [routes]).find(
    (route) => route.binaryInput,
  )?.binaryInput;
}

export function mountStandardCli<App>(w: CliWiring<App>): void {
  mountMaterials(w);
  mountResults(w);
  mountTasks(w);
  mountPrompts(w);
  mountConfiguration(w);
}

function mountMaterials<App>(w: CliWiring<App>) {
  const { directory, program, cwd } = w;
  const material = program
    .command("material")
    .description("Import, read and trace materials");
  if (directory.has("materials.accept")) {
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
        if (modes.filter(Boolean).length !== 1) {
          return cliInputError(
            "Choose exactly one of --file, --text, --stdin or --input.",
          );
        }
        if (opts.input !== undefined) {
          return w.unary("materials.accept", (max) =>
            readCliInput(opts.input, cwd, max),
          );
        }
        w.permission("materials.accept", "write");
        await w.session(async (api, ctx) => {
          const display =
            opts.name === undefined ? {} : { name: String(opts.name) };
          const media = opts.mime as string | undefined;
          const file =
            opts.file === undefined
              ? undefined
              : Bun.file(resolve(cwd, opts.file));
          const payload = {
            body:
              file?.stream() ??
              (opts.stdin
                ? Bun.stdin.stream()
                : new Blob([opts.text]).stream()),
            mediaType:
              media ??
              (file?.type.split(";")[0] ||
                (opts.text === undefined
                  ? "application/octet-stream"
                  : "text/plain")),
            ...(opts.file !== undefined ? { name: basename(opts.file) } : {}),
            ...display,
          };
          await w.emit(
            await callOperation(
              api,
              directory,
              "materials.accept",
              payload,
              ctx,
              rawMaterialInput(directory),
            ),
            ctx.maxJsonBytes,
          );
        });
      });
  }
  for (const op of ["inspect", "structure", "retain", "release"] as const) {
    if (directory.has("materials." + op)) {
      material
        .command(op + " <ref>")
        .action((ref) => w.unary("materials." + op, () => ({ ref })));
    }
  }
  if (directory.has("materials.sources")) {
    material
      .command("sources <ref>")
      .option("--depth <count>", "maximum depth", nonnegativeInt)
      .action((ref, { depth }) =>
        w.unary("materials.sources", () => ({
          ref,
          ...(depth === undefined ? {} : { depth }),
        })),
      );
  }
  if (directory.has("materials.list")) {
    material
      .command("list")
      .option("--at <cut>")
      .option("--after <ref>")
      .option("--limit <count>", "maximum items", nonnegativeInt)
      .action((opts) => w.unary("materials.list", () => opts));
  }
  if (directory.has("materials.text")) {
    material
      .command("text [ref]")
      .option("--input <file|->")
      .action((ref, opts) =>
        w.unary("materials.text", (max) =>
          opts.input === undefined
            ? { ref }
            : readCliInput(opts.input, cwd, max),
        ),
      );
  }
  if (directory.has("materials.read")) {
    material.command("read <ref>").action((ref) =>
      w.session(async (api, ctx) => {
        const res = (await callOperation(
          api,
          directory,
          "materials.read",
          { ref },
          ctx,
        )) as BinaryReadResult;
        await streamStdout(res.body, w.signal);
      }),
    );
    material
      .command("export <ref> <destination>")
      .action(async (ref, destination) => {
        w.permission("materials.read", "read");
        await w.session(async (api, ctx) => {
          const mats = (
            api as {
              materials?: {
                resolve?(id: string): string;
                export?(
                  id: string,
                  dest: string,
                  opts?: unknown,
                ): Promise<void>;
              };
            }
          ).materials;
          if (!mats?.export) {
            throw appError("runtime.invalid_operation", {
              details: { operation: "materials.export" },
            });
          }
          const resolved = mats.resolve ? mats.resolve(ref) : ref;
          await mats.export(resolved, resolve(cwd, destination), ctx.options);
        });
      });
  }
}

function mountResults<App>(w: CliWiring<App>) {
  const { directory, program, cwd } = w;
  const result = program
    .command("result")
    .description("Save and reopen completed results");
  if (directory.has("results.save")) {
    result
      .command("save")
      .requiredOption("--input <file|->")
      .action((opts) =>
        w.unary("results.save", (max) => readCliInput(opts.input, cwd, max)),
      );
  }
  if (directory.has("results.read")) {
    result
      .command("read <ref>")
      .action((ref) => w.unary("results.read", () => ({ ref })));
  }
}

function mountTasks<App>(w: CliWiring<App>) {
  const { directory, program, cwd } = w;
  const task = program
    .command("task")
    .description("Inspect, preview and run model tasks");
  const taskReq = (id: string | undefined, path: string, max: number) =>
    readCliInput(path, cwd, max)
      .then(objectCliInput)
      .then((value) => (id === undefined ? value : { ...value, task: id }));
  if (directory.has("tasks.list")) {
    task.command("list").action(() => w.unary("tasks.list", () => ({})));
  }
  if (directory.has("tasks.describe")) {
    task
      .command("describe <task>")
      .action((id) => w.unary("tasks.describe", () => ({ task: id })));
  }
  if (directory.has("tasks.preview")) {
    task
      .command("preview [task]")
      .requiredOption("--input <file|->")
      .action((id, opts) =>
        w.unary("tasks.preview", (max) => taskReq(id, opts.input, max)),
      );
  }
  if (directory.has("tasks.runMany")) {
    task
      .command("run-many")
      .requiredOption("--input <file|->")
      .action((opts) =>
        w.unary("tasks.runMany", (max) => readCliInput(opts.input, cwd, max)),
      );
  }
  if (directory.has("tasks.run")) {
    task
      .command("run [task]")
      .requiredOption("--input <file|->")
      .option("--stream")
      .option("--save")
      .option("--output <file>")
      .action(async (id, opts) => {
        const dest =
          opts.output === undefined ? undefined : resolve(cwd, opts.output);
        if (dest !== undefined) await ensureNewFile(dest);
        await w.session(async (api, ctx) => {
          const max = ctx.maxJsonBytes ?? w.baseLimit();
          const payload = await taskReq(id, opts.input, max);
          if (opts.save) payload.persist = true;
          const deliver = async (value: unknown) => {
            if (dest !== undefined) {
              await publishOutput(dest, JSON.stringify(value) + "\n", value);
              return;
            }
            const op = directory.get("tasks.run");
            const rendered =
              !w.isJson() && op?.present
                ? await op.present(value, api, ctx)
                : value;
            await w.emit(rendered, max);
          };
          if (!opts.stream) {
            return deliver(
              await callOperation(api, directory, "tasks.run", payload, ctx),
            );
          }
          const stream = callOperation(
            api,
            directory,
            "tasks.stream",
            payload,
            ctx,
          ) as Flow<{ type: string; text?: string; value?: unknown }>;
          for await (const event of stream) {
            if (event.type === "result" && dest !== undefined)
              await deliver(event.value);
            if (w.isJson()) await w.emit(event, max);
            else if (event.type === "text-delta")
              await writeStdout(event.text ?? "", w.signal);
            else if (event.type === "result") await writeStdout("\n");
          }
        });
      });
  }
}

function mountPrompts<App>(w: CliWiring<App>) {
  const { directory, program, cwd } = w;
  const prompt = program
    .command("prompt")
    .description("Read and edit task prompts");
  if (directory.has("prompts.read")) {
    prompt
      .command("read <task>")
      .option("--part <role>")
      .action(async (task, opts) => {
        if (opts.part === undefined)
          return w.unary("prompts.read", () => ({ task }));
        if (opts.part !== "user" && opts.part !== "system") {
          return cliInputError("Use --part user or --part system.");
        }
        await w.session(async (api, ctx) => {
          const templates = (await callOperation(
            api,
            directory,
            "prompts.read",
            { task },
            ctx,
          )) as Record<string, string>;
          const text = templates[opts.part]!;
          if (w.isJson()) await w.emit(text, ctx.maxJsonBytes);
          else await writeStdout(text);
        });
      });
  }
  for (const action of ["describe", "diff"] as const) {
    if (directory.has("prompts." + action)) {
      prompt
        .command(action + " <task>")
        .action((task) => w.unary("prompts." + action, () => ({ task })));
    }
  }
  if (directory.has("prompts.setOverride")) {
    prompt
      .command("edit <task>")
      .requiredOption("--file <path>")
      .requiredOption("--part <role>")
      .action((task, opts) =>
        w.unary("prompts.setOverride", async (max) => {
          const file = Bun.file(resolve(cwd, opts.file));
          if (file.size > max) {
            throw appError("transport.request_too_large", {
              details: { maxJsonBytes: max },
            });
          }
          return { task, role: opts.part, template: await file.text() };
        }),
      );
  }
  if (directory.has("prompts.reset")) {
    prompt
      .command("reset <task>")
      .option("--part <role>")
      .action((task, opts) =>
        w.unary("prompts.reset", () => ({
          task,
          ...(opts.part === undefined ? {} : { role: opts.part }),
        })),
      );
  }
}

function mountConfiguration<App>(w: CliWiring<App>) {
  const { directory, program } = w;
  const config = program
    .command("config")
    .description("Inspect or change effective configuration");
  if (directory.has("configuration.describe")) {
    config
      .command("describe [path]")
      .action((path) =>
        w.unary("configuration.describe", () => (path ? { path } : {})),
      );
  }
  if (directory.has("configuration.explain")) {
    config
      .command("explain <path>")
      .action((path) => w.unary("configuration.explain", () => ({ path })));
  }
  if (directory.has("configuration.set")) {
    config.command("set <path> <json>").action((path, value) =>
      w.unary("configuration.set", () => ({
        path,
        value: jsonCliInput(value),
      })),
    );
  }
  if (directory.has("configuration.unset")) {
    config
      .command("unset <path>")
      .action((path) => w.unary("configuration.unset", () => ({ path })));
  }
  if (directory.has("configuration.reload")) {
    config
      .command("reload")
      .action(() => w.unary("configuration.reload", () => ({})));
  }
}
