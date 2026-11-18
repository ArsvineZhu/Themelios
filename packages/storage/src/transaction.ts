import type {
  Changes,
  Database as SQLite,
  SQLQueryBindings,
  Statement,
} from "bun:sqlite";
import type { CommitPoint, Instant } from "@themelios/core";
import { commitPointSchema } from "@themelios/core";
import { storageError } from "./errors.js";

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

export function synchronousResult<T>(value: T, operation: "read" | "write"): T {
  if (
    ((typeof value === "object" && value !== null) ||
      typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  ) {
    // Observe rejection from async callbacks resumed after the transaction closes.
    if (value instanceof Promise) void value.catch(() => undefined);
    throw storageError("storage.async_transaction", { operation });
  }
  return value;
}

export function resolveCut(tx: ReadTransaction, at?: CommitPoint): bigint {
  if (at === undefined) return tx.cut;
  const parsed = commitPointSchema.safeParse(at);
  if (!parsed.success || BigInt(parsed.data) > tx.cut) {
    throw storageError("storage.cut_invalid", {
      requestedCut: at,
      latestCut: tx.cut.toString(),
    });
  }
  const requested = BigInt(parsed.data);
  const { history_floor: floor } = tx.sql
    .query<{ history_floor: bigint }>(
      "SELECT history_floor FROM store_meta WHERE singleton = 1",
    )
    .get()!;
  if (requested < floor) {
    throw storageError("storage.history_unavailable", {
      requestedCut: at,
      earliestCut: floor.toString(),
    });
  }
  return requested;
}
