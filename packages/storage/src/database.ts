import { Database as SQLite } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  appError,
  customTimeDomainSchema,
  errorCode,
  parseValue,
  systemClock,
  timeDomainSchema,
  toInstant,
  UTC_TIME_DOMAIN,
  type CommitPoint,
  type CustomTimeDomain,
  type Instant,
  type TimeDomain,
} from "@themelios/core";
import { publishNewFile } from "@themelios/core/files";
import { z } from "zod";
import { storageSchemaSql } from "./schema.js";
import {
  borrowSql,
  registerBlob,
  synchronousResult,
  type ReadSql,
  type ReadTransaction,
  type TransactionMode,
  type TransactionResult,
  type WriteTransaction,
} from "./transaction.js";

export const databaseFileName = "main.sqlite";
const fullSynchronous = "FULL";
export const sqliteSynchronousSchema = z
  .enum([fullSynchronous, "NORMAL"])
  .default(fullSynchronous);
type SqliteSynchronous = z.output<typeof sqliteSynchronousSchema>;

export interface DatabaseOptions {
  path: string;
  formatId: string;
  readonly?: boolean;
  synchronous?: z.input<typeof sqliteSynchronousSchema>;
  busyTimeoutMs?: number;
  now?: () => Instant;
}

/** Owns the read snapshot, write transaction, and ordering of durable commits. */
export class Database {
  readonly sqliteVersion: string;
  readonly #read: SQLite;
  readonly #write: SQLite | undefined;
  readonly #now: () => Instant;
  #inTransaction = false;
  #closed = false;

  private constructor(
    reader: SQLite,
    writer: SQLite | undefined,
    now: () => Instant,
  ) {
    this.#read = reader;
    this.#write = writer;
    this.#now = now;
    this.sqliteVersion = reader
      .query<{ version: string }, []>("SELECT sqlite_version() AS version")
      .get()!.version;
  }

  static init(options: DatabaseOptions & { schemaSql: string }): Database {
    const { path, formatId } = options;
    const busyTimeoutMs = validateBusyTimeout(options.busyTimeoutMs);
    const synchronous = validateSynchronous(options.synchronous);
    publishDatabase(path, "init", (temporary) => {
      const connection = new SQLite(temporary, {
        create: true,
        strict: true,
        safeIntegers: true,
      });
      try {
        connection.exec(
          `PRAGMA foreign_keys = ON; PRAGMA synchronous = ${fullSynchronous}`,
        );
        connection
          .transaction(() => {
            connection.exec(storageSchemaSql);
            if (options.schemaSql.trim()) connection.exec(options.schemaSql);
            connection
              .query<unknown, [string]>(
                "INSERT INTO store_meta (singleton, format_id) VALUES (1, ?)",
              )
              .run(formatId);
          })
          .immediate();
      } finally {
        connection.close(true);
      }
    });
    return Database.#open(options, busyTimeoutMs, synchronous);
  }

