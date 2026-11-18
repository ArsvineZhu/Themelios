import { mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { appError, type Json, parseJson, parseValue } from "@themelios/core";
import { Liquid, type FS } from "liquidjs";
import PQueue from "p-queue";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import { modelNameSchema } from "./schema.js";
import {
  type CompiledPrompt,
  type PromptDescription,
  type PromptFileInfo,
  type Prompts,
  type PromptTemplates,
  type SourceDirectory,
  type TaskDefinition,
} from "./task-contracts.js";
import { createSourceDirectory, taskInputJsonSchema } from "./tasks.js";

export type {
  ApplicationPrompts,
  CompiledPrompt,
  PromptDescription,
  PromptDiff,
  PromptFileInfo,
  Prompts,
  PromptTemplates,
} from "./task-contracts.js";

type Role = PromptFileInfo["role"];
const roles = ["system", "user"] as const;
type Task<I extends Json, O extends Json, RawI> = TaskDefinition<I, O, RawI>;

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

/** Materialize each available partial once before rendering either template. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const directory = await realpath(root).catch((error) => {
    if (absent(error)) return undefined;
    throw error;
  });
  if (!directory) return files;
  if (!contains(await realpath(dirname(root)), directory)) {
    throw appError("prompt.invalid_template", {
      details: {
        template: root,
        reason: "Task root is outside the resource directory",
      },
    });
  }
  const descendants = await readdir(root, {
    withFileTypes: true,
    recursive: true,
  });
  for (const entry of descendants) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    if (!contains(directory, await realpath(file))) continue;
    files.set(file, await readFile(file, "utf8"));
  }
  return files;
}

function liquid(roots: string[], files: ReadonlyMap<string, string>): Liquid {
  const read = (path: string) => {
    const data = files.get(resolve(path));
    if (data === undefined) throw new Error("Template resource unavailable");
    return data;
  };
  const fs: FS = {
    exists: async (path) => files.has(resolve(path)),
    existsSync: (path) => files.has(resolve(path)),
    readFile: async (path) => read(path),
    readFileSync: read,
    resolve: (root, file, extension) =>
      resolve(
        root,
        file + (extension && !file.endsWith(extension) ? extension : ""),
      ),
    contains: async (root, file) => contains(root, file),
    containsSync: contains,
    dirname,
    sep,
  };
  return new Liquid({
    root: roots,
    partials: roots,
    layouts: roots,
    fs,
    strictVariables: true,
    strictFilters: true,
    ownPropertyOnly: true,
    lenientIf: true,
    cache: true,
  });
}

interface PromptSnapshot {
  roots: string[];
  files: Map<string, string>;
  builtin: Map<string, string>;
  overrides: Map<string, string>;
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
  sources: SourceDirectory,
): Record<string, Json> {
  if (role === "system")
    return {
      task: {
        id: task.id,
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
  const entries = sources.entries.map(
    ({ key, mediaType, name, originalExtent, deliveredExtent, role }) => ({
      key,
      mediaType,
      ...(name === undefined ? {} : { name }),
      originalExtent,
      deliveredExtent: [...deliveredExtent],
      role,
    }),
  );
  return { ...variables, sources: entries };
}

export function createPrompts(options: {
  resourceRoot: string;
  overrideRoot?: string;
  locale?: string;
}): Prompts {
  const resourceRoot = resolve(options.resourceRoot);
  const overrideRoot =
    options.overrideRoot === undefined
      ? undefined
      : resolve(options.overrideRoot);
  const edits = new PQueue({ concurrency: 1 });
  function roots(id: string) {
    parseValue(modelNameSchema, id, "input.invalid");
    return {
      base: join(resourceRoot, id),
      override: overrideRoot && join(overrideRoot, id),
    };
  }
  async function load(id: string): Promise<PromptSnapshot> {
    const { base, override } = roots(id);
    const [builtin, overrides] = await Promise.all([
      snapshot(base),
      override ? snapshot(override) : new Map<string, string>(),
    ]);
    return {
      roots: override ? [override, base] : [base],
      builtin,
      overrides,
      files: new Map([...builtin, ...overrides]),
    };
  }
  function lookup<I extends Json, O extends Json, RawI>(
    task: Task<I, O, RawI>,
    role: Role,
    snapshot: PromptSnapshot,
    useOverride = true,
  ): { text: string; file: PromptFileInfo } {
    const { base, override } = roots(task.id);
    const name = task.templates[role];
    if (useOverride && override) {
      const path = templatePath(override, name);
      const text = snapshot.overrides.get(path);
      if (text !== undefined)
        return { text, file: { role, path, source: "override" } };
    }
    const path = templatePath(base, name);
    const text = snapshot.builtin.get(path);
    if (text === undefined)
      throw appError("prompt.resource_missing", {
        details: { task: task.id, resource: name },
      });
    return { text, file: { role, path, source: "builtin" } };
  }
  function templates<I extends Json, O extends Json, RawI>(
    task: Task<I, O, RawI>,
    snapshot: PromptSnapshot,
  ): PromptTemplates {
    const system = lookup(task, "system", snapshot);
    const user = lookup(task, "user", snapshot);
    return {
      system: system.text,
      user: user.text,
      files: [system.file, user.file],
    };
  }
  function describe<I extends Json, O extends Json, RawI>(
    task: Task<I, O, RawI>,
    snapshot: PromptSnapshot,
  ): PromptDescription {
    return {
      files: templates(task, snapshot).files,
      variablesSchema: taskInputJsonSchema(task.input),
      requirements: task.requirements,
      ...(task.output === "text"
        ? {}
        : { outputSchema: parseJson(z.toJSONSchema(task.output)) }),
    };
  }
  async function render(
    bytes: string,
    file: PromptFileInfo,
    task: string,
    ctx: Record<string, Json>,
    engine: Liquid,
  ) {
    try {
      const parsed = engine.parse(bytes, file.path);
      return String(await engine.render(parsed, ctx));
    } catch (error) {
      return promptError(error, task, file.path);
    }
  }
  function requireOverride(task: string): string {
    const { override } = roots(task);
    if (!override)
      throw appError("runtime.read_only", {
        details: { operation: "prompts.update" },
      });
    return override;
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
      return templates(task, await load(task.id));
    },
    async describe(task) {
      return describe(task, await load(task.id));
    },
    async compile(task, variables, sources) {
      const snapshot = await load(task.id);
      const engine = liquid(snapshot.roots, snapshot.files);
      const result = templates(task, snapshot);
      const messages = await Promise.all(
        result.files.map(async (file) => ({
          role: file.role,
          parts: [
            {
              kind: "text" as const,
              text: await render(
                result[file.role],
                file,
                task.id,
                templateVariables(task, file.role, variables, sources),
                engine,
              ),
            },
          ],
        })),
      );
      return { messages, files: result.files } satisfies CompiledPrompt;
    },
    async diff(task) {
      const snapshot = await load(task.id);
      return roles.map((role) => {
        const builtin = lookup(task, role, snapshot, false).text;
        const current = lookup(task, role, snapshot);
        return {
          role,
          builtin,
          ...(current.file.source === "override"
            ? { override: current.text }
            : {}),
        };
      });
    },
    async setOverride(task, { role, template }) {
      return edits.add(async () => {
        const root = requireOverride(task.id);
        const path = templatePath(root, task.templates[role]);
        const snapshot = await load(task.id);
        snapshot.files.set(path, template);
        snapshot.overrides.set(path, template);
        const engine = liquid(snapshot.roots, snapshot.files);
        const file = { role, path, source: "override" } as const;
        try {
          engine.parse(template, path);
        } catch (error) {
          promptError(error, task.id, path);
        }
        for (const example of task.examples) {
          const sources = createSourceDirectory(
            example.sources.map(({ text: _text, ...entry }) => entry),
          );
          await render(
            template,
            file,
            task.id,
            templateVariables(task, role, example.variables, sources),
            engine,
          );
        }
        await mkdir(dirname(path), { recursive: true });
        await verifyWritePath(path);
        await writeFileAtomic(path, template, { encoding: "utf8" });
        return describe(task, snapshot);
      });
    },
    async reset(task, role) {
      return edits.add(async () => {
        const root = requireOverride(task.id);
        const snapshot = await load(task.id);
        for (const key of role ? [role] : roles) {
          const path = templatePath(root, task.templates[key]);
          if (!snapshot.overrides.has(path)) continue;
          await verifyWritePath(path);
          await rm(path);
          snapshot.overrides.delete(path);
        }
        return describe(task, snapshot);
      });
    },
  };
}
