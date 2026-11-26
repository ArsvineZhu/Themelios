import type {
  Changes,
  Database as SQLite,
  SQLQueryBindings,
  Statement,
} from "bun:sqlite";
import {
  appError,
  blobRefSchema,
  commitPointSchema,
  type BlobRef,
  type CommitPoint,
  type Instant,
} from "@themelios/core";
import type { BlobInfo } from "./cas.js";

export type BorrowedStatement<Row, Params extends SQLQueryBindings[]> = Pick<
  Statement<Row, Params>,
  "get" | "all" | "run" | "iterate" | "values"
>;

export interface ReadSql {
  query<Row = unknown, Params extends SQLQueryBindings[] = SQLQueryBindings[]>(
    sql: string,
  ): BorrowedStatement<Row, Params>;
  prepare<
    Row = unknown,
    Params extends SQLQueryBindings[] = SQLQueryBindings[],
  >(
    sql: string,
  ): BorrowedStatement<Row, Params>;
}

export interface ReadTransaction {
  readonly sql: ReadSql;
  readonly cut: bigint;
}

export interface WriteTransaction {
  readonly sql: ReadSql & {
    run(sql: string, ...args: SQLQueryBindings[]): Changes;
  };
  readonly seq: bigint;
  readonly recordedAt: Instant;
  /** Register a published CAS object and return its address for an owning row's foreign key. */
  registerBlob(blob: BlobInfo): BlobRef;
}

export type TransactionMode = "read" | "write";

/** The synchronous return value of a transaction callback. */
export type TransactionResult<T> = T & Exclude<T, PromiseLike<unknown>>;

export function registerBlob(
  sql: WriteTransaction["sql"],
  blob: BlobInfo,
): BlobRef {
  const { ref, sizeBytes } = blob;
  if (!blobRefSchema.safeParse(ref).success)
    throw appError("storage.blob_ref_invalid", { details: { blobRef: ref } });
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
    throw appError("storage.options_invalid", {
      details: { field: "sizeBytes" },
    });
  if (
    sql.run(
      "INSERT INTO blobs (ref, size_bytes) VALUES (?, ?) ON CONFLICT(ref) DO NOTHING",
      ref,
      sizeBytes,
    ).changes === 0
  ) {
    const entry = sql
      .query<{ size_bytes: bigint }>(
        "SELECT size_bytes FROM blobs WHERE ref = ?",
      )
      .get(ref)!;
    if (entry.size_bytes !== BigInt(sizeBytes))
      throw appError("storage.blob_corrupt", {
        details: {
          blobRef: ref,
          expected: Number(entry.size_bytes),
          actual: sizeBytes,
        },
      });
  }
  return ref;
}

export function borrowSql(
  connection: SQLite,
  check: () => void,
  cursors: Set<Iterator<unknown>>,
): WriteTransaction["sql"] {
  function borrow<Row, Params extends SQLQueryBindings[]>(
    statement: Statement<Row, Params>,
  ): BorrowedStatement<Row, Params> {
    return {
      get(...args: Params) {
        check();
        return statement.get(...args);
      },
      all(...args: Params) {
        check();
        return statement.all(...args);
      },
      run(...args: Params) {
        check();
        return statement.run(...args);
      },
      values(...args: Params) {
        check();
        return statement.values(...args);
      },
      *iterate(...args: Params) {
        check();
        const cursor = statement.iterate(...args);
        cursors.add(cursor);
        try {
          for (const row of cursor) {
            yield row;
            check();
          }
        } finally {
          cursors.delete(cursor);
        }
      },
    };
  }

  function query<
    Row = unknown,
    Params extends SQLQueryBindings[] = SQLQueryBindings[],
  >(sql: string): BorrowedStatement<Row, Params> {
    check();
    return borrow(connection.query<Row, Params>(sql) as Statement<Row, Params>);
  }
  return {
    query,
    // Bun's query cache owns the statement lifetime across recurring transactions.
    prepare: query,
    run(sql, ...args) {
      check();
      // Bun executes positional and named spread arguments, despite the declaration's nested tuple.
      const run = connection.run as WriteTransaction["sql"]["run"];
      return run.call(connection, sql, ...args);
    },
  };
}

export function synchronousResult<T>(value: T, operation: TransactionMode): T {
  if (
    ((typeof value === "object" && value !== null) ||
      typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  ) {
    // Observe rejection from async callbacks resumed after the transaction closes.
    if (value instanceof Promise) void value.catch(() => undefined);
    throw appError("storage.async_transaction", { details: { operation } });
  }
  return value;
}

function historyFloor(sql: ReadSql): bigint {
  return sql
    .query<{ history_floor: bigint }>(
      "SELECT history_floor FROM store_meta WHERE singleton = 1",
    )
    .get()!.history_floor;
}

export function resolveCut(tx: ReadTransaction, at?: CommitPoint): bigint {
  if (at === undefined) return tx.cut;
  const parsed = commitPointSchema.safeParse(at);
  if (!parsed.success || BigInt(parsed.data) > tx.cut) {
    throw appError("storage.cut_invalid", {
      details: {
        requestedCut: at,
        latestCut: tx.cut.toString(),
      },
    });
  }
  const requested = BigInt(parsed.data);
  const floor = historyFloor(tx.sql);
  if (requested < floor) {
    throw appError("storage.history_unavailable", {
      details: {
        requestedCut: at,
        earliestCut: floor.toString(),
      },
    });
  }
  return requested;
}

/** Advances retention to a previously committed cut within the collection transaction. */
export function advanceHistory(tx: WriteTransaction, at?: CommitPoint): bigint {
  if (at === undefined) return historyFloor(tx.sql);
  const floor = resolveCut({ sql: tx.sql, cut: tx.seq - 1n }, at);
  tx.sql.run(
    "UPDATE store_meta SET history_floor = ? WHERE singleton = 1",
    floor,
  );
  return floor;
}
