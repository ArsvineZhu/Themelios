import { isDeepStrictEqual } from "node:util";
import { appError, type Json } from "@themelios/core";
import type { RuntimeDiagnostics } from "./diagnostics.js";
import type {
  Closable,
  OperationResources,
  ResourceContext,
  ResourceSlot,
} from "./execution.js";
import type { Network } from "./network.js";
import type { Secrets } from "./secrets.js";
import { extractRuntimeSettings, type RuntimeSettings } from "./settings.js";

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
  app: Shared<Closable> | undefined;

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

  useApplication(resource: Shared<Closable>) {
    resource.hold();
    this.app = resource;
  }

  hold(): () => void {
    this.#users++;
    return () => this.release();
  }

  release(): void {
    if (--this.#users === 0) void this.#dispose();
  }

  async #dispose(): Promise<void> {
    if (this.app) await this.closeShared(this.app);
    await this.closeShared(this.transport);
    await this.closeShared(this.diary);
    this.#completed.resolve();
  }
}

export class SessionResources<S> {
  readonly #generations = new Set<Resources<S>>();
  #active: Resources<S> | undefined;
  #slot:
    | {
        select: (settings: Readonly<S>) => Json;
        create: (context: ResourceContext<S>) => Promise<Closable>;
      }
    | undefined;

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
    create: (context: ResourceContext<S>) => Promise<T>,
    current: () => OperationResources<S> | undefined,
  ): Promise<ResourceSlot<T>> {
    if (this.#slot) throw appError("runtime.resource_bound");
    const generation = this.#current();
    generation.useApplication(
      new Shared("application", await create(generation)),
    );
    this.#slot = { select, create };
    return {
      get: () => {
        const generation = current() as Resources<S> | undefined;
        const value = (generation ?? this.#current()).app?.value;
        if (!value)
          throw appError("runtime.closed", { details: { state: "closed" } });
        return value as T;
      },
    };
  }

  /** Creates a complete resource generation before adopting it synchronously. */
  async prepare(settings: Readonly<S>): Promise<ResourceUpdate> {
    const old = this.#active;
    const next = extractRuntimeSettings(settings);
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
      if (this.#slot) {
        const { select, create } = this.#slot;
        const previousApp = old?.app;
        const recreate =
          !previousApp ||
          makeNetwork ||
          makeDiagnostics ||
          !isDeepStrictEqual(select(old.settings), select(settings));
        candidate.useApplication(
          recreate
            ? new Shared("application", await create(candidate))
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

function networkSettings({ network }: RuntimeSettings) {
  const { proxy, noProxy, proxyAuthorization, caFile } = network;
  return { proxy, noProxy, proxyAuthorization, caFile };
}

function diagSettings({ logging }: RuntimeSettings) {
  const { file, rotateBytes, maxFiles } = logging;
  return { file, rotateBytes, maxFiles };
}
