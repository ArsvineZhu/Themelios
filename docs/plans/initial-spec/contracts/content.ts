import type { ZodType } from 'zod';
import type {
  ArtifactRef, BlobRef, CallOptions, CommitPoint, Completed, InlineMaterial,
  Instant, Json, Producer, SavedResult, Selection,
} from './core.js';
import type { Cas, Database, WriteTransaction } from './storage.js';

/** @themelios/content/schema：Content 自己拥有的初始化表。 */
export declare const contentSchemaSql: string;

export type Extent =
  | { kind: 'text'; bytes: number }
  | { kind: 'image'; width: number; height: number; frames: number }
  | { kind: 'pages'; pages: number }
  | { kind: 'time'; durationMs: number }
  | { kind: 'unknown' };

export interface Origin {
  kind: 'file' | 'url' | 'application';
  locator?: string;
  capturedAt: Instant;
  metadata?: Json;
}

export interface ArtifactInfo {
  ref: ArtifactRef;
  kind: 'material' | 'result';
  mediaType: string;
  sizeBytes: number;
  name?: string;
  extent: Extent;
  createdAt: Instant;
  createdAtCut: CommitPoint;
  origin?: Origin;
}

export type AcceptInput =
  | (InlineMaterial & { origin?: Origin })
  | { file: string; mediaType?: string; name?: string; origin?: Origin }
  | { body: ReadableStream<Uint8Array>; mediaType: string; name?: string; origin?: Origin };

export interface PreparedMaterial {
  readonly info: Omit<ArtifactInfo, 'createdAt' | 'createdAtCut'>;
  /** 与应用自己的写入共享当前同步事务；返回此材料的正式引用。 */
  adopt(tx: WriteTransaction): Selection;
  close(): Promise<void>;
}

export interface MaterialRead {
  info: ArtifactInfo;
  body: ReadableStream<Uint8Array>;
}

export interface TextBlock {
  kind: 'heading' | 'paragraph' | 'list' | 'code' | 'quote' | 'table' | 'thematic-break';
  selection: Selection;
  depth?: number;
  text: string;
}

export interface SourceLink {
  selection: Selection;
  relation: 'input' | 'file' | 'copy' | 'representation-source';
}

export interface Materials {
  accept(input: AcceptInput, options?: CallOptions): Promise<Selection>;
  prepare(input: AcceptInput, options?: CallOptions): Promise<PreparedMaterial>;
  inspect(ref: ArtifactRef): ArtifactInfo;
  /** 读取完整原件。选区裁切由 text 或确定性媒体扩展承担。 */
  read(ref: ArtifactRef, options?: CallOptions): Promise<MaterialRead>;
  text(selection: Selection, options?: CallOptions): Promise<string>;
  structure(ref: ArtifactRef, options?: CallOptions): Promise<readonly TextBlock[]>;
  sources(ref: ArtifactRef, options?: { depth?: number }): readonly SourceLink[];
  list(options?: { at?: CommitPoint; after?: ArtifactRef; limit?: number }): readonly ArtifactInfo[];
  retain(ref: ArtifactRef): void;
  release(ref: ArtifactRef): void;
  export(ref: ArtifactRef, destination: string, options?: CallOptions): Promise<void>;
}

export interface PreparedResult<T extends Json> {
  readonly ref: ArtifactRef;
  adopt(tx: WriteTransaction): SavedResult<T>;
  close(): Promise<void>;
}

export interface Results {
  save<T extends Json>(completed: Completed<T>, options?: CallOptions): Promise<SavedResult<T>>;
  prepare<T extends Json>(completed: Completed<T>, options?: CallOptions): Promise<PreparedResult<T>>;
  read(ref: ArtifactRef, options?: CallOptions): Promise<SavedResult<Json>>;
  read<T extends Json>(ref: ArtifactRef, schema: ZodType<T>, options?: CallOptions): Promise<SavedResult<T>>;
}

export interface Representation {
  source: Selection;
  purpose: 'model-input' | 'retrieval-text';
  recipe: string;
  result: ArtifactRef;
  output: string;
}

export interface Representations {
  find(source: Selection, purpose: Representation['purpose'], recipe: string): Representation | undefined;
  set(representation: Representation): void;
  remove(source: Selection, purpose: Representation['purpose'], recipe: string): void;
}

export interface Content {
  readonly materials: Materials;
  readonly results: Results;
  readonly representations: Representations;
  close(): Promise<void>;
}

export declare function createContent(options: {
  database: Database;
  cas: Cas;
  maxImportBytes?: number;
  maxInlineBytes?: number;
}): Content;

/** CAS 内的已保存结果 JSON。它是结果内容的唯一正文。 */
export interface ResultManifest<T extends Json = Json> {
  format: 'themelios.result/1';
  value: T;
  inputs: SavedResult<T>['inputs'];
  files: SavedResult<T>['files'];
  producer: Producer;
  mappings?: SavedResult<T>['mappings'];
  /** 归一化 ResultOutput 前捕获的直接生产结果；保证命名文件仍能追溯生产事实。 */
  upstreamResults: readonly ArtifactRef[];
}

export interface ArtifactRow {
  ref: ArtifactRef;
  blob: BlobRef;
  mediaType: string;
  sizeBytes: number;
}
