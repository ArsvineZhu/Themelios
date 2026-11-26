import { isDeepStrictEqual } from "node:util";
import writeAtomic from "write-file-atomic";
import {
  appError,
  AppError,
  errorCode,
  formatJsonPointer,
  type Json,
} from "@themelios/core";
import {
  configurationFileLayers,
  type Configuration,
  type ConfigurationChange,
  type SettingExplanation,
} from "../settings.js";
import type { ResourceUpdate } from "../resources.js";
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
import { at, leafPaths, pathParts, setAt } from "./path.js";

type ManagedEdit = { path: string; value: Json | undefined };

export class ActiveConfiguration<S> implements Configuration<S> {
  #desired: Candidate<S>;
  #active: Candidate<S>;
  #pending = new Set<string>();
  #tail: Promise<unknown> = Promise.resolve();
  #closing = false;

  constructor(
    readonly fields: SettingFields<S>,
    readonly files: ConfigurationFiles,
    initial: Candidate<S>,
    readonly mode: "read-write" | "read-only",
    readonly current: () => Readonly<S> | undefined,
    readonly prepare: (settings: Readonly<S>) => Promise<ResourceUpdate>,
  ) {
    this.#desired = initial;
    this.#active = initial;
  }

  snapshot(): Readonly<S> {
    return this.current() ?? this.#active.value;
  }

  describe(path?: string) {
    return this.fields.describeFields(path);
  }

  explain(path: string): SettingExplanation {
    const parts = pathParts(path);
    const field = this.fields.describeFields(path)[0];
    if (!field || field.path !== formatJsonPointer(parts))
      throw appError("config.unknown_setting", { details: { path } });
    const value = (input: Json) =>
      field.metadata.sensitive && field.metadata.format !== "credential"
        ? "[REDACTED]"
        : structuredClone(input);
    const desired = at(asJson(this.#desired.value), parts);
    const effective = at(asJson(this.#active.value), parts);
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

  /** Serializes initial resource registration with generation updates. */
  serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closing)
      return Promise.reject(
        appError("runtime.closed", { details: { state: "closing" } }),
      );
    const result = this.#tail.then(work);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  #enqueue(edit?: ManagedEdit): Promise<ConfigurationChange> {
    if (edit && this.mode === "read-only") {
      return Promise.reject(
        appError("runtime.read_only", {
          details: { operation: "configuration.update" },
        }),
      );
    }
    return this.serialize(() => this.#update(edit));
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
    const desired = loadCandidate(this.fields, this.files, layers);
    const changed = this.#changed(this.#desired.value, desired.value);
    return { desired, changed, previousManaged };
  }

  #effective(desired: Candidate<S>): Candidate<S> {
    const deferred = this.#changed(this.#active.value, desired.value)
      .map(pathParts)
      .filter(
        (parts) => this.fields.field(parts)?.metadata.effect === "restart",
      );
    if (!deferred.length) return desired;
    const layers = structuredClone(desired.layers);
    // Keep each deferred setting's inputs and file provenance together.
    for (const layer of configurationFileLayers) {
      for (const parts of deferred) {
        setAt(layers[layer], parts, at(this.#active.layers[layer], parts));
      }
    }
    try {
      return loadCandidate(this.fields, this.files, layers);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "config.invalid")
        throw error;
      return this.#active;
    }
  }

  async #update(edit?: ManagedEdit): Promise<ConfigurationChange> {
    const { desired, changed, previousManaged } = await this.#readDesired(edit);
    const active = this.#effective(desired);
    const applied = this.#changed(this.#active.value, active.value);
    const pending = new Set(this.#changed(active.value, desired.value));
    const prepared = applied.length
      ? await this.prepare(active.value)
      : undefined;
    try {
      if (edit && !isDeepStrictEqual(previousManaged, desired.layers.managed)) {
        await writeAtomic(
          this.files.managed,
          Bun.TOML.stringify(desired.layers.managed),
        );
      }
    } catch (error) {
      await prepared?.discard();
      throw appError("config.write_failed", {
        details: {
          file: this.files.managed,
          reason: errorCode(error) ?? "write_failed",
        },
        cause: error,
      });
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
        result.add(formatJsonPointer(path));
    }
    return [...result].sort();
  }
}
