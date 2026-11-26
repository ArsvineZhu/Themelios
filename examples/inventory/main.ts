import {
  defineOperation,
  standardPermission,
  instanceOperations,
  type BinaryReadResult,
  type Principal,
} from "@themelios/runtime/operations";
/**
 * CSV 的精确字节与库存版本在一次业务提交中建立来源关系。
 */
import { basename, resolve } from "node:path";
import { parse } from "csv-parse/sync";
import {
  applicationSettings,
  createApplicationModule,
  type ApplicationSettings,
} from "@themelios/application";
import { z } from "zod";
import {
  AppError,
  createFlow,
  artifactRefSchema,
  base64Schema,
  commitPointSchema,
  throwIfAborted,
  streamChunks,
  type ArtifactRef,
  type CallOptions,
  type CommitPoint,
  type Json,
} from "@themelios/core";
import {
  Installation,
  combineSettings,
  createSecrets,
  defineSettings,
  type InstanceInfo,
  type InstancePaths,
  type Session,
} from "@themelios/runtime";
import { resolveCut } from "@themelios/storage";
import { locales as storageLocales } from "@themelios/storage/locales";
import { locales as contentLocales } from "@themelios/content/locales";
import {
  cliServeMode,
  type CliServeMode,
  serveApplication,
  runApplicationCli,
} from "@themelios/transports";
import en from "./resources/locales/en/inventory.json";
import zhCN from "./resources/locales/zh-CN/inventory.json";
import {
  importOutput,
  inventoryExportSchema,
  inventoryHistorySchema,
  inventoryListSchema,
  inventorySchemaSql,
  rowSchema,
  skuSchema,
  type CsvRow,
  type InventoryRow,
} from "./inventory.js";

const FORMAT = "example.inventory";
const inventoryMediaType = "text/csv";
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
    .prefault({}),
});
type InventorySettings = z.infer<typeof inventorySchema>;
type Settings = ApplicationSettings & InventorySettings;

const inventorySettings = defineSettings({
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
});

export interface InventoryApi {
  info(): InstanceInfo & { readonly paths: InstancePaths };
  importCsv(
    input: CsvInput,
    options?: CallOptions,
  ): Promise<z.infer<typeof importOutput>>;
  list(
    at?: CommitPoint,
    options?: CallOptions,
  ): Promise<z.infer<typeof inventoryListSchema>>;
  history(
    sku: string,
    at?: CommitPoint,
    options?: CallOptions,
  ): Promise<z.infer<typeof inventoryHistorySchema>>;
  readSource(
    ref: ArtifactRef,
    options?: CallOptions,
  ): Promise<BinaryReadResult>;
  exportSource(
    ref: ArtifactRef,
    destination: string,
    options?: CallOptions,
  ): Promise<z.infer<typeof inventoryExportSchema>>;
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
  content: ReadableStream<Uint8Array>;
  name?: string | undefined;
};

async function readBounded(
  input: CsvInput,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of streamChunks(input.content, signal)) {
      length += chunk.byteLength;
      if (length > limit)
        throw failure("inventory.file_too_large", { maxBytes: limit });
      chunks.push(new Uint8Array(chunk));
    }
    return Buffer.concat(chunks, length);
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof AppError) throw error;
    throw failure("inventory.read_failed", undefined, error);
  }
}

const csvHeader = ["sku", "name", "quantity"];

