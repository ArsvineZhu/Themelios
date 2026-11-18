/** Themelios 公共值合同。实现时由各包的 Zod schema 导出对应类型。 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ArtifactRef = string;
export type BlobRef = string;
/** 十进制非负整数字符串；数据库内部使用 bigint。 */
export type CommitPoint = string;
/** UTC RFC 3339，固定毫秒精度，例如 2026-11-18T03:00:00.000Z。 */
export type Instant = string;

export type Range =
  | { kind: 'text'; start: number; end: number }
  | { kind: 'pages'; start: number; end: number }
  | { kind: 'time'; startMs: number; endMs: number }
  | { kind: 'image'; x: number; y: number; width: number; height: number }
  | { kind: 'json'; pointer: string };

export interface Selection {
  ref: ArtifactRef;
  range?: Range;
}

export interface InlineMaterial {
  bytes: Uint8Array;
  mediaType: string;
  name?: string;
}

export interface ResultOutput {
  result: Completed<Json> | SavedResult<Json>;
  /** 默认 $value；其他值是 files 中的名称。 */
  output?: string;
}

export type Material = Selection | InlineMaterial | ResultOutput;

export interface InputUse<S = Material> {
  source: S;
  delivered: readonly S[];
  role: 'primary' | 'context';
}

export interface Producer {
  kind: 'model' | 'transform' | 'application';
  name: string;
  version?: string;
  details?: Json;
}

export interface ProducedFile {
  name: string;
  material: InlineMaterial | Selection;
  /** 本结果 inputs 的零基下标；空数组表示独立生成。 */
  sourceIndices: readonly number[];
}

export interface CopyMap {
  output: string;
  /** 输出文件中逐字节复制的 UTF-8 半开区间。 */
  range: { start: number; end: number };
  source: Selection;
}

export interface Completed<T extends Json = Json> {
  value: T;
  inputs: readonly InputUse[];
  files: readonly ProducedFile[];
  producer: Producer;
  mappings?: readonly CopyMap[];
}

export interface SavedFile {
  material: Selection;
  /** 仍指本结果 inputs 的零基下标，保存后保留原对应关系。 */
  sourceIndices: readonly number[];
}

export interface SavedResult<T extends Json = Json> {
  ref: ArtifactRef;
  value: T;
  inputs: readonly InputUse<Selection>[];
  files: Readonly<Record<string, SavedFile>>;
  producer: Producer;
  mappings?: readonly CopyMap[];
}

export interface Progress {
  stage: string;
  completed?: number;
  total?: number;
  unit?: string;
}

export interface CallOptions {
  signal?: AbortSignal;
  /** 从进入公共操作开始，覆盖排队、准备、重试及外部请求的总时间。 */
  timeoutMs?: number;
  onProgress?: (progress: Progress) => void;
}

export type FlowEvent<T> =
  | { type: 'progress'; progress: Progress }
  | { type: 'text-delta'; text: string }
  | { type: 'result'; value: T };

/** 惰性、单消费者；首次 next 开始工作，成功恰有一个 result，失败抛 AppError。 */
export interface Flow<T> extends AsyncIterable<FlowEvent<T>> {
  cancel(reason?: string): void;
}

export interface ErrorInfo {
  code: string;
  message: string;
  details?: Json;
  retryable: boolean;
  traceId?: string;
}

export declare class AppError extends Error {
  readonly code: string;
  readonly messageKey: string;
  readonly params?: Readonly<Record<string, string | number | boolean>>;
  readonly details?: Json;
  readonly retryable: boolean;
  readonly cause?: unknown;
  constructor(input: {
    code: string;
    messageKey: string;
    params?: Readonly<Record<string, string | number | boolean>>;
    details?: Json;
    retryable?: boolean;
    cause?: unknown;
  });
}
