/**
 * 目标 API 消费参考。接通已构建的 Themelios 包后运行，当前 Spec 不包含其实现。
 * CSV 的精确字节与库存版本在一次业务提交中建立来源关系。
 */
import { basename, join, resolve } from 'node:path';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { AppError, type ArtifactRef, type CallOptions, type CommitPoint, type Json } from '@themelios/core';
import {
  Installation, combineSettings, runtimeSettings,
  type ApplicationModule, type RuntimeSettings, type SettingsDefinition,
} from '@themelios/runtime';
import { Cas, Database } from '@themelios/storage';
import { createContent } from '@themelios/content';
import { contentSchemaSql } from '@themelios/content/schema';
import en from './resources/locales/en/inventory.json';
import zhCN from './resources/locales/zh-CN/inventory.json';

const FORMAT = 'example.inventory/1';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const inventorySchema = z.object({
  inventory: z.object({
    maxFileBytes: z.number().int().min(1).max(MAX_FILE_BYTES).default(2 * 1024 * 1024),
    maxRows: z.number().int().min(1).max(100_000).default(5_000),
  }).default({ maxFileBytes: 2 * 1024 * 1024, maxRows: 5_000 }),
});
type InventorySettings = z.infer<typeof inventorySchema>;
type Settings = RuntimeSettings & InventorySettings;

const inventorySettings: SettingsDefinition<InventorySettings> = {
  schema: inventorySchema,
  fields: {
    '/inventory/maxFileBytes': {
      titleKey: 'inventory.settings.maxFileBytes.title',
      descriptionKey: 'inventory.settings.maxFileBytes.description',
      impactKey: 'inventory.settings.maxFileBytes.impact',
      scopes: ['installation', 'instance'], effect: 'next-call', unit: 'bytes',
    },
    '/inventory/maxRows': {
      titleKey: 'inventory.settings.maxRows.title',
      descriptionKey: 'inventory.settings.maxRows.description',
      impactKey: 'inventory.settings.maxRows.impact',
      scopes: ['installation', 'instance'], effect: 'next-call', unit: 'records',
    },
  },
};

const skuSchema = z.string().regex(/^[A-Z0-9._-]{1,64}$/);
const rowSchema = z.object({
  sku: skuSchema,
  name: z.string().min(1).max(200).refine(value => value.trim().length > 0),
  quantity: z.string().regex(/^(0|[1-9][0-9]*)$/)
    .transform(Number).pipe(z.number().int().min(0).max(1_000_000_000)),
}).strict();
type CsvRow = z.infer<typeof rowSchema> & { sourceRecord: number };

export interface InventoryRow {
  sku: string;
  name: string;
  quantity: number;
  sourceRef: ArtifactRef;
  sourceRecord: number;
  validFrom: CommitPoint;
  recordedAt: string;
}
export interface InventoryVersion extends InventoryRow {
  validTo: CommitPoint | null;
}
export interface InventoryApi {
  importCsv(file: string, options?: CallOptions): Promise<{ cut: CommitPoint; sourceRef: ArtifactRef; rows: number }>;
  list(at?: CommitPoint, options?: CallOptions): Promise<{ cut: CommitPoint; rows: InventoryRow[] }>;
  history(sku: string, at?: CommitPoint, options?: CallOptions): Promise<{ cut: CommitPoint; rows: InventoryVersion[] }>;
  exportSource(ref: ArtifactRef, destination: string, options?: CallOptions): Promise<void>;
}

function failure(code: string, details?: Json, cause?: unknown): AppError {
  return new AppError({ code, messageKey: code, ...(details === undefined ? {} : { details }), cause, retryable: false });
}

