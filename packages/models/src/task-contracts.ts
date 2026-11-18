import type { z } from "zod";
import type {
  CallOptions,
  Completed,
  ErrorInfo,
  Flow,
  Json,
  Material,
  InputUse,
} from "@themelios/core";
import type {
  ModelMessage,
  ModelParameters,
  ModelPart,
  ModalityNeed,
} from "./contracts.js";

export interface SourceEntry {
  readonly key: string;
  readonly mediaType: string;
  readonly name?: string;
  readonly originalExtent: string;
  readonly deliveredExtent: readonly string[];
  readonly role: "primary" | "context";
}

export interface SourceDirectory {
  readonly entries: readonly SourceEntry[];
  has(key: string): boolean;
  link(key: string): string;
}

export interface TaskRequirements {
  readonly inputs: readonly {
    readonly mediaType: string;
    readonly needs: readonly ModalityNeed[];
  }[];
  readonly minMaterials: number;
  readonly maxMaterials?: number;
}

export interface OutputIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly messageKey: string;
  readonly params?: Readonly<Record<string, Json>>;
}

export interface TaskExample<I extends Json, O extends Json> {
  readonly name: string;
  readonly variables: I;
  /** text 仅为文档示例的实际材料正文；模板目录只使用 SourceEntry 字段。 */
  readonly sources: readonly (SourceEntry & { readonly text?: string })[];
  readonly output: O;
}

export interface TaskDefinition<I extends Json, O extends Json, RawI = I> {
  readonly id: string;
  readonly titleKey: string;
  readonly purposeKey: string;
  readonly input: z.ZodType<I, RawI>;
  readonly output: z.ZodType<O> | "text";
  readonly requirements: TaskRequirements;
  readonly templates: { readonly system: string; readonly user: string };
  readonly examples: readonly TaskExample<I, O>[];
  readonly outputRuleKeys?: readonly string[];
  validateOutput?(
    value: O,
    sources: SourceDirectory,
    variables: I,
  ): readonly OutputIssue[];
  present?(value: O, sources: SourceDirectory): string;
}

export interface TaskMaterial {
  readonly source: Material;
  readonly role?: "primary" | "context";
}

export interface TaskRequest<I> {
  readonly variables: I;
  readonly materials: readonly TaskMaterial[];
  readonly model?: string;
  readonly parameters?: ModelParameters;
}

export interface PreparedInput {
  readonly parts: readonly ModelPart[];
  readonly sources: SourceDirectory;
  readonly uses: readonly InputUse[];
}

export interface Preview {
  readonly model: string;
  readonly messages: readonly {
    readonly role: ModelMessage["role"];
    readonly parts: readonly (
      | Extract<ModelPart, { kind: "text" }>
      | {
          readonly kind: "media";
          readonly mediaType: string;
          readonly name?: string;
          readonly sizeBytes?: number;
        }
    )[];
  }[];
  readonly sources: SourceDirectory;
  readonly taskSchema?: Json;
  readonly sentSchema?: Json;
  readonly pending: readonly {
    readonly sourceKey: string;
    readonly action: string;
    readonly requiresModel: boolean;
  }[];
}

export type TaskItemResult<O extends Json> =
  | { readonly ok: true; readonly result: Completed<O> }
  | { readonly ok: false; readonly error: ErrorInfo };

export interface Tasks {
  run<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
    request: TaskRequest<RawI>,
    options?: CallOptions,
  ): Promise<Completed<O>>;
  stream<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
    request: TaskRequest<RawI>,
    options?: CallOptions,
  ): Flow<Completed<O>>;
  runMany<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
    requests: readonly TaskRequest<RawI>[],
    options?: CallOptions,
  ): Promise<readonly TaskItemResult<O>[]>;
  preview<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
    request: TaskRequest<RawI>,
    options?: CallOptions,
  ): Promise<Preview>;
}

export interface PromptFileInfo {
  readonly role: "system" | "user";
  readonly path: string;
  readonly source: "builtin" | "override";
}

export interface CompiledPrompt {
  readonly messages: readonly ModelMessage[];
  readonly files: readonly PromptFileInfo[];
}

export interface PromptDescription {
  readonly files: readonly PromptFileInfo[];
  readonly variablesSchema: Json;
  readonly outputSchema?: Json;
  readonly requirements: TaskRequirements;
}

export interface TaskDescription {
  readonly id: string;
  readonly title: string;
  readonly purpose: string;
  readonly inputSchema: Json;
  readonly sourcesSchema: Json;
  readonly output:
    | { readonly kind: "text" }
    | { readonly kind: "json"; readonly schema: Json };
  readonly requirements: TaskRequirements;
  readonly templates: readonly PromptFileInfo[];
  readonly examples: readonly TaskExample<Json, Json>[];
  readonly outputRules: readonly string[];
}

export interface PromptTemplates {
  readonly system: string;
  readonly user: string;
  readonly files: readonly PromptFileInfo[];
}

export interface PromptDiff {
  readonly role: "system" | "user";
  readonly builtin: string;
  readonly override?: string;
}

export interface Prompts {
  read<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
  ): Promise<PromptTemplates>;
  compile<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
    variables: I,
    sources: SourceDirectory,
  ): Promise<CompiledPrompt>;
  describe<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
  ): Promise<PromptDescription>;
  diff<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
  ): Promise<readonly PromptDiff[]>;
  setOverride<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
    change: { readonly role: "system" | "user"; readonly template: string },
  ): Promise<PromptDescription>;
  reset<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
    role?: "system" | "user",
  ): Promise<PromptDescription>;
}

/** Application 绑定任务目录，协议入口使用 taskId。 */
export interface ApplicationPrompts {
  read(taskId: string): Promise<PromptTemplates>;
  describe(taskId: string): Promise<PromptDescription>;
  diff(taskId: string): Promise<readonly PromptDiff[]>;
  setOverride(
    taskId: string,
    change: { readonly role: "system" | "user"; readonly template: string },
  ): Promise<PromptDescription>;
  reset(taskId: string, role?: "system" | "user"): Promise<PromptDescription>;
}
