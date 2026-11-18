import type { z } from "zod";
import type { CredentialRef } from "./runtime.js";
import type {
  CallOptions, Completed, ErrorInfo, Flow, Json, Material, InputUse,
} from "./core.js";
import type { Preparation, PreparationPolicy } from "./input.js";

export type ModelOperation = "generate" | "embed" | "rank" | "transcribe";
export type ModalityNeed = "text" | "visual" | "speech" | "motion";
export type FetchFunction = (
  input: string | URL | Request, init?: RequestInit,
) => Promise<Response>;

export interface Connection {
  readonly protocol: "openai-compatible" | "openai" | "google" | "cohere";
  readonly baseURL: string;
  readonly credential?: CredentialRef;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ModelCapabilities {
  readonly operations: readonly ModelOperation[];
  readonly inputMimeTypes: readonly string[];
  readonly needs: readonly ModalityNeed[];
  readonly structuredOutput: boolean;
  readonly streaming: boolean;
  readonly transcriptionTimestamps?: readonly ("segment" | "word")[];
  readonly limits?: {
    readonly maxInputBytes?: number;
    readonly maxImages?: number;
    readonly maxOutputTokens?: number;
  };
}

export interface ModelParameters {
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxOutputTokens?: number;
  readonly seed?: number;
  readonly providerOptions?: Readonly<Record<string, Json>>;
}

export interface EmbeddingSpace {
  readonly id: string;
  readonly dimensions: number;
  readonly metric: "cosine" | "dot" | "euclidean";
  readonly normalization: "none" | "l2";
  readonly purposes: readonly ("query" | "document")[];
}

export interface ModelBinding {
  readonly connection: string;
  readonly providerModel: string;
  readonly capabilities: ModelCapabilities;
  readonly parameters?: ModelParameters;
  readonly embeddingSpace?: EmbeddingSpace;
}

export interface ModelsOptions {
  readonly connections: Readonly<Record<string, Connection>>;
  readonly bindings: Readonly<Record<string, ModelBinding>>;
  readonly fetch?: FetchFunction;
  readonly resolveCredential?: (ref: CredentialRef) => Promise<string>;
  readonly defaults?: {
    readonly timeoutMs?: number;
    readonly maxAttempts?: number;
    readonly concurrency?: number;
  };
}

export type ModelPart =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "media";
      readonly mediaType: string;
      readonly bytes: Uint8Array;
      readonly name?: string;
    };

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant";
  readonly parts: readonly ModelPart[];
}

export interface GenerateRequest<O extends Json> {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly output: z.ZodType<O> | "text";
  readonly parameters?: ModelParameters;
}

export interface ModelIdentity {
  readonly binding: string;
  readonly connection: string;
  readonly providerModel: string;
  readonly returnedModel?: string;
}

export interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly provider?: Json;
}

export interface ModelNotice {
  readonly code: string;
  readonly messageKey: string;
  readonly params?: Readonly<Record<string, Json>>;
}

export interface Generated<O extends Json> {
  readonly value: O;
  readonly model: ModelIdentity;
  readonly usage?: Usage;
  readonly notices: readonly ModelNotice[];
}

export interface EmbedRequest {
  readonly model: string;
  readonly inputs: readonly (readonly ModelPart[])[];
  readonly purpose: "query" | "document";
}

export interface Embedded {
  readonly space: EmbeddingSpace;
  readonly vectors: readonly (readonly number[])[];
  readonly model: ModelIdentity;
  readonly usage?: Usage;
}

export interface RankRequest {
  readonly model: string;
  readonly query: string;
  readonly documents: readonly string[];
  readonly topN?: number;
}

export interface Ranked {
  readonly ranking: readonly { readonly index: number; readonly score: number }[];
  readonly model: ModelIdentity;
  readonly usage?: Usage;
}

export interface TranscribeRequest {
  readonly model: string;
  readonly audio: Extract<ModelPart, { kind: "media" }>;
  readonly language?: string;
  readonly timestamps?: "none" | "segment" | "word";
}

export interface Transcript {
  readonly text: string;
  readonly language?: string;
  readonly durationMs?: number;
  readonly segments?: readonly {
    readonly startMs: number;
    readonly endMs: number;
    readonly text: string;
    readonly granularity: "segment" | "word";
  }[];
  readonly model: ModelIdentity;
  readonly usage?: Usage;
  readonly notices: readonly ModelNotice[];
}

export interface Models {
  describe(binding: string): ModelBinding;
  generate<O extends Json>(request: GenerateRequest<O>, options?: CallOptions): Promise<Generated<O>>;
  stream<O extends Json>(request: GenerateRequest<O>, options?: CallOptions): Flow<Generated<O>>;
  embed(request: EmbedRequest, options?: CallOptions): Promise<Embedded>;
  rank(request: RankRequest, options?: CallOptions): Promise<Ranked>;
  transcribe(request: TranscribeRequest, options?: CallOptions): Promise<Transcript>;
  close(): Promise<void>;
}

export declare function createModels(options: ModelsOptions): Models;

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
  validateOutput?(value: O, sources: SourceDirectory, variables: I): readonly OutputIssue[];
  present?(value: O, sources: SourceDirectory): string;
}

export declare function defineTask<I extends Json, O extends Json, RawI = I>(
  definition: TaskDefinition<I, O, RawI>,
): TaskDefinition<I, O, RawI>;

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
      | { readonly kind: "media"; readonly mediaType: string; readonly name?: string; readonly sizeBytes?: number }
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
    task: TaskDefinition<I, O, RawI>, request: TaskRequest<RawI>, options?: CallOptions,
  ): Promise<Completed<O>>;
  stream<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>, request: TaskRequest<RawI>, options?: CallOptions,
  ): Flow<Completed<O>>;
  runMany<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>, requests: readonly TaskRequest<RawI>[], options?: CallOptions,
  ): Promise<readonly TaskItemResult<O>[]>;
  preview<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>, request: TaskRequest<RawI>, options?: CallOptions,
  ): Promise<Preview>;
}

export interface TaskRoute {
  readonly model: string;
  readonly parameters?: ModelParameters;
  readonly preparation?: PreparationPolicy;
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
  readonly output: { readonly kind: "text" } | { readonly kind: "json"; readonly schema: Json };
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
    task: TaskDefinition<I, O, RawI>, variables: I, sources: SourceDirectory,
  ): Promise<CompiledPrompt>;
  describe<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
  ): Promise<PromptDescription>;
  diff<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
  ): Promise<readonly PromptDiff[]>;
  setOverride<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>, change: { readonly role: "system" | "user"; readonly template: string },
  ): Promise<PromptDescription>;
  reset<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>, role?: "system" | "user",
  ): Promise<PromptDescription>;
}

/** Application 绑定任务目录，协议入口使用 taskId。 */
export interface ApplicationPrompts {
  read(taskId: string): Promise<PromptTemplates>;
  describe(taskId: string): Promise<PromptDescription>;
  diff(taskId: string): Promise<readonly PromptDiff[]>;
  setOverride(
    taskId: string, change: { readonly role: "system" | "user"; readonly template: string },
  ): Promise<PromptDescription>;
  reset(taskId: string, role?: "system" | "user"): Promise<PromptDescription>;
}

export declare function createPrompts(options: {
  readonly resourceRoot: string;
  readonly overrideRoot?: string;
  readonly locale?: string;
}): Prompts;

/** 实现导出位于 @themelios/application/tasks。 */
export declare function createTasks(options: {
  readonly models: Models;
  readonly prompts: Prompts;
  readonly preparation: Preparation;
  readonly routes: Readonly<Record<string, TaskRoute>>;
}): Tasks;