function parseRows(bytes: Uint8Array, maxRows: number): CsvRow[] {
  const seen = new Set<string>();
  let count = 0;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const rows = parse<CsvRow, unknown>(text, {
      bom: true,
      columns(header: string[]) {
        if (
          header.length !== csvHeader.length ||
          !csvHeader.every((name, index) => header[index] === name)
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
        const result = rowSchema.safeParse(record);
        if (!result.success) {
          throw failure("inventory.invalid_row", {
            record: count,
            fields: result.error.issues.map((issue) => issue.path.join(".")),
          });
        }
        if (seen.has(result.data.sku)) {
          throw failure("inventory.duplicate_sku", {
            record: count,
            sku: result.data.sku,
          });
        }
        seen.add(result.data.sku);
        return { ...result.data, sourceRecord: count };
      },
    });
    if (rows.length === 0)
      throw failure("inventory.row_count", { min: 1, max: maxRows });
    return rows;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw failure("inventory.invalid_csv", undefined, error);
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

const inventoryApplication = createApplicationModule(
  {
    id: "example.inventory",
    formatId: FORMAT,
    settings: combineSettings(applicationSettings, inventorySettings),
    schemaSql: inventorySchemaSql,
    resourceRoot: import.meta.dir,
    tasks: [],
    locales: {
      en: { ...storageLocales.en, ...contentLocales.en, ...en },
      "zh-CN": {
        ...storageLocales["zh-CN"],
        ...contentLocales["zh-CN"],
        ...zhCN,
      },
    },
  },
  ({ env, database, api }): InventoryApi => {
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
      info: api.info,
      importCsv(input, options) {
        return env.execution.run(
          "inventory.import",
          async (signal, call) => {
            database.requireWritable("inventory.import");
            const settings = env.configuration.snapshot().inventory;
            const bytes = await readBounded(
              input,
              settings.maxFileBytes,
              signal,
            );
            call.progress({ stage: "inventory.read", completed: 1, total: 3 });
            const rows = parseRows(bytes, settings.maxRows);
            call.progress({
              stage: "inventory.parsed",
              completed: 2,
              total: 3,
            });
            call.throwIfAborted();
            const result = await api.materials.adopt(
              {
                bytes,
                mediaType: inventoryMediaType,
                ...(input.name ? { name: input.name } : {}),
                origin: {
                  kind: "application",
                  capturedAt: env.clock.now(),
                  metadata: { schema: "inventory.csv", records: rows.length },
                },
              },
              (tx, source) => {
                tx.sql.run(
                  "INSERT INTO inventory_imports(source_ref, commit_seq, row_count) VALUES (?, ?, ?)",
                  source.ref,
                  tx.seq,
                  rows.length,
                );
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
              },
              { signal },
            );
            call.progress({
              stage: "inventory.committed",
              completed: 3,
              total: 3,
            });
            return result;
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
              const cut = resolveCut(tx, at);
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
              const cut = resolveCut(tx, at);
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
            return api.materials.read(ref, { signal });
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
            const path = resolve(destination);
            await api.materials.export(ref, path, { signal });
            return { sourceRef: ref, destination: path };
          },
          options,
        );
      },
    };
  },
);

const localPrincipal: Principal = {
  id: "local",
  permissions: Object.values(standardPermission),
};

const csvName = z.string().min(1).max(255).optional();
const importJson = z.strictObject({ bytes: base64Schema, name: csvName });
const importUpload = z.strictObject({
  body: z.instanceof(ReadableStream<Uint8Array>),
  mediaType: z.literal(inventoryMediaType),
  name: csvName,
});
const csvInputFromJson = importJson.transform(({ bytes, name }): CsvInput => ({
  content: new Blob([Buffer.from(bytes, "base64")]).stream(),
  name,
}));
const csvInputFromUpload = importUpload.transform(
  ({ body, name }): CsvInput => ({
    content: body,
    name,
  }),
);

export const inventoryOperations = [
  ...instanceOperations<InventoryApi>(),
  defineOperation<InventoryApi>()({
    id: "inventory.import",
    description: "Import a CSV batch of inventory SKU rows.",
    permission: standardPermission.write,
    input: z.union([csvInputFromJson, csvInputFromUpload]),
    binaryInput: csvInputFromUpload,
    output: importOutput,
    mcp: { input: csvInputFromJson },
    http: [
      {
        method: "POST",
        path: "/inventory",
        status: 201,
        binaryBody: true,
        queryStrings: ["name"],
      },
    ],
    cli: {
      command: "import <file>",
      description: "Import inventory rows from a CSV file.",
      parseInput: ([file], _opts, helpers) => {
        const path = resolve(helpers.cwd, file ?? "");
        return {
          body: Bun.file(path).stream(),
          name: basename(path),
          mediaType: inventoryMediaType,
        };
      },
    },
    execute: (app, input, ctx) => app.importCsv(input, ctx.options),
  }),
  defineOperation<InventoryApi>()({
    id: "inventory.importStream",
    description: "Import a CSV and stream ingestion progress.",
    permission: standardPermission.write,
    kind: "stream",
    input: csvInputFromUpload,
    binaryInput: csvInputFromUpload,
    output: importOutput,
    cli: null,
    http: [
      {
        method: "POST",
        path: "/inventory/import-stream",
        binaryBody: true,
        queryStrings: ["name"],
      },
    ],
    execute: (app, input, ctx) =>
      createFlow(
        "inventory.importStream",
        async function* (call) {
          yield {
            type: "progress",
            progress: { stage: "inventory.importing", completed: 0, total: 1 },
          };
          const result = await app.importCsv(input, { signal: call.signal });
          yield {
            type: "progress",
            progress: { stage: "inventory.committed", completed: 1, total: 1 },
          };
          return result;
        },
        ctx.options,
      ),
  }),
  defineOperation<InventoryApi>()({
    id: "inventory.source",
    description: "Download the original CSV bytes.",
    permission: standardPermission.read,
    kind: "binary-read",
    input: z.strictObject({ ref: artifactRefSchema }),
    cli: null,
    http: [
      {
        method: "GET",
        path: "/inventory/source/:ref",
        paramMap: { ref: "ref" },
      },
    ],
    execute: (app, { ref }, ctx) => app.readSource(ref, ctx.options),
  }),
  defineOperation<InventoryApi>()({
    id: "inventory.list",
    description: "List active inventory items at a commit cut.",
    permission: standardPermission.read,
    input: z.strictObject({ at: commitPointSchema.optional() }),
    output: inventoryListSchema,
    mcp: { readOnlyHint: true, idempotentHint: true },
    http: [{ method: "GET", path: "/inventory", queryStrings: ["at"] }],
    cli: {
      command: "list [at]",
      description: "List active inventory rows at an optional commit cut.",
      parseInput: ([at]) => (at === undefined ? {} : { at }),
    },
    execute: (app, { at }, ctx) => app.list(at, ctx.options),
  }),
  defineOperation<InventoryApi>()({
    id: "inventory.history",
    description: "List version history for an inventory SKU.",
    permission: standardPermission.read,
    input: z.strictObject({
      sku: skuSchema,
      at: commitPointSchema.optional(),
    }),
    output: inventoryHistorySchema,
    mcp: { readOnlyHint: true, idempotentHint: true },
    http: [
      {
        method: "GET",
        path: "/inventory/:sku/history",
        paramMap: { sku: "sku" },
        queryStrings: ["at"],
      },
    ],
    cli: {
      command: "history <sku> [at]",
      description: "Show SKU history up to an optional commit cut.",
      parseInput: ([sku, at]) =>
        at === undefined ? { sku: sku ?? "" } : { sku: sku ?? "", at },
    },
    execute: (app, { sku, at }, ctx) => app.history(sku, at, ctx.options),
  }),
  defineOperation<InventoryApi>()({
    id: "inventory.export",
    description: "Export the exact CSV source material by artifact ref.",
    permission: standardPermission.read,
    input: z.strictObject({
      ref: artifactRefSchema,
      destination: z.string().min(1),
    }),
    output: inventoryExportSchema,
    mcp: { expose: false },
    http: [],
    cli: {
      command: "export <ref> <destination>",
      description: "Export original imported CSV bytes to a new path.",
      parseInput: ([ref, destination], _opts, helpers) => ({
        ref: ref ?? "",
        destination: resolve(helpers.cwd, destination ?? ""),
      }),
    },
    execute: (app, { ref, destination }, ctx) =>
      app.exportSource(ref, destination, ctx.options),
  }),
];

async function serveInventory(
  session: Session<InventoryApi, Settings>,
  mode: CliServeMode,
  signal = new AbortController().signal,
): Promise<void> {
  const common = {
    name: "inventory",
    operations: inventoryOperations,
    locale: () => session.configuration.snapshot().locale,
  };
  await serveApplication(session, {
    signal,
    ...(mode === cliServeMode.stdio
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
                    permissions: [
                      standardPermission.read,
                      standardPermission.write,
                    ],
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
