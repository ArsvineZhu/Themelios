import type { Database as BunDatabase } from 'bun:sqlite';
import type { BlobRef, CallOptions, CommitPoint, Instant } from './core.js';

export interface ReadTransaction {
  readonly sql: Pick<BunDatabase, 'query' | 'prepare'>;
  readonly cut: bigint;
}
export interface WriteTransaction {
  readonly sql: Pick<BunDatabase, 'query' | 'prepare' | 'run'>;
  readonly seq: bigint;
  readonly recordedAt: Instant;
}
export interface DatabaseOptions {
  path: string;
  formatId: string;
  readonly?: boolean;
  synchronous?: 'FULL' | 'NORMAL';
  busyTimeoutMs?: number;
  now?: () => Instant;
}
export declare class Database {
  static init(options: DatabaseOptions & { schemaSql: string }): Database;
  static open(options: DatabaseOptions): Database;
  read<T>(work: (tx: ReadTransaction) => T): T;
  write<T>(work: (tx: WriteTransaction) => T): T;
  cut(): CommitPoint;
  close(): void;
}

export interface BlobInfo { ref: BlobRef; sizeBytes: number }
export declare class Cas {
  static open(root: string): Promise<Cas>;
  put(input: Uint8Array | ReadableStream<Uint8Array>, options?: CallOptions & { maxBytes?: number }): Promise<BlobInfo>;
  stat(ref: BlobRef): Promise<BlobInfo>;
  read(ref: BlobRef, options?: CallOptions & { start?: number; end?: number }): Promise<ReadableStream<Uint8Array>>;
  close(): Promise<void>;
}

export interface BackupInfo {
  formatId: string;
  cut: CommitPoint;
  createdAt: Instant;
  artifacts: number;
  blobs: number;
  bytes: number;
}
export interface CollectionReport {
  historyFloor: CommitPoint;
  removedArtifacts: number;
  removedBlobs: number;
  reclaimedBytes: number;
}
