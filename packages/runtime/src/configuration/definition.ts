import { z } from "zod";
import type { Json } from "@themelios/core";
import type {
  SettingDescription,
  SettingIssue,
  SettingMeta,
  SettingsDefinition,
} from "../settings.js";
import { failure } from "../failure.js";
import { isObject, matches, pathParts, pointer } from "./path.js";

export type Field = { parts: string[]; metadata: SettingMeta };

export function invalid(issues: readonly SettingIssue[], cause?: unknown) {
  return failure(
    "config.invalid",
    {
      issues: issues.map(({ path, messageKey, params }) => ({
        path,
        messageKey,
        ...(params ? { params: { ...params } } : {}),
      })),
    },
    cause,
  );
}

export class SettingFields<S> {
  readonly #fields: Field[];
  readonly #schema: Json;

  constructor(readonly definition: SettingsDefinition<S>) {
    this.#fields = Object.entries(definition.fields).map(
      ([path, metadata]) => ({ parts: pathParts(path), metadata }),
    );
    this.#schema = z.toJSONSchema(definition.schema, {
      io: "input",
      unrepresentable: "any",
    }) as Json;
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
    if (!children.length) throw failure("config.unknown_setting", { path });
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
        path: pointer(path),
        messageKey: nearest ? "config.invalid_scope" : "config.unknown_setting",
        params: { scope, ...(file ? { file } : {}) },
      },
    ]);
  }

  #schemaAt(path: readonly string[]): Json | undefined {
    let schema: Json | undefined = this.#schema;
    for (const part of path) {
      schema = childSchema(schema, part);
    }
    return schema;
  }

  #description(path: string[], metadata: SettingMeta): SettingDescription {
    return {
      path: pointer(path),
      schema: structuredClone(this.#schemaAt(path) ?? {}),
      metadata: structuredClone(metadata),
    };
  }
}

function childSchema(schema: Json | undefined, part: string): Json | undefined {
  if (!isObject(schema)) return undefined;
  const { properties, additionalProperties, patternProperties, anyOf, oneOf } =
    schema;
  if (isObject(properties) && Object.hasOwn(properties, part))
    return properties[part];
  if (isObject(patternProperties)) {
    const entry = Object.entries(patternProperties).find(
      ([pattern]) => part === "*" || new RegExp(pattern).test(part),
    );
    if (entry) return entry[1];
  }
  if (isObject(additionalProperties)) return additionalProperties;
  const alternatives = Array.isArray(anyOf)
    ? anyOf
    : Array.isArray(oneOf)
      ? oneOf
      : [];
  return alternatives
    .map((candidate) => childSchema(candidate, part))
    .find((child) => child !== undefined);
}
