import type { CallOptions, Flow, Json } from "@themelios/core";
import type { Configuration, SettingsDefinition } from "./settings-contract.js";
import type { Diagnostics } from "./diagnostics.js";
import type { Network } from "./network.js";
import type { Secrets } from "./secrets.js";

export interface InstancePaths {
  root: string;
  config: string;
  state: string;
  objects: string;
  cache: string;
  logs: string;
  run: string;
}

export interface InstanceInfo {
  id: string;
  name: string;
  applicationId: string;
  formatId: string;
  createdAt: string;
  paths: InstancePaths;
}

export interface Clock {
  now(): string;
  monotonicMs(): number;
}

export interface Closable {
  close(): void | Promise<void>;
}

export interface TaskHandle<T> {
  readonly result: Promise<T>;
  cancel(reason?: string): void;
}

export interface Execution {
  run<T>(
    name: string,
    work: (signal: AbortSignal) => Promise<T>,
    options?: CallOptions,
  ): Promise<T>;
  start<T>(
    name: string,
    work: (signal: AbortSignal) => Promise<T>,
    options?: CallOptions,
  ): TaskHandle<T>;
  flow<T>(
    name: string,
    create: (signal: AbortSignal) => Flow<T>,
    options?: CallOptions,
  ): Flow<T>;
}

export interface ResourceSlot<T extends Closable> {
  get(): T;
}

export interface ResourceContext<S> {
  readonly settings: Readonly<S>;
  readonly network: Network;
  readonly secrets: Secrets;
  readonly diagnostics: Diagnostics;
}

export interface ProvisionEnvironment<S> {
  readonly paths: InstancePaths;
  readonly instance: Omit<InstanceInfo, "paths">;
  readonly settings: Readonly<S>;
  readonly clock: Clock;
  readonly diagnostics: Diagnostics;
}

export interface OpenEnvironment<S> extends ProvisionEnvironment<S> {
  readonly mode: "read-write" | "read-only";
  readonly configuration: Configuration<S>;
  readonly execution: Execution;
  readonly network: Network;
  readonly secrets: Secrets;
  own<T extends Closable>(resource: T): T;
  bindResource<T extends Closable>(
    select: (settings: Readonly<S>) => Json,
    create: (context: ResourceContext<S>) => Promise<T>,
  ): Promise<ResourceSlot<T>>;
}

export interface ApplicationModule<Api, S> {
  readonly id: string;
  readonly formatId: string;
  readonly settings: SettingsDefinition<S>;
  /** 语言 -> 完整 messageKey -> i18next 模板；键按平面字符串匹配。 */
  readonly locales?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  provision(env: ProvisionEnvironment<S>): Promise<void>;
  open(env: OpenEnvironment<S>): Promise<Api>;
}

export interface OpenOptions {
  mode?: "read-write" | "read-only";
  signal?: AbortSignal;
}

export interface Session<Api, S> {
  readonly api: Api;
  readonly instance: InstanceInfo;
  readonly configuration: Configuration<S>;
  close(options?: { graceMs?: number }): Promise<void>;
}

export interface Instance<Api, S> {
  init(): Promise<InstanceInfo>;
  open(options?: OpenOptions): Promise<Session<Api, S>>;
}

export interface InstallationOptions {
  configRoot?: string;
  dataRoot?: string;
}
