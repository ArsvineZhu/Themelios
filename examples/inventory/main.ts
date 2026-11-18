import {
  defineOperation,
  instanceOperations,
  type BinaryReadResult,
  type Principal,
} from "@themelios/runtime/operations";
/**
 * CSV 的精确字节与库存版本在一次业务提交中建立来源关系。
 */
import { basename, join, resolve } from "node:path";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import {
  AppError,
  createFlow,
  artifactRefSchema,
  commitPointSchema,
  throwIfAborted,
  type ArtifactRef,
  type CallOptions,
  type CommitPoint,
  type Json,
} from "@themelios/core";
import {
  Installation,
  combineSettings,
  createSecrets,
  runtimeSettings,
  type ApplicationModule,
  type InstanceInfo,
  type InstancePaths,
  type RuntimeSettings,
  type Session,
  type SettingsDefinition,
} from "@themelios/runtime";
import {
  Cas,
  Database,
  resolveCut,
  type ReadTransaction,
} from "@themelios/storage";
import { locales as storageLocales } from "@themelios/storage/locales";
import { createContent } from "@themelios/content";
import { contentSchemaSql } from "@themelios/content/schema";
import { locales as contentLocales } from "@themelios/content/locales";
import { serveApplication, runApplicationCli } from "@themelios/transports";
import en from "./resources/locales/en/inventory.json";
import zhCN from "./resources/locales/zh-CN/inventory.json";

const FORMAT = "example.inventory";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const inventorySchema = z.object({
  inventory: z
    .object({
      maxFileBytes: z
        .number()
        .int()
        .min(1)
        .max(MAX_FILE_BYTES)
        .default(2 * 1024 * 1024),
      maxRows: z.number().int().min(1).max(100_000).default(5_000),
    })
    .default({ maxFileBytes: 2 * 1024 * 1024, maxRows: 5_000 }),
});
type InventorySettings = z.infer<typeof inventorySchema>;
type Settings = RuntimeSettings & InventorySettings;

const inventorySettings: SettingsDefinition<InventorySettings> = {
  schema: inventorySchema,
  fields: {
    "/inventory/maxFileBytes": {
      titleKey: "inventory.settings.maxFileBytes.title",
      descriptionKey: "inventory.settings.maxFileBytes.description",
      impactKey: "inventory.settings.maxFileBytes.impact",
      scopes: ["installation", "instance"],
      effect: "next-call",
      unit: "bytes",
    },
    "/inventory/maxRows": {
      titleKey: "inventory.settings.maxRows.title",
      descriptionKey: "inventory.settings.maxRows.description",
      impactKey: "inventory.settings.maxRows.impact",
      scopes: ["installation", "instance"],
      effect: "next-call",
      unit: "records",
    },
  },
};

const skuSchema = z.string().regex(/^[A-Z0-9._-]{1,64}$/);
const rowSchema = z
  .object({
    sku: skuSchema,
    name: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.trim().length > 0),
    quantity: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .transform(Number)
      .pipe(z.number().int().min(0).max(1_000_000_000)),
  })
  .strict();
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
  info(): InstanceInfo & { readonly paths: InstancePaths };
  importCsv(
    input: CsvInput,
    options?: CallOptions,
  ): Promise<{ cut: CommitPoint; sourceRef: ArtifactRef; rows: number }>;
  list(
    at?: CommitPoint,
    options?: CallOptions,
  ): Promise<{ cut: CommitPoint; rows: InventoryRow[] }>;
  history(
    sku: string,
    at?: CommitPoint,
    options?: CallOptions,
  ): Promise<{ cut: CommitPoint; rows: InventoryVersion[] }>;
  readSource(
    ref: ArtifactRef,
    options?: CallOptions,
  ): Promise<BinaryReadResult>;
  exportSource(
    ref: ArtifactRef,
    destination: string,
    options?: CallOptions,
  ): Promise<void>;
}

function failure(code: string, details?: Json, cause?: unknown): AppError {
  return new AppError({
    code,
    messageKey: code,
    ...(details === undefined ? {} : { details }),
    cause,
    retryable: false,
  });
}

export type CsvInput = {
  content: Uint8Array | ReadableStream<Uint8Array>;
  name?: string | undefined;
};

