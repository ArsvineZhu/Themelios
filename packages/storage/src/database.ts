import { Database as SQLite } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  timeDomainSchema,
  toInstant,
  UTC_TIME_DOMAIN,
  type CommitPoint,
  type Instant,
  type TimeDomain,
} from "@themelios/core";
import { fileErrorCode, storageError } from "./errors.js";
import { storageSchemaSql } from "./schema.js";
import {
  borrowSql,
  synchronousResult,
  type ReadTransaction,
  type WriteTransaction,
} from "./transaction.js";

export interface DatabaseOptions {
  path: string;
  formatId: string;
  readonly?: boolean;
  synchronous?: "FULL" | "NORMAL";
  busyTimeoutMs?: number;
  now?: () => Instant;
}

/** Owns the read snapshot, write transaction, and ordering of durable commits. */
export class Database {
  readonly sqliteVersion: string;
  readonly #read: SQLite;
  readonly #write: SQLite | undefined;
  readonly #now: () => Instant;
  #active: ReadTransaction | WriteTransaction | undefined;
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
    if (existsSync(path))
      throw storageError("storage.already_exists", { operation: "init", path });
    const temporary = join(dirname(path), `.database-${randomUUID()}.partial`);
    try {
      const connection = new SQLite(temporary, {
        create: true,
        strict: true,
        safeIntegers: true,
      });
      try {
        connection.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL");
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
      linkSync(temporary, path);
    } catch (error) {
      if (fileErrorCode(error) === "EEXIST")
        throw storageError("storage.already_exists", {
          operation: "init",
          path,
        });
      throw storageError(
        "storage.write_failed",
        { operation: "init", path, reason: String(error) },
        error,
      );
    } finally {
      rmSync(temporary, { force: true });
    }
    return Database.open(options);
  }

