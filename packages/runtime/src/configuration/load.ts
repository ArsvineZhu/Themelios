import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Json } from "@themelios/core";
import { errno, failure } from "../failure.js";
import type { SettingContribution } from "../settings.js";
import { invalid, type SettingFields } from "./definition.js";
import {
  assertValues,
  at,
  freeze,
  isObject,
  leafPaths,
  merge,
  pointer,
  setAt,
} from "./path.js";

export interface ConfigurationFiles {
  installation: string;
  instance: string;
  managed: string;
}

type FileLayer = "installation" | "instance" | "managed";
type ObjectValue = Record<string, Json>;
export type Layers = Record<FileLayer, ObjectValue>;
export type Candidate<S> = {
  value: Readonly<S>;
  layers: Layers;
  defaults: Json | undefined;
};

export async function readLayers(files: ConfigurationFiles): Promise<Layers> {
  const [installation, instance, managed] = await Promise.all([
    readToml(files.installation),
    readToml(files.instance),
    readToml(files.managed),
  ]);
  return { installation, instance, managed };
}

async function readToml(file: string): Promise<ObjectValue> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (errno(error) === "ENOENT") return {};
    throw invalid(
      [
        {
          path: "",
          messageKey: "config.read_failed",
          params: { file, reason: errno(error) ?? "read_failed" },
        },
      ],
      error,
    );
  }
  try {
    const parsed: unknown = Bun.TOML.parse(source);
    assertValues(parsed);
    if (!isObject(parsed)) throw new Error("Expected a TOML table");
    return parsed;
  } catch (error) {
    const issue = error as {
      message?: string;
      originalLine?: number;
      originalColumn?: number;
    };
    throw invalid(
      [
        {
          path: "",
          messageKey: "config.toml_invalid",
          params: {
            file,
            reason: issue.message ?? "parse_failed",
            ...(issue.originalLine === undefined
              ? {}
              : { line: issue.originalLine }),
            ...(issue.originalColumn === undefined
              ? {}
              : { column: issue.originalColumn }),
          },
        },
      ],
      error,
    );
  }
}

export const asJson = (value: unknown): Json => value as Json;

export function contributions<S>(
  { layers, defaults }: Candidate<S>,
  files: ConfigurationFiles,
  path: string[],
): SettingContribution[] {
  const items: SettingContribution[] = [];
  const fallback = at(defaults, path);
  if (fallback !== undefined) items.push({ layer: "default", value: fallback });
  for (const layer of ["installation", "instance", "managed"] as const) {
    const value = at(layers[layer], path);
    if (value !== undefined) items.push({ layer, file: files[layer], value });
  }
  return items;
}

export function loadCandidate<S>(
  fields: SettingFields<S>,
  files: ConfigurationFiles,
  layers: Layers,
): Candidate<S> {
  const { definition } = fields;
  for (const layer of ["installation", "instance", "managed"] as const) {
    for (const path of leafPaths(layers[layer]).filter((path) => path.length)) {
      fields.validatePath(
        path,
        layer === "installation" ? "installation" : "instance",
        files[layer],
      );
    }
  }
  const raw = merge(
    merge(layers.installation, layers.instance),
    layers.managed,
  );
  const defaults = asJson(definition.schema.safeParse({}).data);
  const parsed = definition.schema.safeParse(raw);
  if (!parsed.success) {
    throw invalid(
      parsed.error.issues.map((issue) => {
        const path = issue.path.map(String);
        const file = contributions(
          { layers, defaults, value: {} },
          files,
          path,
        ).at(-1)?.file;
        return {
          path: pointer(path),
          messageKey: "config.invalid_value",
          params: { reason: issue.message, ...(file ? { file } : {}) },
        };
      }),
      parsed.error,
    );
  }
  const normalized = asJson(parsed.data);
  assertValues(normalized);
  if (!isObject(normalized))
    throw invalid([{ path: "", messageKey: "config.object_required" }]);
  resolveSettingPaths(normalized, fields, files, layers, defaults);
  const value = normalized as Readonly<S>;
  const issues = definition.validateEffective?.(value) ?? [];
  if (issues.length) throw invalid(issues);
  return { value: freeze(value), defaults, layers };
}

function resolveSettingPaths<S>(
  normalized: ObjectValue,
  fields: SettingFields<S>,
  files: ConfigurationFiles,
  layers: Layers,
  defaults: Json | undefined,
): void {
  for (const path of leafPaths(normalized)) {
    const meta = fields.field(path)?.metadata;
    const value = at(normalized, path);
    if (!meta?.format || typeof value !== "string") continue;
    const source = contributions(
      { layers, defaults, value: {} },
      files,
      path,
    ).at(-1)?.file;
    const directory = dirname(source ?? files.installation);
    if (meta.format === "path")
      setAt(normalized, path, resolve(directory, value));
    if (meta.format === "credential" && value.startsWith("file:")) {
      setAt(normalized, path, "file:" + resolve(directory, value.slice(5)));
    }
  }
}

export function editLayer(
  layer: ObjectValue,
  path: string[],
  value: Json | undefined,
): void {
  if (value !== undefined) assertValues(value, path);
  if (value !== undefined && !path.length) {
    throw failure("config.unknown_setting", { path: "" });
  }
  setAt(layer, path, value);
}