async function readBounded(
  input: CsvInput,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (input.content instanceof Uint8Array) {
    throwIfAborted(signal);
    if (input.content.byteLength > limit)
      throw failure("inventory.file_too_large", { maxBytes: limit });
    return input.content.slice();
  }
  const reader = input.content.getReader();
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      throwIfAborted(signal);
      const next = await reader.read();
      throwIfAborted(signal);
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit)
        throw failure("inventory.file_too_large", { maxBytes: limit });
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
    throwIfAborted(signal);
    if (error instanceof AppError) throw error;
    throw failure("inventory.read_failed", undefined, error);
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseRows(bytes: Uint8Array, maxRows: number): CsvRow[] {
  let records: unknown;
  let count = 0;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    records = parse(text, {
      bom: true,
      columns(header: string[]) {
        if (
          header.length !== 3 ||
          header[0] !== "sku" ||
          header[1] !== "name" ||
          header[2] !== "quantity"
        ) {
          throw failure("inventory.invalid_header");
        }
        return header;
      },
      skip_empty_lines: true,
      trim: false,
      max_record_size: 65_536,
      on_record(record: unknown) {
        count += 1;
        if (count > maxRows)
          throw failure("inventory.row_count", { min: 1, max: maxRows });
        return record;
      },
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw failure("inventory.invalid_csv", undefined, error);
  }
  if (
    !Array.isArray(records) ||
    records.length < 1 ||
    records.length > maxRows
  ) {
    throw failure("inventory.row_count", { min: 1, max: maxRows });
  }
  const seen = new Set<string>();
  return records.map((record, index) => {
    const result = rowSchema.safeParse(record);
    if (!result.success) {
      throw failure("inventory.invalid_row", {
        record: index + 1,
        fields: result.error.issues.map((issue) => issue.path.join(".")),
      });
    }
    if (seen.has(result.data.sku)) {
      throw failure("inventory.duplicate_sku", {
        record: index + 1,
        sku: result.data.sku,
      });
    }
    seen.add(result.data.sku);
    return { ...result.data, sourceRecord: index + 1 };
  });
}

function chooseCut(
  requested: CommitPoint | undefined,
  tx: ReadTransaction,
): bigint {
  try {
    return resolveCut(tx, requested);
  } catch (error) {
    if (
      error instanceof AppError &&
      error.code === "storage.cut_invalid" &&
      requested !== undefined
    ) {
      throw failure("inventory.invalid_cut", {
        cut: requested,
        latest: tx.cut.toString(),
      });
    }
    throw error;
  }
}

interface StoredRow {
  sku: string;
  name: string;
  quantity: bigint;
  source_ref: string;
  source_record: bigint;
  valid_from_seq: bigint;
  valid_to_seq: bigint | null;
  recorded_at: string;
}
function present(row: StoredRow): InventoryRow {
  return {
    sku: row.sku,
    name: row.name,
    quantity: Number(row.quantity),
    sourceRef: row.source_ref,
    sourceRecord: Number(row.source_record),
    validFrom: row.valid_from_seq.toString(),
    recordedAt: row.recorded_at,
  };
}

export const inventoryApplication: ApplicationModule<InventoryApi, Settings> = {
  id: "example.inventory",
  formatId: FORMAT,
  settings: combineSettings(runtimeSettings, inventorySettings),
  locales: {
    en: { ...storageLocales.en, ...contentLocales.en, ...en },
    "zh-CN": {
      ...storageLocales["zh-CN"],
      ...contentLocales["zh-CN"],
      ...zhCN,
    },
  },
  async provision(env) {
    const inventorySql = await Bun.file(
      new URL("./schema.sql", import.meta.url),
    ).text();
    const database = Database.init({
      path: join(env.paths.state, "main.sqlite"),
      formatId: FORMAT,
      schemaSql: `${contentSchemaSql}\n${inventorySql}`,
      now: () => env.clock.now(),
    });
    database.close();
  },
  async open(env) {
    const database = env.own(
      Database.open({
        path: join(env.paths.state, "main.sqlite"),
        formatId: FORMAT,
        readonly: env.mode === "read-only",
        now: () => env.clock.now(),
      }),
    );
    const cas = env.own(await Cas.open(env.paths.objects));
    const content = env.own(
      createContent({
        database,
        cas,
        maxImportBytes: MAX_FILE_BYTES,
        maxInlineBytes: MAX_FILE_BYTES,
      }),
    );

    function checkSource(ref: ArtifactRef) {
      const source = database.read((tx) =>
        tx.sql
          .query<{ source_ref: string }, [string]>(
            "SELECT source_ref FROM inventory_imports WHERE source_ref = ?",
          )
          .get(ref),
      );
      if (!source) throw failure("inventory.source_not_found", { ref });
    }

    return {
      info: () => ({ ...env.instance, paths: env.paths }),
      importCsv(input, options) {
        return env.execution.run(
          "inventory.import",
          async (signal) => {
            if (env.mode === "read-only") {
              throw new AppError({
                code: "runtime.read_only",
                messageKey: "runtime.read_only",
                details: { operation: "inventory.import" },
              });
            }
            const settings = env.configuration.snapshot().inventory;
            const progress = options?.onProgress;
            const bytes = await readBounded(
              input,
              settings.maxFileBytes,
              signal,
            );
            progress?.({ stage: "inventory.read", completed: 1, total: 3 });
            const rows = parseRows(bytes, settings.maxRows);
            progress?.({ stage: "inventory.parsed", completed: 2, total: 3 });
            throwIfAborted(signal);
            const prepared = await content.materials.prepare(
              {
                bytes,
                mediaType: "text/csv",
                ...(input.name ? { name: input.name } : {}),
                origin: {
                  kind: "application",
                  capturedAt: env.clock.now(),
                  metadata: { schema: "inventory.csv", records: rows.length },
                },
              },
              { signal },
            );
            try {
              // 所有 await 已结束；此检查之后进入一个完整的同步提交段。
              throwIfAborted(signal);
              const result = database.write((tx) => {
                const source = prepared.adopt(tx);
                tx.sql
                  .query(
                    "INSERT INTO inventory_imports(source_ref, commit_seq, row_count) VALUES (?, ?, ?)",
                  )
                  .run(source.ref, tx.seq, rows.length);
                const retire = tx.sql.query(
                  "UPDATE inventory_versions SET valid_to_seq = ? WHERE sku = ? AND valid_to_seq IS NULL",
                );
                const insert = tx.sql.query(`
                INSERT INTO inventory_versions
                  (sku, name, quantity, source_ref, source_record, valid_from_seq, valid_to_seq)
                VALUES (?, ?, ?, ?, ?, ?, NULL)
              `);
                for (const row of rows) {
                  retire.run(tx.seq, row.sku);
                  insert.run(
                    row.sku,
                    row.name,
                    row.quantity,
                    source.ref,
                    row.sourceRecord,
                    tx.seq,
                  );
                }
                return {
                  cut: tx.seq.toString(),
                  sourceRef: source.ref,
                  rows: rows.length,
                };
              });
              progress?.({
                stage: "inventory.committed",
                completed: 3,
                total: 3,
              });
              return result;
            } finally {
              // 清理失败保留诊断；已经提交的成功结果继续返回。
              await prepared.close().catch((error) => {
                env.diagnostics.log("warn", "inventory.prepared_close_failed", {
                  sourceRef: prepared.info.ref,
                  code:
                    error instanceof AppError
                      ? error.code
                      : "internal.unexpected",
                });
              });
            }
          },
          options,
        );
      },

      list(at, options) {
        return env.execution.run(
          "inventory.list",
          async (signal) => {
            throwIfAborted(signal);
            return database.read((tx) => {
              const cut = chooseCut(at, tx);
              const rows = tx.sql
                .query<StoredRow, [bigint, bigint]>(
                  `
              SELECT v.*, c.recorded_at
              FROM inventory_versions v JOIN commits c ON c.seq = v.valid_from_seq
              WHERE v.valid_from_seq <= ? AND (v.valid_to_seq IS NULL OR v.valid_to_seq > ?)
              ORDER BY v.sku
            `,
                )
                .all(cut, cut);
              return { cut: cut.toString(), rows: rows.map(present) };
            });
          },
          options,
        );
      },

      history(sku, at, options) {
        return env.execution.run(
          "inventory.history",
          async (signal) => {
            if (!skuSchema.safeParse(sku).success)
              throw failure("inventory.invalid_sku", { sku });
            throwIfAborted(signal);
            return database.read((tx) => {
              const cut = chooseCut(at, tx);
              const rows = tx.sql
                .query<StoredRow, [string, bigint]>(
                  `
              SELECT v.*, c.recorded_at
              FROM inventory_versions v JOIN commits c ON c.seq = v.valid_from_seq
              WHERE v.sku = ? AND v.valid_from_seq <= ? ORDER BY v.valid_from_seq
            `,
                )
                .all(sku, cut);
              return {
                cut: cut.toString(),
                rows: rows.map((row) => ({
                  ...present(row),
                  validTo:
                    row.valid_to_seq !== null && row.valid_to_seq <= cut
                      ? row.valid_to_seq.toString()
                      : null,
                })),
              };
            });
          },
          options,
        );
      },

      readSource(ref, options) {
        return env.execution.run(
          "inventory.source",
          async (signal) => {
            checkSource(ref);
            return content.materials.read(ref, { signal });
          },
          options,
        );
      },

      exportSource(ref, destination, options) {
        return env.execution.run(
          "inventory.export",
          async (signal) => {
            throwIfAborted(signal);
            checkSource(ref);
            await content.materials.export(ref, resolve(destination), {
              signal,
            });
          },
          options,
        );
      },
    };
  },
};

const localPrincipal: Principal = {
  id: "local",
  permissions: ["read", "write", "admin"],
};

const csvName = z.string().min(1).max(255).optional();
const importJson = z.strictObject({ bytes: z.base64(), name: csvName });
const importUpload = z.strictObject({
  body: z.instanceof(ReadableStream<Uint8Array>),
  mediaType: z.literal("text/csv"),
  name: csvName,
});
const importOutput = z.strictObject({
  cut: commitPointSchema,
  sourceRef: artifactRefSchema,
  rows: z.int().nonnegative(),
});
type ImportInput = z.infer<typeof importJson> | z.infer<typeof importUpload>;

export const inventoryOperations = [
  ...instanceOperations<InventoryApi>(),
  defineOperation<InventoryApi, ImportInput, z.infer<typeof importOutput>>({
    id: "inventory.import",
    description: "Import a CSV batch of inventory SKU rows.",
    permission: "write",
    input: z.union([importJson, importUpload]),
    output: importOutput,
    mcp: { input: importJson },
    http: {
      method: "POST",
      path: "/inventory",
      status: 201,
      binaryInput: importUpload,
      queryStrings: ["name"],
    },
    cli: {
      command: "import <file>",
      description: "Import inventory rows from a CSV file.",
      parseInput: ([file], _opts, helpers) => {
        const path = resolve(helpers.cwd, file ?? "");
        return {
          body: Bun.file(path).stream(),
          name: basename(path),
          mediaType: "text/csv",
        };
      },
    },
    execute: (app, input, ctx) =>
      app.importCsv(
        {
          content:
            "body" in input ? input.body : Buffer.from(input.bytes, "base64"),
          name: input.name,
        },
        ctx.options,
      ),
  }),
  defineOperation<
    InventoryApi,
    z.infer<typeof importUpload>,
    z.infer<typeof importOutput>
  >({
    id: "inventory.importStream",
    description: "Import a CSV and stream ingestion progress.",
    permission: "write",
    kind: "stream",
    input: importUpload,
    output: importOutput,
    cli: false,
    http: {
      method: "POST",
      path: "/inventory/import-stream",
      binaryInput: importUpload,
      queryStrings: ["name"],
    },
    execute: (app, input, ctx) =>
      createFlow(
        "inventory.importStream",
        async function* (call) {
          yield {
            type: "progress",
            progress: { stage: "inventory.importing", completed: 0, total: 1 },
          };
          const result = await app.importCsv(
            { content: input.body, name: input.name },
            { signal: call.signal },
          );
          yield {
            type: "progress",
            progress: { stage: "inventory.committed", completed: 1, total: 1 },
          };
          return result;
        },
        ctx.options,
      ),
  }),
  defineOperation<InventoryApi, { ref: ArtifactRef }, BinaryReadResult>({
    id: "inventory.source",
    description: "Download the original CSV bytes.",
    permission: "read",
    kind: "binary-read",
    input: z.strictObject({ ref: artifactRefSchema }),
    cli: false,
    http: {
      method: "GET",
      path: "/inventory/source/:ref",
      paramMap: { ref: "ref" },
    },
    execute: (app, { ref }, ctx) => app.readSource(ref, ctx.options),
  }),
  defineOperation<
    InventoryApi,
    { at?: CommitPoint | undefined },
    { cut: CommitPoint; rows: InventoryRow[] }
  >({
    id: "inventory.list",
    description: "List active inventory items at a commit cut.",
    permission: "read",
    input: z.strictObject({ at: commitPointSchema.optional() }),
    mcp: { readOnlyHint: true, idempotentHint: true },
    http: { method: "GET", path: "/inventory", queryStrings: ["at"] },
    cli: {
      command: "list [at]",
      description: "List active inventory rows at an optional commit cut.",
      parseInput: ([at]) => (at === undefined ? {} : { at }),
    },
    execute: (app, { at }, ctx) => app.list(at, ctx.options),
  }),
  defineOperation<
    InventoryApi,
    { sku: string; at?: CommitPoint | undefined },
    { cut: CommitPoint; rows: InventoryVersion[] }
  >({
    id: "inventory.history",
    description: "List version history for an inventory SKU.",
    permission: "read",
    input: z.strictObject({
      sku: skuSchema,
      at: commitPointSchema.optional(),
    }),
    mcp: { readOnlyHint: true, idempotentHint: true },
    http: {
      method: "GET",
      path: "/inventory/:sku/history",
      paramMap: { sku: "sku" },
      queryStrings: ["at"],
    },
    cli: {
      command: "history <sku> [at]",
      description: "Show SKU history up to an optional commit cut.",
      parseInput: ([sku, at]) =>
        at === undefined ? { sku: sku ?? "" } : { sku: sku ?? "", at },
    },
    execute: (app, { sku, at }, ctx) => app.history(sku, at, ctx.options),
  }),
  defineOperation<
    InventoryApi,
    { ref: ArtifactRef; destination: string },
    { sourceRef: ArtifactRef; destination: string }
  >({
    id: "inventory.export",
    description: "Export the exact CSV source material by artifact ref.",
    permission: "read",
    input: z.strictObject({
      ref: artifactRefSchema,
      destination: z.string().min(1),
    }),
    mcp: { expose: false },
    http: false,
    cli: {
      command: "export <ref> <destination>",
      description: "Export original imported CSV bytes to a new path.",
      parseInput: ([ref, destination], _opts, helpers) => ({
        ref: ref ?? "",
        destination: resolve(helpers.cwd, destination ?? ""),
      }),
    },
    async execute(app, { ref, destination }, ctx) {
      await app.exportSource(ref, destination, ctx.options);
      return { sourceRef: ref, destination };
    },
  }),
];

async function serveInventory(
  session: Session<InventoryApi, Settings>,
  mode: "serve" | "stdio",
  signal = new AbortController().signal,
): Promise<void> {
  const common = {
    name: "inventory",
    operations: inventoryOperations,
    locale: () => session.configuration.snapshot().locale,
  };
  await serveApplication(session, {
    signal,
    ...(mode === "stdio"
      ? {
          stdio: { ...common, principal: localPrincipal },
        }
      : {
          http: {
            address: {
              host: "127.0.0.1",
              port: Number(process.env.THEMELIOS_HTTP_PORT ?? "0"),
            },
            options: {
              ...common,
              enableMcp: true,
              secrets: createSecrets({
                baseDir: session.instance.paths.config,
              }),
              policy: () => ({
                maxJsonBytes: 12 * 1024 * 1024,
                authTokens: {
                  inventory: {
                    secret: "env:THEMELIOS_INVENTORY_TOKEN",
                    permissions: ["read", "write"],
                  },
                },
                allowedHosts: ["localhost", "127.0.0.1"],
                allowedOrigins: [],
              }),
            },
          },
          ready: (endpoints: Readonly<Record<string, string>>) => {
            process.stderr.write(
              JSON.stringify({ event: "inventory.ready", endpoints }) + "\n",
            );
          },
        }),
  });
}

if (import.meta.main) {
  const controller = new AbortController();
  const stop = () => controller.abort("interrupted");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const cwd = process.cwd();
    const useInstallation = (root: string) =>
      Installation.at(resolve(cwd, root), inventoryApplication);
    process.exitCode = await runApplicationCli(
      useInstallation("."),
      process.argv.slice(2),
      {
        name: "inventory",
        description:
          "Import CSV inventory batches and query historical versions.",
        principal: localPrincipal,
        operations: inventoryOperations,
        cwd,
        signal: controller.signal,
        useInstallation,
        serve: serveInventory,
      },
    );
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
