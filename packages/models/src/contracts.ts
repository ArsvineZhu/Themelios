import type { z } from "zod";
import type { CallOptions, Flow, Json } from "@themelios/core";
import type { CredentialRef } from "@themelios/runtime/secrets";
import type { Diagnostics } from "@themelios/runtime/diagnostics";

export type ModelOperation = "generate" | "embed" | "rank" | "transcribe";
export type ModalityNeed = "text" | "visual" | "speech" | "motion";
export type FetchFunction = (
  input: string | URL | Request,
  init?: RequestInit,
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
  readonly diagnostics?: Diagnostics;
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
  readonly ranking: readonly {
    readonly index: number;
    readonly score: number;
  }[];
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
  generate<O extends Json>(
    request: GenerateRequest<O>,
    options?: CallOptions,
  ): Promise<Generated<O>>;
  stream<O extends Json>(
    request: GenerateRequest<O>,
    options?: CallOptions,
  ): Flow<Generated<O>>;
  embed(request: EmbedRequest, options?: CallOptions): Promise<Embedded>;
  rank(request: RankRequest, options?: CallOptions): Promise<Ranked>;
  transcribe(
    request: TranscribeRequest,
    options?: CallOptions,
  ): Promise<Transcript>;
  close(): Promise<void>;
}
