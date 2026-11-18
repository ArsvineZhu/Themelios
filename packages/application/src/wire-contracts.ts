import type {
  ArtifactRef,
  CopyMap,
  InputUse,
  Json,
  Producer,
  SavedResult,
  Selection,
} from "@themelios/core";
import type { ModelParameters } from "@themelios/models";
import type { SourceEntry, Preview } from "@themelios/models/tasks";

/** JSON 线上形状；二进制协议将 bytesBase64 换成原始 bytes 字段。 */
export interface WireInlineMaterial {
  bytesBase64: string;
  mediaType: string;
  name?: string;
}

export interface WireResultOutput {
  result: WireCompleted | { ref: ArtifactRef };
  output?: string;
}

export type WireMaterial = Selection | WireInlineMaterial | WireResultOutput;

export interface WireProducedFile {
  name: string;
  material: Selection | WireInlineMaterial;
  sourceIndices: readonly number[];
}

export interface WireCompleted {
  value: Json;
  inputs: readonly InputUse<WireMaterial>[];
  files: readonly WireProducedFile[];
  producer: Producer;
  mappings?: readonly CopyMap[];
}

export interface WireTaskMaterial {
  source: WireMaterial;
  role?: "primary" | "context";
}

export interface WireRunTaskInput {
  task: string;
  variables: Json;
  materials: readonly WireTaskMaterial[];
  model?: string;
  parameters?: ModelParameters;
  persist?: boolean;
}

export type WireTaskResult = WireCompleted | SavedResult<Json>;

export interface WirePreview {
  model: string;
  messages: readonly {
    role: "system" | "user" | "assistant";
    parts: readonly (
      | { kind: "text"; text: string }
      | { kind: "media"; mediaType: string; name?: string; sizeBytes?: number }
    )[];
  }[];
  sources: { entries: readonly SourceEntry[] };
  taskSchema?: Json;
  sentSchema?: Json;
  pending: readonly {
    sourceKey: string;
    action: string;
    requiresModel: boolean;
  }[];
}

/** 固定错误之外只表示机器输入转换，不改变应用操作的业务顺序。 */
export interface WireCodec {
  decodeMaterial(
    value: WireMaterial,
  ): Promise<import("@themelios/core").Material>;
  encodeCompleted(value: import("@themelios/core").Completed): WireCompleted;
  encodePreview(value: Preview): WirePreview;
}
