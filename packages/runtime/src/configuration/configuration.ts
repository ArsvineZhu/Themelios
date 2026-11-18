import { isDeepStrictEqual } from "node:util";
import writeAtomic from "write-file-atomic";
import type { Json } from "@themelios/core";
import type {
  Configuration,
  ConfigurationChange,
  SettingExplanation,
} from "../settings-contract.js";
import { errno, failure } from "../failure.js";
import {
  type Candidate,
  type ConfigurationFiles,
  asJson,
  contributions,
  editLayer,
  loadCandidate,
  readLayers,
} from "./load.js";
import { SettingFields } from "./definition.js";
import { at, freeze, leafPaths, pathParts, pointer, setAt } from "./path.js";

interface Prepared {
  activate(): void;
  discard(): Promise<void>;
}

type ManagedEdit = { path: string; value: Json | undefined };

export class ActiveConfiguration<S> implements Configuration<S> {
  #desired: Candidate<S>;
  #active: Readonly<S>;
  #pending = new Set<string>();
  #tail: Promise<unknown> = Promise.resolve();
  #closing = false;

  constructor(
    readonly fields: SettingFields<S>,
    readonly files: ConfigurationFiles,
    initial: Candidate<S>,
    readonly mode: "read-write" | "read-only",
    readonly current: () => Readonly<S> | undefined,
    readonly prepare: (settings: Readonly<S>) => Promise<Prepared>,
  ) {
    this.#desired = initial;
    this.#active = initial.value;
  }

  snapshot(): Readonly<S> {
    return this.current() ?? this.#active;
  }

  describe(path?: string) {
    return this.fields.describeFields(path);
  }

  explain(path: string): SettingExplanation {
    const parts = pathParts(path);
    const field = this.fields.describeFields(path)[0];
    if (!field || field.path !== pointer(parts))
      throw failure("config.unknown_setting", { path });
    const value = (input: Json) =>
      field.metadata.sensitive && field.metadata.format !== "credential"
        ? "[REDACTED]"
        : structuredClone(input);
    const desired = at(asJson(this.#desired.value), parts);
    const effective = at(asJson(this.#active), parts);
    return {
      field,
      contributions: contributions(this.#desired, this.files, parts).map(
        (item) => ({ ...item, value: value(item.value) }),
      ),
      ...(desired === undefined ? {} : { desired: value(desired) }),
      ...(effective === undefined ? {} : { effective: value(effective) }),
      state: this.#pending.has(field.path) ? "restart-required" : "active",
    };
  }

  set(path: string, value: Json): Promise<ConfigurationChange> {
    return this.#enqueue({ path, value: structuredClone(value) });
  }
  unset(path: string): Promise<ConfigurationChange> {
    return this.#enqueue({ path, value: undefined });
  }
  reload(): Promise<ConfigurationChange> {
    return this.#enqueue();
  }

  stop(): Promise<unknown> {
    this.#closing = true;
    return this.#tail;
  }

  #enqueue(edit?: {
    path: string;
    value: Json | undefined;
  }): Promise<ConfigurationChange> {
    if (this.#closing)
      return Promise.reject(failure("runtime.closed", { state: "closing" }));
    if (edit && this.mode === "read-only") {
      return Promise.reject(
        failure("runtime.read_only", { operation: "configuration.update" }),
      );
    }
    const result = this.#tail.then(() => this.#update(edit));
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async #readDesired(edit?: ManagedEdit) {
    const layers = await readLayers(this.files);
    const previousManaged = edit ? structuredClone(layers.managed) : undefined;
    if (edit) {
      const fields = this.fields.describeFields(edit.path);
      if (
        fields.every((field) => !field.metadata.scopes.includes("instance"))
      ) {
        this.fields.validatePath(pathParts(edit.path), "instance");
      }
      editLayer(layers.managed, pathParts(edit.path), edit.value);
    }
    let desired = loadCandidate(this.fields, this.files, layers);
    const changed = this.#changed(this.#desired.value, desired.value);
    if (
      edit &&
      edit.value !== undefined &&
      !changed.length &&
      previousManaged
    ) {
      desired = { ...desired, layers: { ...layers, managed: previousManaged } };
    }
    return { desired, changed, previousManaged };
  }

  #effective(desired: Readonly<S>): Readonly<S> {
    const different = this.#changed(this.#active, desired);
    const effective = structuredClone(desired) as Record<string, Json>;
    for (const path of different) {
      const parts = pathParts(path);
      if (this.fields.field(parts)?.metadata.effect === "restart") {
        setAt(effective, parts, at(asJson(this.#active), parts));
      }
    }
    const mixed = effective as Readonly<S>;
    const issues = this.fields.definition.validateEffective?.(mixed) ?? [];
    if (
      issues.length ||
      !this.fields.definition.schema.safeParse(mixed).success
    ) {
      return this.#active;
    }
    return freeze(mixed);
  }

  async #update(edit?: ManagedEdit): Promise<ConfigurationChange> {
    const { desired, changed, previousManaged } = await this.#readDesired(edit);
    const active = this.#effective(desired.value);
    const applied = this.#changed(this.#active, active);
    const pending = new Set(this.#changed(active, desired.value));
    const prepared = applied.length ? await this.prepare(active) : undefined;
    try {
      if (edit && !isDeepStrictEqual(previousManaged, desired.layers.managed)) {
        await writeAtomic(
          this.files.managed,
          Bun.TOML.stringify(desired.layers.managed),
        );
      }
    } catch (error) {
      await prepared?.discard();
      throw failure(
        "config.write_failed",
        { file: this.files.managed, reason: errno(error) ?? "write_failed" },
        error,
      );
    }
    this.#desired = desired;
    this.#active = active;
    this.#pending = pending;
    prepared?.activate();
    return { changed, applied, restartRequired: [...pending] };
  }

  #changed(a: Readonly<S>, b: Readonly<S>): string[] {
    if (isDeepStrictEqual(a, b)) return [];
    const paths = [...leafPaths(asJson(a)), ...leafPaths(asJson(b))];
    const result = new Set<string>();
    for (const leaf of paths) {
      const path = [...leaf];
      while (path.length && !this.fields.field(path)) path.pop();
      if (
        path.length &&
        !isDeepStrictEqual(at(asJson(a), path), at(asJson(b), path))
      )
        result.add(pointer(path));
    }
    return [...result].sort();
  }
}
