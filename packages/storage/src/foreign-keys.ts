import type { ReadSql } from "./transaction.js";

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Reads parent rows held by main-schema foreign keys to a single-column primary key. */
export function* foreignKeyParents<Row>(
  sql: ReadSql,
  target: {
    table: string;
    key: string;
    columns?: readonly string[];
    excludeOwners?: readonly string[];
  },
): Generator<Row> {
  const { table, key, columns = [key], excludeOwners = [] } = target;
  const owners = sql
    .query<{ table_name: string; column_name: string }>(
      `
      SELECT DISTINCT s.name AS table_name, fk."from" AS column_name
      FROM main.sqlite_schema s JOIN pragma_foreign_key_list(s.name, 'main') fk
      WHERE s.type = 'table' AND fk."table" = ? COLLATE NOCASE
        AND (fk."to" IS NULL OR fk."to" = ? COLLATE NOCASE)
        AND NOT EXISTS (
          SELECT 1 FROM pragma_foreign_key_list(s.name, 'main') component
          WHERE component.id = fk.id AND component.seq > 0
        )
      `,
    )
    .all(table, key);
  const ownerExclusions = new Set(
    excludeOwners.map((name) => name.toLowerCase()),
  );
  const parent = quoteIdentifier(table);
  const parentKey = quoteIdentifier(key);
  const projection = columns
    .map((column) => `p.${quoteIdentifier(column)}`)
    .join(", ");
  for (const { table_name, column_name } of owners) {
    if (ownerExclusions.has(table_name.toLowerCase())) continue;
    const owner = quoteIdentifier(table_name);
    const column = quoteIdentifier(column_name);
    // SQLite foreign keys compare using the parent's affinity and collation.
    yield* sql
      .query<Row>(
        `SELECT DISTINCT ${projection} FROM main.${owner} o
         JOIN main.${parent} p ON p.${parentKey} = +o.${column}`,
      )
      .iterate();
  }
}
