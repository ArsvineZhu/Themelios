import { resolve } from "node:path";
import type { ApplicationApi } from "@themelios/application";
import {
  callOperation,
  type BinaryReadResult,
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

export function mountStandardCli(w: CliWiring<ApplicationApi>): void {
  const instance = w.program.commands.find(
    (command) => command.name() === "instance",
  );
  instance?.command("info").action(() => w.unary("instance.info", () => ({})));
  mountMaterials(w);
  mountResults(w);
  mountTasks(w);
  mountPrompts(w);
  mountConfiguration(w);
}

function mountMaterials(w: CliWiring<ApplicationApi>) {
  const { directory, program, cwd } = w;
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
      if (modes.filter(Boolean).length !== 1) {
        return cliInputError(
          "Choose exactly one of --file, --text, --stdin or --input.",
        );
      }
      const display =
        opts.name === undefined ? {} : { name: String(opts.name) };
      const declared =
        opts.mime === undefined ? {} : { mediaType: String(opts.mime) };
      if (opts.input !== undefined) {
        return w.unary("materials.accept", async (max) => ({
          ...objectCliInput(await readCliInput(opts.input, cwd, max)),
          ...display,
          ...declared,
        }));
      }
      w.permission("materials.accept");
      await w.session(async (api, ctx) => {
        const source =
          opts.file !== undefined
            ? { file: resolve(cwd, opts.file) }
            : opts.stdin
              ? { body: Bun.stdin.stream() }
              : {
                  body: new Blob([opts.text]).stream(),
                  mediaType: "text/plain",
                };
        await w.emit(
          await api.materials.accept(
            { ...source, ...declared, ...display },
            ctx.options,
          ),
          ctx.maxJsonBytes,
        );
      });
    });
  for (const op of ["inspect", "structure", "retain", "release"] as const) {
    material
      .command(op + " <ref>")
      .action((ref) => w.unary("materials." + op, () => ({ ref })));
  }
  material
    .command("sources <ref>")
    .option("--depth <count>", "maximum depth", nonnegativeInt)
    .action((ref, { depth }) =>
      w.unary("materials.sources", () => ({
        ref,
        ...(depth === undefined ? {} : { depth }),
      })),
    );
  material
    .command("list")
    .option("--at <cut>")
    .option("--after <ref>")
    .option("--limit <count>", "maximum items", nonnegativeInt)
    .action((opts) => w.unary("materials.list", () => opts));
  material
    .command("text [ref]")
    .option("--input <file|->")
    .action((ref, opts) =>
      w.unary("materials.text", (max) =>
        opts.input === undefined ? { ref } : readCliInput(opts.input, cwd, max),
      ),
    );
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
      w.permission("materials.read");
      await w.session(async (api, ctx) => {
        const mats = api.materials;
        await mats.export(
          mats.resolve(ref),
          resolve(cwd, destination),
          ctx.options,
        );
      });
    });
}

function mountResults<App>(w: CliWiring<App>) {
  const { program, cwd } = w;
  const result = program
    .command("result")
    .description("Save and reopen completed results");
  result
    .command("save")
    .requiredOption("--input <file|->")
    .action((opts) =>
      w.unary("results.save", (max) => readCliInput(opts.input, cwd, max)),
    );
  result
    .command("read <ref>")
    .action((ref) => w.unary("results.read", () => ({ ref })));
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
  task.command("list").action(() => w.unary("tasks.list", () => ({})));
  task
    .command("describe <task>")
    .action((id) => w.unary("tasks.describe", () => ({ task: id })));
  task
    .command("preview [task]")
    .requiredOption("--input <file|->")
    .action((id, opts) =>
      w.unary("tasks.preview", (max) => taskReq(id, opts.input, max)),
    );
  task
    .command("run-many")
    .requiredOption("--input <file|->")
    .action((opts) =>
      w.unary("tasks.runMany", (max) => readCliInput(opts.input, cwd, max)),
    );
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
        const max = ctx.maxJsonBytes;
        const payload = await taskReq(id, opts.input, max);
        if (opts.save) payload.persist = true;
        const publish =
          dest === undefined
            ? undefined
            : (value: unknown) =>
                publishOutput(dest, JSON.stringify(value) + "\n", value);
        if (!opts.stream) {
          const value = await callOperation(
            api,
            directory,
            "tasks.run",
            payload,
            ctx,
          );
          if (publish) return publish(value);
          const op = directory.get("tasks.run");
          const rendered =
            !w.isJson() && op?.present
              ? await op.present(value, api, ctx)
              : value;
          return w.emit(rendered, max);
        }
        const stream = callOperation(
          api,
          directory,
          "tasks.stream",
          payload,
          ctx,
        ) as Flow<unknown>;
        for await (const event of stream) {
          if (event.type === "result") await publish?.(event.value);
          if (w.isJson()) await w.emit(event, max);
          else if (event.type === "text-delta")
            await writeStdout(event.text, w.signal);
          else if (event.type === "result") await writeStdout("\n");
        }
      });
    });
}

function mountPrompts<App>(w: CliWiring<App>) {
  const { directory, program, cwd } = w;
  const prompt = program
    .command("prompt")
    .description("Read and edit task prompts");
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
  for (const action of ["describe", "diff"] as const) {
    prompt
      .command(action + " <task>")
      .action((task) => w.unary("prompts." + action, () => ({ task })));
  }
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

function mountConfiguration<App>(w: CliWiring<App>) {
  const { cwd, program } = w;
  const config = program
    .command("config")
    .description("Inspect or change effective configuration");
  config
    .command("describe [path]")
    .action((path) =>
      w.unary("configuration.describe", () => (path ? { path } : {})),
    );
  config
    .command("explain <path>")
    .action((path) => w.unary("configuration.explain", () => ({ path })));
  config
    .command("set [path] [json]")
    .option("--input <file|->", "read a JSON object with path and value")
    .action((path, value, opts) => {
      if (opts.input !== undefined && path === undefined) {
        return w.unary("configuration.set", (max) =>
          readCliInput(opts.input, cwd, max),
        );
      }
      if (
        opts.input === undefined &&
        path !== undefined &&
        value !== undefined
      ) {
        return w.unary("configuration.set", () => ({
          path,
          value: jsonCliInput(value),
        }));
      }
      return cliInputError(
        "Provide a setting path and JSON value, or use --input.",
      );
    });
  config
    .command("unset <path>")
    .action((path) => w.unary("configuration.unset", () => ({ path })));
  config
    .command("reload")
    .action(() => w.unary("configuration.reload", () => ({})));
}
