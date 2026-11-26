import type { z } from "zod";
import type {
  CallOptions,
  Completed,
  ErrorInfo,
  Flow,
  InputRole,
  InputUse,
  Json,
  Material,
  modelInputRepresentationPurpose,
  Extent,
  RepresentationAdapter,
  SavedRepresentation,
  SavedResult,
  Selection,
} from "@themelios/core";
import type { Diagnostics } from "@themelios/runtime/diagnostics";
import type { Network } from "@themelios/runtime/network";
import type { Secrets } from "@themelios/runtime/secrets";
import type {
  connectionSchema,
  embeddingPurposeSchema,
  embeddingSpaceSchema,
  modelBindingSchema,
  modelCapabilitiesSchema,
  modelDefaultsSchema,
  modelMessageSchema,
  modelOperationSchema,
  modelParametersSchema,
  modelPartSchema,
  preparationPolicySchema,
  previewSchema,
  promptDescriptionSchema,
  promptDiffSchema,
  promptRoleSchema,
  promptTemplatesSchema,
  sourceEntrySchema,
  taskDescriptionSchema,
  taskExampleSchema,
  taskRepresentationSchema,
  taskRequirementsSchema,
  taskRouteSchema,
  transcriptionTimestampSchema,
} from "./schema.js";

export type ModelOperation = z.output<typeof modelOperationSchema>;
export type Connection = z.output<typeof connectionSchema>;
export type ModelCapabilities = z.output<typeof modelCapabilitiesSchema>;
export type ModelParameters = z.output<typeof modelParametersSchema>;
export type EmbeddingSpace = z.output<typeof embeddingSpaceSchema>;
export type ModelBinding = z.output<typeof modelBindingSchema>;
export type ModelPart = z.output<typeof modelPartSchema>;
export type ModelMessage = z.output<typeof modelMessageSchema>;

export interface GenerateRequest<O extends Json> {
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly output: ModelOutput<O>;
  readonly parameters?: ModelParameters;
}

export type ModelOutput<O extends Json> =
  | { readonly kind: "text"; readonly schema: z.ZodType<O, string> }
  | { readonly kind: "json"; readonly schema: z.ZodType<O> };

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
  readonly purpose: z.output<typeof embeddingPurposeSchema>;
}

export interface Embedded {
  readonly space: EmbeddingSpace;
  readonly vectors: readonly number[][];
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
  readonly ranking: readonly {
    readonly index: number;
    readonly score: number;
  }[];
  readonly model: ModelIdentity;
}

export type TranscriptionTimestamp = z.output<
  typeof transcriptionTimestampSchema
>;

export interface TranscribeRequest {
  readonly model: string;
  readonly audio: { readonly mediaType: string; readonly bytes: Uint8Array };
  readonly timestamps?: TranscriptionTimestamp;
  readonly language?: string;
}

export interface Transcript {
  readonly text: string;
  readonly segments?: readonly {
    readonly startMs: number;
    readonly endMs: number;
    readonly text: string;
    readonly granularity: TranscriptionTimestamp;
  }[];
  readonly language?: string;
  readonly durationMs?: number;
  readonly model: ModelIdentity;
  readonly notices: readonly ModelNotice[];
}

export type SourceEntry = Readonly<z.output<typeof sourceEntrySchema>>;

export type SourceEntries = Preview["sources"];

export interface SourceDirectory extends SourceEntries {
  has(key: string): boolean;
  link(key: string): string;
}

export type TaskRequirements = z.output<typeof taskRequirementsSchema>;

export interface OutputIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly messageKey: string;
  readonly params?: Readonly<Record<string, Json>>;
}

export type TaskExample<I extends Json, O extends Json> = Omit<
  z.output<typeof taskExampleSchema>,
  "variables" | "output"
> & {
  readonly variables: I;
  readonly output: O;
};

export type TaskTemplates =
  | {
      readonly system: string;
      readonly user: string;
      readonly resourceRoot?: string;
    }
  | { readonly inline: true; readonly system?: string; readonly user: string };

export interface TaskDefinition<I extends Json, O extends Json, RawI = I> {
  readonly id: string;
  readonly title: string;
  readonly purpose: string;
  readonly titleKey: string;
  readonly purposeKey: string;
  readonly input: z.ZodType<I, RawI>;
  readonly output: ModelOutput<O>;
  readonly requirements: TaskRequirements;
  readonly templates: TaskTemplates;
  readonly examples: readonly TaskExample<I, O>[];
  readonly outputRuleKeys?: readonly string[];
  validateOutput?(
    value: O,
    sources: SourceDirectory,
    variables: I,
  ): readonly OutputIssue[];
  present?(value: O, sources: SourceDirectory, locale?: string): string;
}

type OptionalTaskFields =
  "title" | "purpose" | "titleKey" | "purposeKey" | "examples";
export type TaskDefinitionInput<
  I extends Json,
  O extends Json,
  RawI = I,
> = Omit<TaskDefinition<I, O, RawI>, OptionalTaskFields> &
  Partial<Pick<TaskDefinition<I, O, RawI>, OptionalTaskFields>>;

export interface TaskMaterial {
  readonly source: TaskSource;
  readonly role?: InputRole | undefined;
  /** A durable, caller-selected representation of the original selection. */
  readonly representation?: TaskRepresentation | undefined;
}

export type TaskRepresentation = z.output<typeof taskRepresentationSchema>;

export interface LocalTaskSource {
  readonly file: string;
  readonly mediaType?: string;
  readonly name?: string;
}

export type TaskSource = Material | LocalTaskSource;

