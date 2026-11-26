import {
  assertResultSource,
  selectionRangeKey,
  type SavedResult,
} from "@themelios/core";
import type { WriteTransaction } from "@themelios/storage";
import { storedArtifact } from "./artifacts.js";
import type { Representation } from "./representations.js";
import { checkExtent } from "./selections.js";

export const representationKey =
  "WHERE source_ref = ? AND range_key = ? AND purpose = ? AND recipe = ?";

/** Indexes only outputs whose saved provenance supports the requested source selection. */
export function registerRepresentation(
  tx: WriteTransaction,
  saved: SavedResult,
  entry: Omit<Representation, "result">,
) {
  const { source, purpose, recipe, outputs } = entry;
  const key = selectionRangeKey(source.range);
  const { sql } = tx;
  checkExtent(storedArtifact(sql, source.ref), source);
  storedArtifact(sql, saved.ref, "result");
  for (const { material } of assertResultSource(saved, source, outputs))
    storedArtifact(sql, material.ref);
  tx.sql.run(
    `INSERT INTO representations (source_ref, range_key, purpose, recipe, result_ref, outputs_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_ref, range_key, purpose, recipe)
      DO UPDATE SET result_ref = excluded.result_ref, outputs_json = excluded.outputs_json`,
    source.ref,
    key,
    purpose,
    recipe,
    saved.ref,
    JSON.stringify(outputs),
  );
}
