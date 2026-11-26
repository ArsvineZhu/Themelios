import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  appError,
  errorCode,
  formatJsonPointer,
  type Json,
} from "@themelios/core";
import { credentialSchema, resolveCredentialReference } from "../secrets.js";
import {
  configurationFileLayers,
  type SettingContribution,
} from "../settings.js";
import { invalid, type SettingFields } from "./definition.js";
import {
  assertValues,
  at,
  freeze,
  isObject,
  leafPaths,
  merge,
  setAt,
  type SettingValues,
} from "./path.js";

export type ConfigurationFiles = Record<
  (typeof configurationFileLayers)[number],
  string
>;
export type Layers = Record<keyof ConfigurationFiles, SettingValues>;
export type Candidate<S> = {
  value: Readonly<S>;
  layers: Layers;
  defaults: SettingValues;
};

export async function readLayers(files: ConfigurationFiles): Promise<Layers> {
  const layers = await Promise.all(
    configurationFileLayers.map(
      async (layer) => [layer, await readToml(files[layer])] as const,
    ),
  );
  return Object.fromEntries(layers) as Layers;
}

async function readToml(file: string): Promise<SettingValues> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    throw invalid(
      [
        {
          path: "",
          messageKey: "config.read_failed",
          params: { file, reason: errorCode(error) ?? "read_failed" },
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

export function contributions(
  { layers, defaults }: Pick<Candidate<unknown>, "layers" | "defaults">,
  files: ConfigurationFiles,
  path: string[],
): SettingContribution[] {
  const items: SettingContribution[] = [];
  const fallback = at(defaults, path);
  if (fallback !== undefined) items.push({ layer: "default", value: fallback });
  for (const layer of configurationFileLayers) {
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
  let raw: SettingValues = {};
  for (const layer of configurationFileLayers) {
    for (const path of leafPaths(layers[layer]).filter((path) => path.length)) {
      fields.validatePath(
        path,
        layer === "installation" ? "installation" : "instance",
        files[layer],
      );
    }
    raw = merge(raw, layers[layer]);
  }
  const defaults = definition.defaults();
  const parsed = definition.safeParse(structuredClone(raw));
  if (!parsed.success) {
    throw invalid(
      parsed.error.issues.map((issue) => {
        const path = issue.path.map(String);
        const file = contributions({ layers, defaults }, files, path).at(
          -1,
        )?.file;
        return {
          path: formatJsonPointer(path),
          messageKey: "config.invalid_value",
          params: { reason: issue.message, ...(file ? { file } : {}) },
        };
      }),
      parsed.error,
    );
  }
  const decoded: unknown = parsed.data;
  assertValues(decoded);
  if (!isObject(decoded))
    throw invalid([{ path: "", messageKey: "config.object_required" }]);
  const normalized = structuredClone(decoded);
  for (const path of leafPaths(normalized)) {
    if (
      fields.field(path) &&
      at(raw, path) === undefined &&
      at(defaults, path) === undefined
    )
      setAt(defaults, path, at(normalized, path));
  }
  resolveSettingPaths(normalized, fields, files, layers, defaults);
  const value = freeze(normalized) as Readonly<S>;
  const issues = definition.validateEffective(normalized);
  if (issues.length) throw invalid(issues);
  return { value, defaults, layers };
}

function resolveSettingPaths<S>(
  normalized: SettingValues,
  fields: SettingFields<S>,
  files: ConfigurationFiles,
  layers: Layers,
  defaults: SettingValues,
): void {
  for (const path of leafPaths(normalized)) {
    const meta = fields.field(path)?.metadata;
    const value = at(normalized, path);
    if (!meta?.format || typeof value !== "string") continue;
    const source = contributions({ layers, defaults }, files, path).at(
      -1,
    )?.file;
    const directory = dirname(source ?? files.installation);
    if (meta.format === "credential") {
      const ref = credentialSchema.safeParse(value);
      if (!ref.success)
        throw invalid(
          [
            {
              path: formatJsonPointer(path),
              messageKey: "config.invalid_value",
            },
          ],
          ref.error,
        );
      setAt(normalized, path, resolveCredentialReference(ref.data, directory));
    } else setAt(normalized, path, resolve(directory, value));
  }
}

export function editLayer(
  layer: SettingValues,
  path: string[],
  value: Json | undefined,
): void {
  if (value !== undefined) assertValues(value, path);
  if (value !== undefined && !path.length) {
    throw appError("config.unknown_setting", { details: { path: "" } });
  }
  setAt(layer, path, value);
}
