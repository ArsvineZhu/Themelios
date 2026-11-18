import type { WriteTransaction } from "@themelios/storage";
import type { Representation } from "./representations.js";
import { rangeKey } from "./selections.js";

export const activeRepresentation =
  "WHERE source_ref = ? AND range_key = ? AND purpose = ? AND recipe = ? AND retired_seq IS NULL";

export function registerRepresentation(
  tx: WriteTransaction,
  entry: Representation,
) {
  const { source, purpose, recipe, result, outputs } = entry;
  const key = rangeKey(source.range);
  tx.sql.run(
    `UPDATE representations SET retired_seq = ? ${activeRepresentation} AND created_seq < ?`,
    tx.seq,
    source.ref,
    key,
    purpose,
    recipe,
    tx.seq,
  );
  tx.sql.run(
    `INSERT INTO representations (source_ref, range_key, purpose, recipe, result_ref, outputs_json, created_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_ref, range_key, purpose, recipe, created_seq)
      DO UPDATE SET result_ref = excluded.result_ref, outputs_json = excluded.outputs_json`,
    source.ref,
    key,
    purpose,
    recipe,
    result,
    JSON.stringify(outputs),
    tx.seq,
  );
}
