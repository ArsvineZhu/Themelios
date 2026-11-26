import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { appError, type Json, parseJson, parseValue } from "@themelios/core";
import { Liquid, type FS, type Template } from "liquidjs";
import PQueue from "p-queue";
import writeFileAtomic from "write-file-atomic";
import {
  deliveredDescription,
  extentDescription,
  rangeDescription,
} from "./delivery.js";
import {
  modelNameSchema,
  outputSchema,
  promptRoleSchema,
  sourceEntrySchema,
} from "./schema.js";
import { taskInputJsonSchema } from "./task-definition.js";
import type {
  CompiledPrompt,
  PromptDescription,
  PromptDiff,
  PromptFileInfo,
  Prompts,
  PromptTemplates,
  SourceEntries,
  TaskDefinition,
  TaskTemplates,
} from "./types.js";

export * from "./types.js";
export { sourceEntrySchema };

type Role = PromptFileInfo["role"];
const roles = promptRoleSchema.options;
type Task<I extends Json, O extends Json, RawI> = TaskDefinition<I, O, RawI>;
type PromptOwner = { readonly id: string; readonly templates: TaskTemplates };

interface CachedParse {
  readonly text: string;
  readonly parsed: Template[];
}

function contains(root: string, file: string): boolean {
  const path = relative(root, file);
  return path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
}

function templatePath(root: string, name: string): string {
  const file = resolve(root, name);
  if (isAbsolute(name) || !contains(root, file) || file === root) {
    throw appError("prompt.invalid_template", {
      details: {
        template: name,
        reason: "Template path is outside the task resources",
      },
    });
  }
  return file;
}

function absent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function promptError(cause: unknown, task: string, path: string): never {
  const error = cause as {
    originalError?: Error;
    message?: string;
    token?: { getPosition?: () => [number, number]; file?: string };
  } | null;
  const pos = error?.token?.getPosition?.();
  throw appError("prompt.invalid_template", {
    details: {
      task,
      template: error?.token?.file ?? path,
      ...(pos === undefined ? {} : { line: pos[0], column: pos[1] }),
      reason: (
        error?.originalError?.message ??
        error?.message ??
        "Liquid template failed"
      )
        .split(/\r?\n/)[0]!
        .slice(0, 240),
    },
    cause,
  });
}

function templateVariables<I extends Json, O extends Json, RawI>(
  task: Task<I, O, RawI>,
  role: Role,
  variables: I,
  sources: SourceEntries,
): Record<string, Json> {
  if (role === "system")
    return {
      task: {
        id: task.id,
        title: task.title,
        purpose: task.purpose,
        titleKey: task.titleKey,
        purposeKey: task.purposeKey,
      },
      examples: parseJson(task.examples),
    };
  if (
    variables === null ||
    typeof variables !== "object" ||
    Array.isArray(variables)
  ) {
    throw appError("input.invalid", {
      details: {
        issues: [{ path: ["variables"], reason: "Expected an object" }],
      },
    });
  }
  return { ...variables, sources: parseJson(sources.entries) };
}