  static open(options: DatabaseOptions): Database {
    const {
      path,
      formatId,
      busyTimeoutMs = 5000,
      synchronous = "FULL",
    } = options;
    if (
      !Number.isSafeInteger(busyTimeoutMs) ||
      busyTimeoutMs < 0 ||
      busyTimeoutMs > 2147483647
    ) {
      throw storageError("storage.options_invalid", { field: "busyTimeoutMs" });
    }
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
        throw storageError("storage.format_mismatch", {
          expected: formatId,
          actual,
          path,
        });
      if (!options.readonly) {
        writer = new SQLite(path, flags);
        const durability = synchronous === "NORMAL" ? "NORMAL" : "FULL";
        writer.exec(
          `PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = ${durability}`,
        );
      }
      return new Database(
        reader,
        writer,
        options.now ?? (() => new Date().toISOString()),
      );
    } catch (error) {
      writer?.close(true);
      reader?.close(true);
      throw error;
    }
  }

  read<T>(work: (tx: ReadTransaction) => T): T {
    return this.#transact(
      this.#read,
      "read",
      (sql) => ({
        sql,
        cut: sql
          .query<{ commit_seq: bigint }>(
            "SELECT commit_seq FROM store_meta WHERE singleton = 1",
          )
          .get()!.commit_seq,
      }),
      work,
    );
  }

  write<T>(work: (tx: WriteTransaction) => T): T {
    this.requireWritable("write");
    return this.#transact(
      this.#write!,
      "write",
      (sql) => {
        const seq = sql
          .query<{ commit_seq: bigint }>(
            "UPDATE store_meta SET commit_seq = commit_seq + 1 WHERE singleton = 1 RETURNING commit_seq",
          )
          .get()!.commit_seq;
        const recordedAt = toInstant(this.#now());
        sql.run(
          "INSERT INTO commits (seq, recorded_at) VALUES (?, ?)",
          seq,
          recordedAt,
        );
        return { sql, seq, recordedAt };
      },
      work,
    );
  }

  cut(): CommitPoint {
    return this.read((tx) => tx.cut.toString());
  }

  defineTimeDomain(raw: TimeDomain): TimeDomain {
    const parsed = timeDomainSchema.safeParse(raw);
    if (!parsed.success) {
      throw storageError("time.invalid", {
        issues: parsed.error.issues.map((i) => ({
          path: i.path.map(String),
          reason: i.message,
        })),
      });
    }
    const domain = parsed.data;
    if (domain.kind === "utc") {
      if (domain.label !== UTC_TIME_DOMAIN.label) {
        throw storageError("time.domain_conflict", { id: domain.id });
      }
      return UTC_TIME_DOMAIN;
    }
    const num =
      domain.kind === "linear" ? (domain.tickSeconds?.numerator ?? null) : null;
    const den =
      domain.kind === "linear"
        ? (domain.tickSeconds?.denominator ?? null)
        : null;
    return this.write((tx) => {
      const inserted = tx.sql.run(
        `INSERT INTO time_domains (id, kind, label, tick_numerator, tick_denominator, created_seq)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        domain.id,
        domain.kind,
        domain.label,
        num,
        den,
        tx.seq,
      ).changes;
      if (inserted > 0) return domain;
      const existing = tx.sql
        .query<{
          id: string;
          kind: string;
          label: string;
          tick_numerator: string | null;
          tick_denominator: string | null;
        }>(
          "SELECT id, kind, label, tick_numerator, tick_denominator FROM time_domains WHERE id = ?",
        )
        .get(domain.id)!;
      if (
        existing.kind !== domain.kind ||
        existing.label !== domain.label ||
        existing.tick_numerator !== num ||
        existing.tick_denominator !== den
      ) {
        throw storageError("time.domain_conflict", { id: domain.id });
      }
      return domain;
    });
  }

  getTimeDomain(id: string): TimeDomain | undefined {
    if (id === "utc") return UTC_TIME_DOMAIN;
    return this.read((tx) => {
      const row = tx.sql
        .query<{
          id: string;
          kind: "linear" | "opaque";
          label: string;
          tick_numerator: string | null;
          tick_denominator: string | null;
        }>(
          "SELECT id, kind, label, tick_numerator, tick_denominator FROM time_domains WHERE id = ?",
        )
        .get(id);
      return row ? decodeTimeDomainRow(row) : undefined;
    });
  }

  listTimeDomains(): TimeDomain[] {
    return this.read((tx) => {
      const rows = tx.sql
        .query<{
          id: string;
          kind: "linear" | "opaque";
          label: string;
          tick_numerator: string | null;
          tick_denominator: string | null;
        }>(
          "SELECT id, kind, label, tick_numerator, tick_denominator FROM time_domains ORDER BY id",
        )
        .all();
      return [UTC_TIME_DOMAIN, ...rows.map(decodeTimeDomainRow)];
    });
  }

  /** Rejects write preparation before an external participant publishes bytes. */
  requireWritable(operation: string): void {
    this.#check(operation);
    if (!this.#write) throw storageError("runtime.read_only", { operation });
  }

  /** Allows a participant to verify the exact transaction it is joining. */
  owns(tx: WriteTransaction): boolean {
    return this.#active === tx;
  }

  /** Creates an SQLite-managed snapshot including all committed WAL data. */
  snapshot(destination: string): void {
    this.#check("backup");
    this.#read.query<unknown, [string]>("VACUUM INTO ?").run(destination);
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
    if (this.#closed) throw storageError("runtime.closed", { state: "closed" });
    if (this.#inTransaction)
      throw storageError("storage.transaction_nested", { operation });
  }

  #transact<T, Tx extends ReadTransaction | WriteTransaction>(
    connection: SQLite,
    operation: "read" | "write",
    make: (sql: WriteTransaction["sql"]) => Tx,
    work: (tx: Tx) => T,
  ): T {
    this.#check(operation);
    const transaction = connection.transaction(() => {
      let open = true;
      const cursors = new Set<Iterator<unknown>>();
      const sql = borrowSql(
        connection,
        () => {
          if (!open)
            throw storageError("storage.transaction_closed", { operation });
        },
        cursors,
      );
      this.#inTransaction = true;
      try {
        const tx = make(sql);
        this.#active = tx;
        return synchronousResult(work(tx), operation);
      } finally {
        open = false;
        this.#active = undefined;
        this.#inTransaction = false;
        for (const cursor of cursors) cursor.return?.();
      }
    });
    return operation === "write"
      ? transaction.immediate()
      : transaction.deferred();
  }
}

function decodeTimeDomainRow(row: {
  id: string;
  kind: "linear" | "opaque";
  label: string;
  tick_numerator: string | null;
  tick_denominator: string | null;
}): TimeDomain {
  if (row.kind === "opaque") {
    return { id: row.id, kind: "opaque", label: row.label };
  }
  return {
    id: row.id,
    kind: "linear",
    label: row.label,
    ...(row.tick_numerator !== null && row.tick_denominator !== null
      ? {
          tickSeconds: {
            numerator: row.tick_numerator,
            denominator: row.tick_denominator,
          },
        }
      : {}),
  };
}