async function readBounded(file: string, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const reader = Bun.file(file).stream().getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw failure('inventory.file_too_large', { maxBytes: limit });
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof AppError) throw error;
    throw failure('inventory.read_failed', { file }, error);
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseRows(bytes: Uint8Array, maxRows: number): CsvRow[] {
  let records: unknown;
  let count = 0;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    records = parse(text, {
      bom: true,
      columns(header: string[]) {
        if (header.length !== 3 || header[0] !== 'sku' || header[1] !== 'name' || header[2] !== 'quantity') {
          throw failure('inventory.invalid_header');
        }
        return header;
      },
      skip_empty_lines: true,
      trim: false,
      max_record_size: 65_536,
      on_record(record: unknown) {
        count += 1;
        if (count > maxRows) throw failure('inventory.row_count', { min: 1, max: maxRows });
        return record;
      },
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw failure('inventory.invalid_csv', undefined, error);
  }
  if (!Array.isArray(records) || records.length < 1 || records.length > maxRows) {
    throw failure('inventory.row_count', { min: 1, max: maxRows });
  }
  const seen = new Set<string>();
  return records.map((record, index) => {
    const result = rowSchema.safeParse(record);
    if (!result.success) {
      throw failure('inventory.invalid_row', {
        record: index + 1,
        fields: result.error.issues.map(issue => issue.path.join('.')),
      });
    }
    if (seen.has(result.data.sku)) {
      throw failure('inventory.duplicate_sku', { record: index + 1, sku: result.data.sku });
    }
    seen.add(result.data.sku);
    return { ...result.data, sourceRecord: index + 1 };
  });
}

function chooseCut(requested: CommitPoint | undefined, latest: bigint): bigint {
  if (requested === undefined) return latest;
  if (!/^(0|[1-9][0-9]*)$/.test(requested) || requested.length > 19) {
    throw failure('inventory.invalid_cut', { cut: requested });
  }
  const cut = BigInt(requested);
  if (cut > latest) throw failure('inventory.invalid_cut', { cut: requested, latest: latest.toString() });
  return cut;
}

interface StoredRow {
  sku: string; name: string; quantity: bigint;
  source_ref: string; source_record: bigint;
  valid_from_seq: bigint; valid_to_seq: bigint | null; recorded_at: string;
}
function present(row: StoredRow): InventoryRow {
  return {
    sku: row.sku, name: row.name, quantity: Number(row.quantity),
    sourceRef: row.source_ref, sourceRecord: Number(row.source_record),
    validFrom: row.valid_from_seq.toString(), recordedAt: row.recorded_at,
  };
}

export const inventoryApplication: ApplicationModule<InventoryApi, Settings> = {
  id: 'example.inventory',
  formatId: FORMAT,
  settings: combineSettings(runtimeSettings, inventorySettings),
  locales: { en, 'zh-CN': zhCN },
  async provision(env) {
    const inventorySql = await Bun.file(new URL('./schema.sql', import.meta.url)).text();
    const database = Database.init({
      path: join(env.paths.state, 'main.sqlite'),
      formatId: FORMAT,
      schemaSql: `${contentSchemaSql}\n${inventorySql}`,
      now: () => env.clock.now(),
    });
    database.close();
  },
  async open(env) {
    const database = env.own(Database.open({
      path: join(env.paths.state, 'main.sqlite'),
      formatId: FORMAT,
      readonly: env.mode === 'read-only',
      now: () => env.clock.now(),
    }));
    const cas = env.own(await Cas.open(env.paths.objects));
    const content = env.own(createContent({
      database, cas, maxImportBytes: MAX_FILE_BYTES, maxInlineBytes: MAX_FILE_BYTES,
    }));

    return {
      importCsv(file, options) {
        return env.execution.run('inventory.import', async signal => {
          if (env.mode === 'read-only') {
            throw new AppError({ code: 'runtime.read_only', messageKey: 'runtime.read_only', details: { operation: 'inventory.import' } });
          }
          const settings = env.configuration.snapshot().inventory;
          const absolute = resolve(file);
          const bytes = await readBounded(absolute, settings.maxFileBytes, signal);
          const rows = parseRows(bytes, settings.maxRows);
          signal.throwIfAborted();
          const prepared = await content.materials.prepare({
            bytes, mediaType: 'text/csv', name: basename(absolute),
            origin: {
              kind: 'file', locator: absolute, capturedAt: env.clock.now(),
              metadata: { schema: 'inventory.csv/1', records: rows.length },
            },
          }, { signal });
          try {
            // 所有 await 已结束；此检查之后进入一个完整的同步提交段。
            signal.throwIfAborted();
            return database.write(tx => {
              const source = prepared.adopt(tx);
              tx.sql.query('INSERT INTO inventory_imports(source_ref, commit_seq, row_count) VALUES (?, ?, ?)')
                .run(source.ref, tx.seq, rows.length);
              const retire = tx.sql.query(
                'UPDATE inventory_versions SET valid_to_seq = ? WHERE sku = ? AND valid_to_seq IS NULL',
              );
              const insert = tx.sql.query(`
                INSERT INTO inventory_versions
                  (sku, name, quantity, source_ref, source_record, valid_from_seq, valid_to_seq)
                VALUES (?, ?, ?, ?, ?, ?, NULL)
              `);
              for (const row of rows) {
                retire.run(tx.seq, row.sku);
                insert.run(row.sku, row.name, row.quantity, source.ref, row.sourceRecord, tx.seq);
              }
              return { cut: tx.seq.toString(), sourceRef: source.ref, rows: rows.length };
            });
          } finally {
            // 清理失败保留诊断；已经提交的成功结果继续返回。
            await prepared.close().catch(error => {
              env.diagnostics.log('warn', 'inventory.prepared_close_failed', {
                sourceRef: prepared.info.ref,
                code: error instanceof AppError ? error.code : 'internal.unexpected',
              });
            });
          }
        }, options);
      },

      list(at, options) {
        return env.execution.run('inventory.list', async signal => {
          signal.throwIfAborted();
          return database.read(tx => {
            const cut = chooseCut(at, tx.cut);
            const rows = tx.sql.query<StoredRow, [bigint, bigint]>(`
              SELECT v.*, c.recorded_at
              FROM inventory_versions v JOIN commits c ON c.seq = v.valid_from_seq
              WHERE v.valid_from_seq <= ? AND (v.valid_to_seq IS NULL OR v.valid_to_seq > ?)
              ORDER BY v.sku
            `).all(cut, cut);
            return { cut: cut.toString(), rows: rows.map(present) };
          });
        }, options);
      },

      history(sku, at, options) {
        return env.execution.run('inventory.history', async signal => {
          if (!skuSchema.safeParse(sku).success) throw failure('inventory.invalid_sku', { sku });
          signal.throwIfAborted();
          return database.read(tx => {
            const cut = chooseCut(at, tx.cut);
            const rows = tx.sql.query<StoredRow, [string, bigint]>(`
              SELECT v.*, c.recorded_at
              FROM inventory_versions v JOIN commits c ON c.seq = v.valid_from_seq
              WHERE v.sku = ? AND v.valid_from_seq <= ? ORDER BY v.valid_from_seq
            `).all(sku, cut);
            return {
              cut: cut.toString(),
              rows: rows.map(row => ({
                ...present(row),
                validTo: row.valid_to_seq !== null && row.valid_to_seq <= cut
                  ? row.valid_to_seq.toString() : null,
              })),
            };
          });
        }, options);
      },

      exportSource(ref, destination, options) {
        return env.execution.run('inventory.export', async signal => {
          signal.throwIfAborted();
          const source = database.read(tx => tx.sql.query<{ source_ref: string }, [string]>(
            'SELECT source_ref FROM inventory_imports WHERE source_ref = ?',
          ).get(ref));
          if (!source) throw failure('inventory.source_not_found', { ref });
          await content.materials.export(ref, resolve(destination), { signal });
        }, options);
      },
    };
  },
};

async function main(): Promise<void> {
  const [root, command, ...args] = Bun.argv.slice(2);
  const valid = root && (
    (command === 'init' && args.length === 0) ||
    (command === 'import' && args.length === 1) ||
    (command === 'list' && args.length <= 1) ||
    (command === 'history' && args.length >= 1 && args.length <= 2) ||
    (command === 'export' && args.length === 2)
  );
  if (!valid) throw failure('inventory.usage');
  const instance = Installation.at(resolve(root), inventoryApplication).instance('default');
  if (command === 'init') {
    console.log(JSON.stringify(await instance.init(), null, 2));
    return;
  }

  const controller = new AbortController();
  const cancel = () => controller.abort(new AppError({
    code: 'call.cancelled', messageKey: 'call.cancelled', details: { reason: 'user' },
  }));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let session: Awaited<ReturnType<typeof instance.open>> | undefined;
  try {
    session = await instance.open({
      mode: command === 'import' ? 'read-write' : 'read-only',
      signal: controller.signal,
    });
    const options = { signal: controller.signal };
    let output: unknown;
    if (command === 'import') output = await session.api.importCsv(args[0]!, options);
    else if (command === 'list') output = await session.api.list(args[0], options);
    else if (command === 'history') output = await session.api.history(args[0]!, args[1], options);
    else {
      await session.api.exportSource(args[0]!, args[1]!, options);
      output = { sourceRef: args[0], destination: resolve(args[1]!) };
    }
    console.log(JSON.stringify(output, null, 2));
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    await session?.close();
  }
}

if (import.meta.main) {
  await main().catch(error => {
    const output = error instanceof AppError
      ? { code: error.code, messageKey: error.messageKey, params: error.params, details: error.details, retryable: error.retryable }
      : { code: 'internal.unexpected', message: String(error), retryable: false };
    console.error(JSON.stringify(output));
    process.exitCode = 1;
  });
}
