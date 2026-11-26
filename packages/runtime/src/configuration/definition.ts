import { appError, formatJsonPointer, type Json } from "@themelios/core";
import {
  combineSettings,
  runtimeSettings,
  type SettingDescription,
  type SettingIssue,
  type SettingMeta,
  type SettingsDefinition,
} from "../settings.js";
import { isObject, matches, pathParts } from "./path.js";

export type Field = { parts: string[]; metadata: SettingMeta };

export function invalid(issues: readonly SettingIssue[], cause?: unknown) {
  return appError("config.invalid", {
    details: {
      issues: issues.map(({ path, messageKey, params }) => ({
        path,
        messageKey,
        ...(params ? { params: { ...params } } : {}),
      })),
    },
    cause: cause,
  });
}

export class SettingFields<S> {
  readonly #fields: Field[];
  readonly definition: SettingsDefinition<S>;

  constructor(definition: SettingsDefinition<S>) {
    this.definition = definition.includes(runtimeSettings)
      ? definition
      : combineSettings(runtimeSettings, definition);
    this.#fields = Object.entries(this.definition.fields).map(
      ([path, metadata]) => ({ parts: pathParts(path), metadata }),
    );
    for (const { parts } of this.#fields) {
      if (this.#schemaAt(parts) === undefined)
        throw invalid([
          {
            path: formatJsonPointer(parts),
            messageKey: "config.unknown_setting",
          },
        ]);
    }
  }

  field(path: readonly string[]): Field | undefined {
    const declared = this.#declared(path);
    if (declared) return declared;
    if (this.#schemaAt(path) === undefined) return undefined;
    for (let length = path.length - 1; length > 0; length--) {
      const parent = this.#declared(path.slice(0, length));
      if (parent) return { parts: [...path], metadata: parent.metadata };
    }
    return undefined;
  }

  #declared(path: readonly string[]): Field | undefined {
    const exact = this.#fields.find(
      (field) =>
        field.parts.length === path.length &&
        field.parts.every((segment, index) => segment === path[index]),
    );
    return (
      exact ??
      this.#fields.find(
        (field) =>
          field.parts.length === path.length && matches(field.parts, path),
      )
    );
  }

  // ActiveConfiguration uses this for description, explanation, and edit validation.
  // fallow-ignore-next-line unused-class-member
  describeFields(path?: string): SettingDescription[] {
    if (path === undefined)
      return this.#fields.map((field) =>
        this.#description(field.parts, field.metadata),
      );
    const parts = pathParts(path);
    const field = this.field(parts);
    if (field) return [this.#description(parts, field.metadata)];
    const children = this.#fields.filter(
      (child) =>
        parts.length < child.parts.length &&
        matches(child.parts.slice(0, parts.length), parts),
    );
    if (!children.length)
      throw appError("config.unknown_setting", { details: { path } });
    return children.map((child) =>
      this.#description(child.parts, child.metadata),
    );
  }

  validatePath(
    path: string[],
    scope: "installation" | "instance",
    file?: string,
  ): void {
    let nearest: Field | undefined;
    for (let length = path.length; !nearest && length; length--)
      nearest = this.field(path.slice(0, length));
    if (nearest?.metadata.scopes.includes(scope)) return;
    if (
      !nearest &&
      this.#fields.some(
        (field) =>
          path.length < field.parts.length &&
          matches(field.parts.slice(0, path.length), path),
      )
    )
      return;
    throw invalid([
      {
        path: formatJsonPointer(path),
        messageKey: nearest ? "config.invalid_scope" : "config.unknown_setting",
        params: { scope, ...(file ? { file } : {}) },
      },
    ]);
  }

  #schemaAt(path: readonly string[]): Json | undefined {
    const [root, ...rest] = path;
    if (!root) return undefined;
    let schema = this.definition.inputSchema(root);
    for (const part of rest) {
      schema = childSchema(schema, part);
    }
    return schema;
  }

  #description(path: string[], metadata: SettingMeta): SettingDescription {
    return {
      path: formatJsonPointer(path),
      schema: structuredClone(this.#schemaAt(path) ?? {}),
      metadata: structuredClone(metadata),
    };
  }
}

function childSchema(schema: Json | undefined, part: string): Json | undefined {
  if (!isObject(schema)) return undefined;
  const {
    properties,
    additionalProperties,
    patternProperties,
    allOf,
    anyOf,
    oneOf,
  } = schema;
  if (isObject(properties) && Object.hasOwn(properties, part))
    return properties[part];
  if (isObject(patternProperties)) {
    const entry = Object.entries(patternProperties).find(
      ([pattern]) => part === "*" || new RegExp(pattern).test(part),
    );
    if (entry) return entry[1];
  }
  if (isObject(additionalProperties)) return additionalProperties;
  const alternatives = [allOf, anyOf, oneOf].find(Array.isArray) ?? [];
  return alternatives
    .map((candidate) => childSchema(candidate, part))
    .find((child) => child !== undefined);
}