export interface TaskRequest<I> {
  readonly variables: I;
  readonly materials: readonly TaskMaterial[];
  readonly model?: string;
  readonly parameters?: ModelParameters;
}

export type PreparationPolicy = z.output<typeof preparationPolicySchema>;

export interface PreparationCallOptions extends CallOptions {
  readonly preparation?: PreparationPolicy;
}

export interface PreparedInput {
  readonly parts: readonly ModelPart[];
  readonly sources: SourceDirectory;
  readonly uses: readonly InputUse[];
}

export interface PreparationPreview {
  readonly sources: SourceEntries;
  readonly readyParts: readonly ModelPart[];
  readonly pending: Preview["pending"];
}

export interface PreparationStore {
  readonly materials: {
    inspect(ref: Selection["ref"]): {
      readonly mediaType: string;
      readonly sizeBytes: number;
      readonly name?: string | undefined;
      readonly extent: Extent;
    };
    read(
      ref: Selection["ref"],
      options?: CallOptions,
    ): Promise<{ readonly body: ReadableStream<Uint8Array> }>;
    text(selection: Selection, options?: CallOptions): Promise<string>;
  };
  readonly results: {
    read(ref: Selection["ref"], options?: CallOptions): Promise<SavedResult>;
  };
  readonly representations?: {
    read(
      source: Selection,
      purpose: typeof modelInputRepresentationPurpose,
      recipe: string,
      options?: CallOptions,
    ): Promise<SavedRepresentation | undefined>;
  };
}

export interface PreparationOptions {
  readonly store?: PreparationStore;
  readonly adapters?: readonly RepresentationAdapter[];
  readonly maxMaterialBytes?: number;
  readonly maxInlineBytes?: number;
}

export interface Preparation {
  prepare(
    materials: readonly TaskMaterial[],
    requirements: TaskRequirements,
    model: ModelCapabilities,
    options?: PreparationCallOptions,
  ): Promise<PreparedInput>;
  preview(
    materials: readonly TaskMaterial[],
    requirements: TaskRequirements,
    model: ModelCapabilities,
    options?: PreparationCallOptions,
  ): Promise<PreparationPreview>;
}

export type TaskRoute = z.output<typeof taskRouteSchema>;

export type Preview = z.output<typeof previewSchema>;

export type TaskItemResult<O extends Json> =
  | { readonly ok: true; readonly result: Completed<O> }
  | { readonly ok: false; readonly error: ErrorInfo };

export interface Tasks {
  readonly concurrency: number;
  timeoutMs(taskId?: string): number;
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

export type PromptRole = z.output<typeof promptRoleSchema>;
export type PromptTemplates = z.output<typeof promptTemplatesSchema>;
export type PromptFileInfo = PromptTemplates["files"][number];
export type PromptDescription = z.output<typeof promptDescriptionSchema>;
export type TaskDescription = z.output<typeof taskDescriptionSchema>;
export type PromptDiff = z.output<typeof promptDiffSchema>;

export interface CompiledPrompt {
  readonly messages: readonly ModelMessage[];
  readonly files: readonly PromptFileInfo[];
}

export interface Prompts {
  read<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
  ): Promise<PromptTemplates>;
  /** Renders parsed task variables and the canonical source directory. */
  compile<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
    variables: I,
    sources: SourceEntries,
  ): Promise<CompiledPrompt>;
  describe<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
  ): Promise<PromptDescription>;
  diff<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
  ): Promise<readonly PromptDiff[]>;
  setOverride<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
    change: { readonly role: PromptRole; readonly template: string },
  ): Promise<PromptDescription>;
  reset<I extends Json, O extends Json, RawI>(
    task: TaskDefinition<I, O, RawI>,
    role?: PromptRole,
  ): Promise<PromptDescription>;
}

export interface ApplicationPrompts {
  read(taskId: string): Promise<PromptTemplates>;
  describe(taskId: string): Promise<PromptDescription>;
  diff(taskId: string): Promise<readonly PromptDiff[]>;
  setOverride(
    taskId: string,
    change: { readonly role: PromptRole; readonly template: string },
  ): Promise<PromptDescription>;
  reset(taskId: string, role?: PromptRole): Promise<PromptDescription>;
}

export interface ModelsOptions {
  readonly fetch?: Network["fetch"];
  readonly resolveCredential?: Secrets["resolve"];
  readonly diagnostics?: Diagnostics;
  readonly prompts?: Prompts;
  readonly resourceRoot?: string;
  readonly preparation?: Pick<
    PreparationOptions,
    "store" | "maxMaterialBytes" | "maxInlineBytes"
  >;
  readonly adapters?: readonly RepresentationAdapter[];
}

export type ModelDefaults = Readonly<z.output<typeof modelDefaultsSchema>>;

export interface Models {
  readonly tasks: Tasks;
  describe(binding: string): ModelBinding;
  fingerprint(binding: string): string;
  validateGeneration(request: GenerateRequest<Json>): void;
  generate<O extends Json>(
    request: GenerateRequest<O>,
    options?: GenerationCallOptions,
  ): Promise<Generated<O>>;
  stream<O extends Json>(
    request: GenerateRequest<O>,
    options?: GenerationCallOptions,
  ): Flow<Generated<O>>;
  embed(request: EmbedRequest, options?: CallOptions): Promise<Embedded>;
  rank(request: RankRequest, options?: CallOptions): Promise<Ranked>;
  transcribe(
    request: TranscribeRequest,
    options?: CallOptions,
  ): Promise<Transcript>;
  close(): Promise<void>;
}

export interface GenerationCallOptions extends CallOptions {
  readonly maxAttempts?: number;
}
