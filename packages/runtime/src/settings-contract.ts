import type { ZodType } from "zod";
import type { Json } from "@themelios/core";

export type SettingScope = "installation" | "instance" | "task" | "call";
export type SettingEffect = "next-call" | "reload" | "restart";
export type SettingPath = string;

export interface SettingMeta {
  titleKey: string;
  descriptionKey: string;
  impactKey: string;
  scopes: readonly SettingScope[];
  effect: SettingEffect;
  unit?: string;
  format?: "path" | "credential";
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

export interface SettingDescription {
  path: SettingPath;
  schema: Json;
  metadata: SettingMeta;
}

export interface SettingContribution {
  layer: "default" | "installation" | "instance" | "managed" | "task" | "call";
  value: Json;
  file?: string;
}

export interface SettingExplanation {
  field: SettingDescription;
  contributions: readonly SettingContribution[];
  desired?: Json;
  effective?: Json;
  state: "active" | "restart-required";
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
