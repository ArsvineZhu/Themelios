import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { appError, type Json } from "@themelios/core";
import type { RuntimeDiagnostics } from "./diagnostics.js";
import type {
  Closable,
  OperationResources,
  ResourceSlot,
} from "./execution.js";
import type { Network } from "./network.js";
import type { Secrets } from "./secrets.js";
import { runtimeSettings, type RuntimeSettings } from "./settings.js";

export interface ResourceUpdate {
  activate(): void;
  discard(): Promise<void>;
}

class Shared<T extends Closable> {
  #references = 0;
  constructor(
    readonly name: string,
    readonly value: T,
  ) {}
  hold(): void {
    this.#references++;
  }
  async release(): Promise<void> {
    if (--this.#references === 0) await this.value.close();
  }
}

class Resources<S> implements OperationResources<S> {
  #users = 1;
  readonly #completed = Promise.withResolvers<void>();
  readonly applications = new Map<Binding<S>, BoundResource<S>>();

  constructor(
    readonly settings: Readonly<S>,
    readonly runtime: Readonly<RuntimeSettings>,
    readonly diary: Shared<RuntimeDiagnostics>,
    readonly transport: Shared<Network>,
    readonly secrets: Secrets,
    private readonly closeShared: (resource: Shared<Closable>) => Promise<void>,
  ) {
    diary.hold();
    transport.hold();
  }

  get diagnostics() {
    return this.diary.value;
  }
  get network() {
    return this.transport.value;
  }
  get closed() {
    return this.#completed.promise;
  }

  useApplication(binding: Binding<S>, entry: BoundResource<S>) {
    entry.resource.hold();
    this.applications.set(binding, entry);
  }

  hold(): () => void {
    this.#users++;
    return () => this.release();
  }

  release(): void {
    if (--this.#users === 0) void this.#dispose();
  }

  async #dispose(): Promise<void> {
    for (const { resource } of [...this.applications.values()].reverse())
      await this.closeShared(resource);
    await this.closeShared(this.transport);
    await this.closeShared(this.diary);
    this.#completed.resolve();
  }
}

type Binding<S> = {
  select: (settings: Readonly<S>) => Json;
  create: (context: OperationResources<S>) => Promise<Closable>;
};

type BoundResource<S> = {
  readonly key: Json;
  readonly resource: Shared<Closable>;
  readonly dependencies: ReadonlyMap<Binding<S>, BoundResource<S>>;
};

export class SessionResources<S> {
  readonly #generations = new Set<Resources<S>>();
  #active: Resources<S> | undefined;
  readonly #bindings: Binding<S>[] = [];
  readonly #building = new AsyncLocalStorage<{
    dependencies: Map<Binding<S>, BoundResource<S>>;
    active: boolean;
  }>();

  constructor(
    readonly secrets: Secrets,
    readonly diagnostics: (
      settings: RuntimeSettings,
    ) => Promise<RuntimeDiagnostics>,
    readonly network: (
      settings: RuntimeSettings,
      diagnostics: RuntimeDiagnostics,
    ) => Promise<Network>,
    readonly closeFailure: (owner: string, error: unknown) => void,
  ) {}

  get active(): OperationResources<S> {
    return this.#current();
  }

  #current(): Resources<S> {
    if (!this.#active)
      throw appError("runtime.closed", { details: { state: "closed" } });
    return this.#active;
  }

