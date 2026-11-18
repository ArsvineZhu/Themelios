import type { z } from "zod";
import type {
  CallOptions,
  Completed,
  Json,
  Material,
  Range,
} from "@themelios/core";
import type {
  AcceptInput,
  ArtifactInfo,
  Extent,
  Materials,
} from "@themelios/content";
import type {
  ModelCapabilities,
  ModelPart,
  ModalityNeed,
  Models,
} from "@themelios/models";
import type {
  PreparedInput,
  SourceDirectory,
  TaskMaterial,
  TaskRequirements,
} from "@themelios/models/tasks";
import type { Prompts } from "@themelios/models/prompts";

export interface SourceRequest {
  readonly uri: string;
  readonly mediaType?: string;
  readonly name?: string;
}

export interface SourceAdapter {
  readonly schemes: readonly string[];
  open(request: SourceRequest, options?: CallOptions): Promise<AcceptInput>;
}

/** open() 每次读取同一份已捕获原件。range 坐标相对于这个原件。 */
export interface MediaInput {
  readonly source: Material;
  readonly info: Pick<
    ArtifactInfo,
    "mediaType" | "sizeBytes" | "name" | "extent"
  >;
  readonly range?: Range;
  open(options?: CallOptions): Promise<ReadableStream<Uint8Array>>;
}

export interface RecipeDescription {
  readonly id: string;
  readonly version: string;
  readonly inputMimeTypes: readonly string[];
  readonly supplies: readonly ModalityNeed[];
  readonly outputMimeTypes: readonly string[];
  readonly priority: number;
  readonly titleKey: string;
  readonly parameters: z.ZodType<Json>;
}

export interface PreparedRepresentation {
  readonly result: Completed<Json>;
  /** 要提交给模型的 files 名称，按提交顺序排列。 */
  readonly outputs: readonly string[];
}

export interface RepresentationAdapter {
  readonly description: RecipeDescription;
  probe(input: MediaInput, options?: CallOptions): Promise<Extent>;
  available(): Promise<{
    readonly available: boolean;
    readonly missing: readonly string[];
  }>;
  prepare(
    input: MediaInput,
    parameters: Json,
    options?: CallOptions,
  ): Promise<PreparedRepresentation>;
}

export interface PreparationPlan {
  readonly sources: SourceDirectory;
  readonly pending: readonly {
    readonly sourceKey: string;
    readonly action: string;
    readonly requiresModel: boolean;
  }[];
  readonly readyParts: readonly ModelPart[];
}

export interface PreparationPolicy {
  readonly representations?: readonly {
    readonly mediaType: string;
    readonly recipe: string;
    readonly parameters?: Json;
  }[];
  readonly models?: readonly {
    readonly mediaType: string;
    readonly recipe: "media.describe" | "speech.transcribe";
    readonly model: string;
  }[];
}

export interface PreparationCallOptions extends CallOptions {
  readonly preparation?: PreparationPolicy;
}

export interface Preparation {
  plan(
    materials: readonly TaskMaterial[],
    requirements: TaskRequirements,
    model: ModelCapabilities,
    options?: PreparationCallOptions,
  ): Promise<PreparationPlan>;
  forModel(
    materials: readonly TaskMaterial[],
    requirements: TaskRequirements,
    model: ModelCapabilities,
    options?: PreparationCallOptions,
  ): Promise<PreparedInput>;
}

export interface PreparationOptions {
  readonly materials?: Materials;
  readonly adapters?: readonly RepresentationAdapter[];
  readonly maxMaterialBytes?: number;
  readonly maxInlineBytes?: number;
  readonly maxImagePixels?: number;
  readonly models?: Models;
  readonly prompts?: Prompts;
}

export interface TextualizeRequest {
  readonly material: Material;
  readonly mode: "extract" | "describe" | "transcribe";
  readonly model?: string;
  readonly instructions?: string;
}

export interface Textualize {
  run(
    request: TextualizeRequest,
    options?: CallOptions,
  ): Promise<Completed<Textualized>>;
}

export type Textualized =
  | { mode: "describe"; text: string }
  | {
      mode: "extract";
      text: string;
      pages: { page: number; start: number; end: number }[];
      emptyPages: number[];
    }
  | {
      mode: "transcribe";
      text: string;
      language: string | null;
      durationMs: number | null;
      segments: {
        startMs: number;
        endMs: number;
        text: string;
        granularity: "segment" | "word";
      }[];
    };
