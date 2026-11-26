import { resolve } from "node:path";
import {
  taskOperationIds,
  promptOperationIds,
  type ApplicationApi,
} from "@themelios/application";
import { materialOperationIds, resultOperationIds } from "@themelios/content";
import {
  configurationOperationIds,
  instanceOperationIds,
} from "@themelios/runtime/operations";
import { appError } from "@themelios/core";
import { promptRoleSchema } from "@themelios/models";
import {
  cliInputError,
  jsonCliInput,
  nonnegativeInt,
  objectCliInput,
  readCliInput,
  writeStdout,
  type CliWiring,
} from "@themelios/transports/cli";

export function mountStandardCli(w: CliWiring<ApplicationApi>): void {
  const instance = w.program.commands.find(
    (command) => command.name() === "instance",
  );
  instance
    ?.command("info")
    .action(() => w.invoke(instanceOperationIds.info, () => ({})));
  mountMaterials(w);
  mountResults(w);
  mountTasks(w);
  mountPrompts(w);
  mountConfiguration(w);
}

function mountMaterials(w: CliWiring<ApplicationApi>) {
  const { program, cwd } = w;
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
        return w.invoke(materialOperationIds.accept, async (max) => ({
          ...objectCliInput(await readCliInput(opts.input, cwd, max)),
          ...display,
          ...declared,
        }));
      }
      w.permission(materialOperationIds.accept);
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
      .action((ref) => w.invoke(materialOperationIds[op], () => ({ ref })));
  }
  material
    .command("sources <ref>")
    .option("--depth <count>", "maximum depth", nonnegativeInt)
    .action((ref, { depth }) =>
      w.invoke(materialOperationIds.sources, () => ({
        ref,
        ...(depth === undefined ? {} : { depth }),
      })),
    );
  material
    .command("list")
    .option("--at <cut>")
    .option("--after <ref>")
    .option("--limit <count>", "maximum items", nonnegativeInt)
    .action((opts) => w.invoke(materialOperationIds.listRetained, () => opts));
  material
    .command("text [ref]")
    .option("--input <file|->")
    .action((ref, opts) =>
      w.invoke(materialOperationIds.text, (max) =>
        opts.input === undefined ? { ref } : readCliInput(opts.input, cwd, max),
      ),
    );
  material
    .command("read <ref>")
    .action((ref) => w.invoke(materialOperationIds.read, () => ({ ref })));
  material
    .command("export <ref> <destination>")
    .action(async (ref, destination) => {
      w.permission(materialOperationIds.read);
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
      w.invoke(resultOperationIds.save, (max) =>
        readCliInput(opts.input, cwd, max),
      ),
    );
  result
    .command("read <ref>")
    .action((ref) => w.invoke(resultOperationIds.read, () => ({ ref })));
}

function mountTasks<App>(w: CliWiring<App>) {
  const { program, cwd } = w;
  const task = program
    .command("task")
    .description("Inspect, preview and run model tasks");
  const taskReq = (id: string | undefined, path: string, max: number) =>
    readCliInput(path, cwd, max)
      .then(objectCliInput)
      .then((value) => (id === undefined ? value : { ...value, task: id }));
  task
    .command("list")
    .action(() => w.invoke(taskOperationIds.list, () => ({})));
  task
    .command("describe <task>")
    .action((id) => w.invoke(taskOperationIds.describe, () => ({ task: id })));
  task
    .command("preview [task]")
    .requiredOption("--input <file|->")
    .action((id, opts) =>
      w.invoke(taskOperationIds.preview, (max) => taskReq(id, opts.input, max)),
    );
  task
    .command("run-many")
    .requiredOption("--input <file|->")
    .action((opts) =>
      w.invoke(taskOperationIds.runMany, (max) =>
        readCliInput(opts.input, cwd, max),
      ),
    );
  task
    .command("run [task]")
    .requiredOption("--input <file|->")
    .option("--stream")
    .option("--save")
    .option("--output <file>")
    .action((id, opts) =>
      w.invoke(
        opts.stream ? taskOperationIds.stream : taskOperationIds.run,
        async (max) => {
          const request = await taskReq(id, opts.input, max);
          return opts.save ? { ...request, persist: true } : request;
        },
        opts.output === undefined
          ? undefined
          : { output: resolve(cwd, opts.output) },
      ),
    );
}

function mountPrompts(w: CliWiring<ApplicationApi>) {
  const { program, cwd } = w;
  const prompt = program
    .command("prompt")
    .description("Read and edit task prompts");
  prompt
    .command("read <task>")
    .option("--part <role>")
    .action(async (task, opts) => {
      if (opts.part === undefined)
        return w.invoke(promptOperationIds.read, () => ({ task }));
      const role = promptRoleSchema.safeParse(opts.part);
      if (!role.success)
        return cliInputError(
          "Choose " + promptRoleSchema.options.join(" or ") + " for --part.",
        );
      w.permission(promptOperationIds.read);
      await w.session(async (api, ctx) => {
        const text = (await api.prompts.read(task))[role.data];
        if (w.isJson()) await w.emit(text, ctx.maxJsonBytes);
        else await writeStdout(text);
      });
    });
  for (const action of ["describe", "diff"] as const) {
    prompt
      .command(action + " <task>")
      .action((task) => w.invoke(promptOperationIds[action], () => ({ task })));
  }
  prompt
    .command("edit <task>")
    .requiredOption("--file <path>")
    .requiredOption("--part <role>")
    .action((task, opts) =>
      w.invoke(promptOperationIds.setOverride, async (max) => {
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
      w.invoke(promptOperationIds.reset, () => ({
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
      w.invoke(configurationOperationIds.describe, () =>
        path ? { path } : {},
      ),
    );
  config
    .command("explain <path>")
    .action((path) =>
      w.invoke(configurationOperationIds.explain, () => ({ path })),
    );
  config
    .command("set [path] [json]")
    .option("--input <file|->", "read a JSON object with path and value")
    .action((path, value, opts) => {
      if (opts.input !== undefined && path === undefined) {
        return w.invoke(configurationOperationIds.set, (max) =>
          readCliInput(opts.input, cwd, max),
        );
      }
      if (
        opts.input === undefined &&
        path !== undefined &&
        value !== undefined
      ) {
        return w.invoke(configurationOperationIds.set, () => ({
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
    .action((path) =>
      w.invoke(configurationOperationIds.unset, () => ({ path })),
    );
  config
    .command("reload")
    .action(() => w.invoke(configurationOperationIds.reload, () => ({})));
}