  async bind<T extends Closable>(
    select: (settings: Readonly<S>) => Json,
    create: (context: OperationResources<S>) => Promise<T>,
    current: () => OperationResources<S> | undefined,
  ): Promise<ResourceSlot<T>> {
    const generation = this.#current();
    const binding = { select, create };
    const key = select(generation.settings);
    generation.useApplication(
      binding,
      await this.#build(binding, generation, key),
    );
    this.#bindings.push(binding);
    return {
      get: () => {
        const generation = current() as Resources<S> | undefined;
        const entry = (generation ?? this.#current()).applications.get(binding);
        if (!entry)
          throw appError("runtime.closed", { details: { state: "closed" } });
        const build = this.#building.getStore();
        if (build?.active) build.dependencies.set(binding, entry);
        return entry.resource.value as T;
      },
    };
  }

  async #build(binding: Binding<S>, generation: Resources<S>, key: Json) {
    const build = {
      dependencies: new Map<Binding<S>, BoundResource<S>>(),
      active: true,
    };
    try {
      const resource = await this.#building.run(build, () =>
        binding.create(generation),
      );
      return {
        key,
        resource: new Shared("application", resource),
        dependencies: build.dependencies,
      };
    } finally {
      build.active = false;
    }
  }

  /** Creates a complete resource generation before adopting it synchronously. */
  async prepare(settings: Readonly<S>): Promise<ResourceUpdate> {
    const old = this.#active;
    const next = runtimeSettings.select(settings as object);
    const makeDiagnostics =
      !old || !isDeepStrictEqual(diagSettings(old.runtime), diagSettings(next));
    const makeNetwork =
      !old ||
      !isDeepStrictEqual(networkSettings(old.runtime), networkSettings(next));
    const diary = makeDiagnostics
      ? new Shared("diagnostics", await this.diagnostics(next))
      : old.diary;
    const transport = await (async (): Promise<Shared<Network>> => {
      try {
        return makeNetwork || !old
          ? new Shared("network", await this.network(next, diary.value))
          : old.transport;
      } catch (error) {
        if (makeDiagnostics) {
          diary.hold();
          await this.#closeShared(diary);
        }
        throw error;
      }
    })();
    const candidate = new Resources(
      settings,
      next,
      diary,
      transport,
      this.secrets,
      (resource) => this.#closeShared(resource),
    );
    this.#generations.add(candidate);
    void candidate.closed.then(() => this.#generations.delete(candidate));
    try {
      for (const binding of this.#bindings) {
        const key = binding.select(settings);
        const previousApp = old?.applications.get(binding);
        candidate.useApplication(
          binding,
          makeNetwork ||
            makeDiagnostics ||
            !canReuse(previousApp, key, candidate)
            ? await this.#build(binding, candidate, key)
            : previousApp,
        );
      }
    } catch (error) {
      candidate.release();
      await candidate.closed;
      throw error;
    }
    return {
      activate: () => {
        this.#active = candidate;
        if (old) queueMicrotask(() => old.release());
      },
      discard: async () => {
        candidate.release();
        await candidate.closed;
      },
    };
  }

  async close(closeOwned: () => Promise<void>): Promise<void> {
    const active = this.#active;
    active?.diary.hold();
    this.#active = undefined;
    active?.release();
    try {
      await Promise.all(
        [...this.#generations].map((generation) => generation.closed),
      );
      await closeOwned();
    } finally {
      if (active) await this.#closeShared(active.diary);
    }
  }

  async #closeShared(resource: Shared<Closable>): Promise<void> {
    try {
      await resource.release();
    } catch (error) {
      this.closeFailure(resource.name, error);
    }
  }
}

function canReuse<S>(
  entry: BoundResource<S> | undefined,
  key: Json,
  generation: Resources<S>,
): entry is BoundResource<S> {
  return (
    entry !== undefined &&
    isDeepStrictEqual(entry.key, key) &&
    [...entry.dependencies].every(
      ([binding, dependency]) =>
        generation.applications.get(binding) === dependency,
    )
  );
}

function networkSettings({ network }: RuntimeSettings) {
  const { proxy, noProxy, proxyAuthorization, caFile } = network;
  return { proxy, noProxy, proxyAuthorization, caFile };
}

function diagSettings({ logging }: RuntimeSettings) {
  const { file, rotateBytes, maxFiles } = logging;
  return { file, rotateBytes, maxFiles };
}