  static open(options: DatabaseOptions): Database {
    return Database.#open(
      options,
      validateBusyTimeout(options.busyTimeoutMs),
      validateSynchronous(options.synchronous),
    );
  }

  static #open(
    options: DatabaseOptions,
    busyTimeoutMs: number,
    synchronous: SqliteSynchronous,
  ): Database {
    const { path, formatId } = options;
    const flags = { create: false, strict: true, safeIntegers: true };
    let reader: SQLite | undefined;
    let writer: SQLite | undefined;
    try {
      reader = new SQLite(path, { ...flags, readonly: true });
      reader.exec(
        `PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${busyTimeoutMs}`,
      );
      const hasMetadata = reader
        .query(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'store_meta'",
        )
        .get();
      const actual = hasMetadata
        ? (reader
            .query<{ format_id: string }, []>(
              "SELECT format_id FROM store_meta WHERE singleton = 1",
            )
            .get()?.format_id ?? null)
        : null;
      if (actual !== formatId)
        throw appError("storage.format_mismatch", {
          details: {
            expected: formatId,
            actual,
            path,
          },
        });
      if (!options.readonly) {
        writer = new SQLite(path, flags);
        writer.exec(
          `PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = ${synchronous}`,
        );
      }
      return new Database(reader, writer, options.now ?? systemClock.now);
    } catch (error) {
      writer?.close(true);
      reader?.close(true);
      throw error;
    }
  }

  read<T>(work: (tx: ReadTransaction) => TransactionResult<T>): T {
    return this.#transact(this.#read, "read", (sql) =>
      work({
        sql,
        cut: sql
          .query<{ seq: bigint }>(
            "SELECT COALESCE(MAX(seq), 0) AS seq FROM commits",
          )
          .get()!.seq,
      }),
    );
  }

  write<T>(work: (tx: WriteTransaction) => TransactionResult<T>): T {
    return this.#transact(this.#writable("write"), "write", (sql) => {
      const tx = {
        sql,
        ...this.#recordCommit(sql),
        registerBlob: (blob) => registerBlob(sql, blob),
      } satisfies WriteTransaction;
      return work(tx);
    });
  }

  cut(): CommitPoint {
    return this.read((tx) => tx.cut.toString());
  }

  defineTimeDomain(raw: TimeDomain): TimeDomain {
    const parsed = timeDomainSchema.safeParse(raw);
    if (!parsed.success) {
      throw appError("time.invalid", {
        details: {
          issues: parsed.error.issues.map((i) => ({
            path: i.path.map(String),
            reason: i.message,
          })),
        },
      });
    }
    const domain = parsed.data;
    if (domain.kind === UTC_TIME_DOMAIN.kind) {
      if (domain.label !== UTC_TIME_DOMAIN.label) {
        throw appError("time.domain_conflict", { details: { id: domain.id } });
      }
      return UTC_TIME_DOMAIN;
    }
    const scale = domain.kind === "linear" ? domain.tickSeconds : undefined;
    const num = scale?.numerator ?? null;
    const den = scale?.denominator ?? null;
    return this.#transact(
      this.#writable("defineTimeDomain"),
      "write",
      (sql) => {
        const existing = findTimeDomain(sql, domain.id);
        if (existing) {
          if (
            existing.kind !== domain.kind ||
            existing.label !== domain.label ||
            existing.tick_numerator !== num ||
            existing.tick_denominator !== den
          ) {
            throw appError("time.domain_conflict", {
              details: { id: domain.id },
            });
          }
        } else {
          sql.run(
            `INSERT INTO time_domains (id, kind, label, tick_numerator, tick_denominator, created_seq)
             VALUES (?, ?, ?, ?, ?, ?)`,
            domain.id,
            domain.kind,
            domain.label,
            num,
            den,
            this.#recordCommit(sql).seq,
          );
        }
        return domain;
      },
    );
  }

  getTimeDomain(id: string): TimeDomain | undefined {
    if (id === UTC_TIME_DOMAIN.id) return UTC_TIME_DOMAIN;
    return this.read((tx) => {
      const row = findTimeDomain(tx.sql, id);
      return row ? decodeTimeDomainRow(row) : undefined;
    });
  }

  listTimeDomains(): TimeDomain[] {
    return this.read((tx) => {
      const rows = tx.sql
        .query<TimeDomainRow>(
          "SELECT id, kind, label, tick_numerator, tick_denominator FROM time_domains ORDER BY id",
        )
        .all();
      return [UTC_TIME_DOMAIN, ...rows.map(decodeTimeDomainRow)];
    });
  }

  /** Rejects write preparation before an external participant publishes bytes. */
  requireWritable(operation: string): void {
    this.#writable(operation);
  }

  /** Creates an SQLite-managed snapshot including all committed WAL data. */
  snapshot(destination: string): void {
    this.#check("backup");
    publishDatabase(destination, "snapshot", (temporary) => {
      this.#read.query<unknown, [string]>("VACUUM INTO ?").run(temporary);
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#check("close");
    this.#closed = true;
    try {
      this.#read.close(true);
    } finally {
      if (this.#write) {
        try {
          this.#write.exec("PRAGMA wal_checkpoint(PASSIVE)");
        } finally {
          this.#write.close(true);
        }
      }
    }
  }

  #check(operation: string): void {
    if (this.#closed)
      throw appError("runtime.closed", { details: { state: "closed" } });
    if (this.#inTransaction)
      throw appError("storage.transaction_nested", { details: { operation } });
  }

  #writable(operation: string): SQLite {
    this.#check(operation);
    if (!this.#write)
      throw appError("runtime.read_only", { details: { operation } });
    return this.#write;
  }

  #recordCommit(sql: WriteTransaction["sql"]) {
    const recordedAt = toInstant(this.#now());
    const seq = sql
      .query<{ seq: bigint }>(
        "INSERT INTO commits (seq, recorded_at) SELECT COALESCE(MAX(seq), 0) + 1, ? FROM commits RETURNING seq",
      )
      .get(recordedAt)!.seq;
    return { seq, recordedAt };
  }

  #transact<T>(
    connection: SQLite,
    operation: TransactionMode,
    work: (sql: WriteTransaction["sql"]) => T,
  ): T {
    this.#check(operation);
    const transaction = connection.transaction(() => {
      let open = true;
      const cursors = new Set<Iterator<unknown>>();
      const sql = borrowSql(
        connection,
        () => {
          if (!open)
            throw appError("storage.transaction_closed", {
              details: { operation },
            });
        },
        cursors,
      );
      this.#inTransaction = true;
      try {
        return synchronousResult(work(sql), operation);
      } finally {
        open = false;
        this.#inTransaction = false;
        for (const cursor of cursors) cursor.return?.();
      }
    });
    return operation === "write"
      ? transaction.immediate()
      : transaction.deferred();
  }
}

function validateSynchronous(
  value: DatabaseOptions["synchronous"],
): SqliteSynchronous {
  const parsed = sqliteSynchronousSchema.safeParse(value);
  if (!parsed.success)
    throw appError("storage.options_invalid", {
      details: { field: "synchronous" },
    });
  return parsed.data;
}

function validateBusyTimeout(value = 5000): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647)
    throw appError("storage.options_invalid", {
      details: { field: "busyTimeoutMs" },
    });
  return value;
}

