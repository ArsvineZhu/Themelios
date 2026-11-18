import type { ZodType } from 'zod';
import type { CallOptions, Flow, Json } from './core.js';

export type CredentialRef = `env:${string}` | `file:${string}`;
export type SettingScope = 'installation' | 'instance' | 'task' | 'call';
export type SettingEffect = 'next-call' | 'reload' | 'restart';
export type SettingPath = string;

export interface SettingMeta {
  titleKey: string;
  descriptionKey: string;
  impactKey: string;
  scopes: readonly SettingScope[];
  effect: SettingEffect;
  unit?: string;
  format?: 'path' | 'credential';
  sensitive?: boolean;
  examples?: readonly Json[];
  dependsOn?: readonly SettingPath[];
}

export interface SettingIssue {
  path: SettingPath;
  messageKey: string;
  params?: Readonly<Record<string, string | number | boolean>>;
}

export interface SettingsDefinition<S> {
  schema: ZodType<S>;
  fields: Readonly<Record<SettingPath, SettingMeta>>;
  validateEffective?(value: Readonly<S>): readonly SettingIssue[];
}

export interface RuntimeSettings {
  locale: 'zh-CN' | 'en';
  runtime: { shutdownGraceMs: number; ioConcurrency: number };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    file: boolean;
    rotateBytes: number;
    maxFiles: number;
  };
  telemetry: {
    endpoint?: string;
    credential?: CredentialRef;
    captureModelContent: boolean;
  };
  network: {
    timeoutMs: number;
    proxy?: string;
    proxyAuthorization?: CredentialRef;
    caFile?: string;
  };
}

export declare const runtimeSettings: SettingsDefinition<RuntimeSettings>;
export declare function combineSettings<A, B>(
  a: SettingsDefinition<A>, b: SettingsDefinition<B>,
): SettingsDefinition<A & B>;

export interface SettingDescription {
  path: SettingPath;
  schema: Json;
  metadata: SettingMeta;
}

export interface SettingContribution {
  layer: 'default' | 'installation' | 'instance' | 'managed' | 'task' | 'call';
  value: Json;
  file?: string;
}

export interface SettingExplanation {
  field: SettingDescription;
  contributions: readonly SettingContribution[];
  desired?: Json;
  effective?: Json;
  state: 'active' | 'restart-required';
}

export interface ConfigurationChange {
  changed: readonly SettingPath[];
  applied: readonly SettingPath[];
  restartRequired: readonly SettingPath[];
}

export interface Configuration<S> {
  snapshot(): Readonly<S>;
  describe(path?: SettingPath): readonly SettingDescription[];
  explain(path: SettingPath): SettingExplanation;
  set(path: SettingPath, value: Json): Promise<ConfigurationChange>;
  unset(path: SettingPath): Promise<ConfigurationChange>;
  reload(): Promise<ConfigurationChange>;
}

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

export interface LogFields {
  [key: string]: Json;
}

export interface Diagnostics extends Closable {
  log(level: 'debug' | 'info' | 'warn' | 'error', event: string, fields?: LogFields): void;
  span<T>(name: string, work: () => Promise<T>, fields?: LogFields): Promise<T>;
  flush(): Promise<void>;
}

export interface Secrets {
  resolve(ref: CredentialRef): Promise<string>;
  available(ref: CredentialRef): Promise<boolean>;
}

export interface Network extends Closable {
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export declare function createSecrets(options: { baseDir: string }): Secrets;

export interface NetworkOptions {
  timeoutMs?: number;
  proxy?: string;
  proxyAuthorization?: CredentialRef;
  caFile?: string;
  secrets?: Secrets;
  diagnostics?: Diagnostics;
}

export declare function createNetwork(options?: NetworkOptions): Promise<Network>;

export interface TaskHandle<T> {
  readonly result: Promise<T>;
  cancel(reason?: string): void;
}

export interface Execution {
  run<T>(name: string, work: (signal: AbortSignal) => Promise<T>, options?: CallOptions): Promise<T>;
  start<T>(name: string, work: (signal: AbortSignal) => Promise<T>, options?: CallOptions): TaskHandle<T>;
  flow<T>(name: string, create: (signal: AbortSignal) => Flow<T>, options?: CallOptions): Flow<T>;
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
  readonly instance: Omit<InstanceInfo, 'paths'>;
  readonly settings: Readonly<S>;
  readonly clock: Clock;
  readonly diagnostics: Diagnostics;
}

export interface OpenEnvironment<S> extends ProvisionEnvironment<S> {
  readonly mode: 'read-write' | 'read-only';
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
  mode?: 'read-write' | 'read-only';
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

export declare class Installation<Api, S> {
  static at<Api, S>(root: string, application: ApplicationModule<Api, S>, options?: InstallationOptions): Installation<Api, S>;
  instance(name: string): Instance<Api, S>;
  external(root: string): Instance<Api, S>;
}