export function createPrompts(
  options: {
    resourceRoot?: string;
    overrideRoot?: string;
    locale?: string;
  } = {},
): Prompts {
  const resourceRoot =
    options.resourceRoot === undefined
      ? undefined
      : resolve(options.resourceRoot);
  const overrideRoot =
    options.overrideRoot === undefined
      ? undefined
      : resolve(options.overrideRoot);
  const edits = new PQueue({ concurrency: 1 });
  const astCache = new Map<string, CachedParse>();
  const inlineCache = new Map<string, Template[]>();
  const engines = new Map<string, Liquid>();

  function roots({ id, templates }: PromptOwner) {
    parseValue(modelNameSchema, id, "input.invalid");
    const declaredRoot =
      "resourceRoot" in templates ? templates.resourceRoot : undefined;
    const selectedRoot = declaredRoot ? resolve(declaredRoot) : resourceRoot;
    return {
      base: selectedRoot ? join(selectedRoot, id) : undefined,
      override: overrideRoot ? join(overrideRoot, id) : undefined,
    };
  }

  async function accessible(root: string, path: string): Promise<boolean> {
    if (!contains(root, path)) return false;
    const target = await realpath(path).catch((error) => {
      if (absent(error)) return undefined;
      throw error;
    });
    if (!target) return false;
    const directory = await realpath(root);
    const parent = await realpath(dirname(root));
    return contains(directory, target) && contains(parent, directory);
  }

  function engineFor(task: PromptOwner): Liquid {
    const { base, override } = roots(task);
    const key = `${task.id}\0${base ?? ""}`;
    const existing = engines.get(key);
    if (existing) return existing;
    const searchRoots = [override, base].filter(
      (root): root is string => root !== undefined,
    );
    const rootFor = (path: string) =>
      searchRoots.find((root) => contains(root, path));
    const fs: FS = {
      async exists(path) {
        const root = rootFor(path);
        return root !== undefined && (await accessible(root, path));
      },
      existsSync: () => false,
      async readFile(path) {
        if (!(await fs.exists(path)))
          throw new Error("Template resource unavailable");
        return readFile(path, "utf8");
      },
      readFileSync: () => {
        throw new Error("Use asynchronous template rendering");
      },
      resolve: (root, file, ext) =>
        resolve(root, file + (ext && !file.endsWith(ext) ? ext : "")),
      contains: accessible,
      dirname,
      sep,
    };
    const engine = new Liquid({
      root: searchRoots,
      partials: searchRoots,
      layouts: searchRoots,
      fs,
      strictVariables: true,
      strictFilters: true,
      ownPropertyOnly: true,
      lenientIf: true,
    });
    engine.registerFilter("extent", extentDescription);
    engine.registerFilter("range", rangeDescription);
    engine.registerFilter("delivery", deliveredDescription);
    engines.set(key, engine);
    return engine;
  }

  async function readTemplates(
    root: string | undefined,
    names: readonly string[],
  ) {
    const files = new Map<string, string>();
    if (!root) return files;
    for (const name of names) {
      const path = templatePath(root, name);
      if (await accessible(root, path))
        files.set(path, await readFile(path, "utf8"));
    }
    return files;
  }

  async function load<I extends Json, O extends Json, RawI>(
    task: Task<I, O, RawI>,
  ) {
    const { base, override } = roots(task);
    const engine = engineFor(task);
    const files = task.templates as { system: string; user: string };
    const names = roles.map((role) => files[role]);
    const [builtin, overrides] = await Promise.all([
      readTemplates(base, names),
      readTemplates(override, names),
    ]);
    return { builtin, overrides, engine };
  }

  function resolveFileTemplates<I extends Json, O extends Json, RawI>(
    task: Task<I, O, RawI>,
    snapshot: {
      builtin: ReadonlyMap<string, string>;
      overrides: ReadonlyMap<string, string>;
    },
  ): PromptTemplates {
    if ("inline" in task.templates && task.templates.inline) {
      const files: PromptFileInfo[] = [];
      const system = task.templates.system ?? "";
      if (task.templates.system !== undefined) {
        files.push({
          role: "system",
          path: `inline:${task.id}:system`,
          source: "inline",
        });
      }
      files.push({
        role: "user",
        path: `inline:${task.id}:user`,
        source: "inline",
      });
      return { system, user: task.templates.user, files };
    }
    const { base, override } = roots(task);
    const spec = task.templates as { system: string; user: string };
    const pick = (role: Role, useOverride = true) => {
      const name = spec[role];
      if (useOverride && override) {
        const path = templatePath(override, name);
        const text = snapshot.overrides.get(path);
        if (text !== undefined)
          return { text, file: { role, path, source: "override" as const } };
      }
      if (!base) {
        throw appError("prompt.resource_missing", {
          details: { task: task.id, resource: name },
        });
      }
      const path = templatePath(base, name);
      const text = snapshot.builtin.get(path);
      if (text === undefined)
        throw appError("prompt.resource_missing", {
          details: { task: task.id, resource: name },
        });
      return { text, file: { role, path, source: "builtin" as const } };
    };
    const system = pick("system");
    const user = pick("user");
    return {
      system: system.text,
      user: user.text,
      files: [system.file, user.file],
    };
  }

  function compiledAst(
    text: string,
    file: PromptFileInfo,
    engine: Liquid,
  ): Template[] {
    if (file.source === "inline") {
      const key = `${file.path}\0${text}`;
      let parsed = inlineCache.get(key);
      if (!parsed) {
        parsed = engine.parse(text, file.path);
        inlineCache.set(key, parsed);
      }
      return parsed;
    }
    const cached = astCache.get(file.path);
    if (cached && cached.text === text) return cached.parsed;
    const parsed = engine.parse(text, file.path);
    astCache.set(file.path, { text, parsed });
    return parsed;
  }

  function describe<I extends Json, O extends Json, RawI>(
    task: Task<I, O, RawI>,
    snapshot: {
      builtin: ReadonlyMap<string, string>;
      overrides: ReadonlyMap<string, string>;
    },
  ): PromptDescription {
    return {
      files: resolveFileTemplates(task, snapshot).files,
      variablesSchema: taskInputJsonSchema(task.input),
      requirements: task.requirements,
      ...(task.output.kind === "text"
        ? {}
        : { outputSchema: outputSchema(task.output.schema) }),
    };
  }

  async function renderTemplate(
    text: string,
    file: PromptFileInfo,
    task: string,
    ctx: Record<string, Json>,
    engine: Liquid,
  ): Promise<string> {
    try {
      const parsed = compiledAst(text, file, engine);
      return String(await engine.render(parsed, ctx));
    } catch (error) {
      return promptError(error, task, file.path);
    }
  }

  function requireFileOverride<I extends Json, O extends Json, RawI>(
    task: Task<I, O, RawI>,
  ): { root: string; templates: { system: string; user: string } } {
    if ("inline" in task.templates && task.templates.inline) {
      throw appError("prompt.invalid_template", {
        details: {
          task: task.id,
          reason: "Inline task templates cannot be overridden on disk",
        },
      });
    }
    const { override } = roots(task);
    if (!override)
      throw appError("runtime.read_only", {
        details: { operation: "prompts.update" },
      });
    return {
      root: override,
      templates: task.templates as { system: string; user: string },
    };
  }

  async function verifyWritePath(path: string): Promise<void> {
    const parent = dirname(path);
    const absoluteRoot = await realpath(overrideRoot!);
    if (!contains(absoluteRoot, await realpath(parent))) {
      throw appError("prompt.invalid_template", {
        details: {
          template: path,
          reason: "Override path is outside the instance",
        },
      });
    }
  }

  return {
    async read(task) {
      if ("inline" in task.templates && task.templates.inline) {
        return resolveFileTemplates(task, {
          builtin: new Map(),
          overrides: new Map(),
        });
      }
      return resolveFileTemplates(task, await load(task));
    },
    async describe(task) {
      if ("inline" in task.templates && task.templates.inline) {
        return describe(task, { builtin: new Map(), overrides: new Map() });
      }
      return describe(task, await load(task));
    },
    async compile(task, variables, sources) {
      const isInline = "inline" in task.templates && task.templates.inline;
      const loaded = isInline
        ? {
            builtin: new Map<string, string>(),
            overrides: new Map<string, string>(),
            engine: engineFor(task),
          }
        : await load(task);
      const resolved = resolveFileTemplates(task, loaded);
      const messages = await Promise.all(
        resolved.files.map(async (file) => ({
          role: file.role,
          parts: [
            {
              kind: "text" as const,
              text: await renderTemplate(
                resolved[file.role],
                file,
                task.id,
                templateVariables(task, file.role, variables, sources),
                loaded.engine,
              ),
            },
          ],
        })),
      );
      return { messages, files: resolved.files } satisfies CompiledPrompt;
    },
    async diff(task) {
      if ("inline" in task.templates && task.templates.inline) {
        const resolved = resolveFileTemplates(task, {
          builtin: new Map(),
          overrides: new Map(),
        });
        return resolved.files.map((file) => ({
          role: file.role,
          builtin: resolved[file.role],
        }));
      }
      const { base, override } = roots(task);
      const snapshot = await load(task);
      const spec = task.templates as { system: string; user: string };
      return roles.map((role) => {
        const builtinPath = templatePath(base!, spec[role]);
        const builtin = snapshot.builtin.get(builtinPath);
        if (builtin === undefined)
          throw appError("prompt.resource_missing", {
            details: { task: task.id, resource: spec[role] },
          });
        const ovr = override
          ? snapshot.overrides.get(templatePath(override, spec[role]))
          : undefined;
        return {
          role,
          builtin,
          ...(ovr === undefined ? {} : { override: ovr }),
        } satisfies PromptDiff;
      });
    },
    async setOverride(task, { role, template }) {
      return edits.add(async () => {
        const { root, templates } = requireFileOverride(task);
        const path = templatePath(root, templates[role]);
        const engine = engineFor(task);
        let parsed: Template[];
        try {
          parsed = engine.parse(template, path);
        } catch (error) {
          promptError(error, task.id, path);
        }
        await mkdir(dirname(path), { recursive: true });
        await verifyWritePath(path);
        await writeFileAtomic(path, template, { encoding: "utf8" });
        astCache.set(path, {
          text: template,
          parsed,
        });
        return describe(task, await load(task));
      });
    },
    async reset(task, role) {
      return edits.add(async () => {
        const { root, templates } = requireFileOverride(task);
        const snapshot = await load(task);
        for (const key of role ? [role] : roles) {
          const path = templatePath(root, templates[key]);
          if (!snapshot.overrides.has(path)) continue;
          await verifyWritePath(path);
          await rm(path);
          astCache.delete(path);
          snapshot.overrides.delete(path);
        }
        return describe(task, snapshot);
      });
    },
  };
}