function publishDatabase(
  path: string,
  operation: "init" | "snapshot",
  prepare: (temporary: string) => void,
): void {
  if (existsSync(path))
    throw appError("storage.already_exists", { details: { operation, path } });
  const temporary = join(dirname(path), `.database-${randomUUID()}.partial`);
  try {
    prepare(temporary);
    publishNewFile(temporary, path);
  } catch (cause) {
    throw appError(
      errorCode(cause) === "EEXIST"
        ? "storage.already_exists"
        : "storage.write_failed",
      { details: { operation, path, reason: String(cause) }, cause },
    );
  } finally {
    rmSync(temporary, { force: true });
  }
}

interface TimeDomainRow {
  id: string;
  kind: CustomTimeDomain["kind"];
  label: string;
  tick_numerator: string | null;
  tick_denominator: string | null;
}

function findTimeDomain(sql: ReadSql, id: string) {
  return sql
    .query<TimeDomainRow>(
      "SELECT id, kind, label, tick_numerator, tick_denominator FROM time_domains WHERE id = ?",
    )
    .get(id);
}

function decodeTimeDomainRow(row: TimeDomainRow): CustomTimeDomain {
  return parseValue(
    customTimeDomainSchema,
    {
      id: row.id,
      kind: row.kind,
      label: row.label,
      ...(row.tick_numerator === null && row.tick_denominator === null
        ? {}
        : {
            tickSeconds: {
              numerator: row.tick_numerator,
              denominator: row.tick_denominator,
            },
          }),
    },
    "storage.database_corrupt",
  );
}
