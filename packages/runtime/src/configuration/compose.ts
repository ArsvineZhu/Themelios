import { z } from "zod";
import { appError, formatJsonPointer, type Json } from "@themelios/core";
import type { SettingIssue, SettingMeta, SettingPath } from "../settings.js";
import { freeze, pathParts, type SettingValues } from "./path.js";

type Section = {
  schema: z.ZodObject;
  roots: readonly string[];
  fields: Readonly<Record<SettingPath, SettingMeta>>;
  validateEffective?(value: Readonly<SettingValues>): readonly SettingIssue[];
};

function invalidDefinition(path: SettingPath, messageKey: string): never {
  throw appError("config.invalid", {
    details: { issues: [{ path, messageKey }] },
  });
}

function project(value: object, keys: Iterable<string>): SettingValues {
  const record = value as SettingValues;
  return Object.fromEntries(
    Array.from(keys)
      .filter((key) => Object.hasOwn(record, key))
      .map((key) => [key, record[key]]),
  ) as SettingValues;
}

export class SettingsDefinition<S> {
  readonly #sections: readonly Section[];
  readonly #owners = new Map<string, Section>();
  readonly #inputSchemas = new Map<string, Json>();
  readonly fields: Readonly<Record<SettingPath, SettingMeta>>;

  private constructor(sections: readonly Section[]) {
    this.#sections = sections;
    for (const section of sections) {
      for (const root of section.roots) {
        if (this.#owners.has(root))
          invalidDefinition(
            formatJsonPointer([root]),
            "config.duplicate_setting",
          );
        this.#owners.set(root, section);
      }
    }
    this.fields = Object.freeze(
      Object.fromEntries(
        sections.flatMap((section) => Object.entries(section.fields)),
      ),
    );
  }

  /** Defines the Zod object, input descriptions, and effective checks for one settings owner. */
  static define<Schema extends z.ZodObject>(input: {
    schema: Schema;
    fields: Readonly<Record<SettingPath, SettingMeta>>;
    validateEffective?(
      value: Readonly<z.output<Schema>>,
    ): readonly SettingIssue[];
  }): SettingsDefinition<z.output<Schema>> {
    const { schema, validateEffective } = input;
    if (!(schema instanceof z.ZodObject))
      invalidDefinition("", "config.object_required");
    const roots = Object.keys(schema.shape);
    const fields = new Map<SettingPath, SettingMeta>();
    for (const [path, metadata] of Object.entries(input.fields)) {
      const parts = pathParts(path);
      const canonical = formatJsonPointer(parts);
      if (!roots.includes(parts[0]!))
        invalidDefinition(path, "config.unknown_setting");
      if (fields.has(canonical))
        invalidDefinition(canonical, "config.duplicate_setting");
      fields.set(canonical, freeze(structuredClone(metadata)));
    }
    return new SettingsDefinition([
      {
        schema,
        roots,
        fields: Object.fromEntries(fields),
        ...(validateEffective && {
          validateEffective(value) {
            return validateEffective(value as z.output<Schema>);
          },
        }),
      },
    ]);
  }

  static combine<A, B>(
    a: SettingsDefinition<A>,
    b: SettingsDefinition<B>,
  ): SettingsDefinition<A & B> {
    return new SettingsDefinition([...a.#sections, ...b.#sections]);
  }

  includes(other: SettingsDefinition<unknown>): boolean {
    return other.#sections.every((section) => this.#sections.includes(section));
  }

  safeParse(value: SettingValues) {
    const issues: z.core.$ZodIssue[] = [];
    const unknown = Object.keys(value).filter(
      (root) => !this.#owners.has(root),
    );
    if (unknown.length)
      issues.push({
        code: "unrecognized_keys",
        keys: unknown,
        path: [],
        message: "Unrecognized settings: " + unknown.join(", "),
      });
    const decoded: SettingValues = {};
    for (const { schema, roots } of this.#sections) {
      const parsed = schema.safeParse(project(value, roots));
      if (parsed.success) Object.assign(decoded, parsed.data);
      else issues.push(...parsed.error.issues);
    }
    return issues.length
      ? ({ success: false, error: new z.ZodError(issues) } as const)
      : ({ success: true, data: decoded as S } as const);
  }

  defaults(): SettingValues {
    const defaults: SettingValues = {};
    for (const { schema, roots } of this.#sections) {
      const parsed = schema.safeParse({});
      if (parsed.success) {
        Object.assign(defaults, parsed.data);
        continue;
      }
      for (const root of roots) {
        const property = schema.shape[root]!.safeParse(undefined);
        if (property.success && property.data !== undefined)
          defaults[root] = property.data as Json;
      }
    }
    return defaults;
  }

  validateEffective(value: SettingValues): readonly SettingIssue[] {
    return this.#sections.flatMap(
      ({ roots, validateEffective }) =>
        validateEffective?.(project(value, roots)) ?? [],
    );
  }

  inputSchema(root: string): Json | undefined {
    const schema = this.#owners.get(root)?.schema.shape[root];
    if (!schema) return undefined;
    const existing = this.#inputSchemas.get(root);
    if (existing !== undefined) return existing;
    const converted = freeze(
      z.toJSONSchema(schema, {
        io: "input",
        unrepresentable: "any",
      }) as Json,
    ) as Json;
    this.#inputSchemas.set(root, converted);
    return converted;
  }

  /** Selects keys from an already validated effective configuration. */
  select(value: object): Readonly<S> {
    return Object.freeze(project(value, this.#owners.keys())) as Readonly<S>;
  }
}

export type SettingsValues<Settings> =
  Settings extends SettingsDefinition<infer S> ? S : never;
export const defineSettings = SettingsDefinition.define;
export const combineSettings = SettingsDefinition.combine;
