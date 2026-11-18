import { artifactRefSchema, selectionSchema } from "@themelios/core";
import type { Cas, Database } from "@themelios/storage";
import { z } from "zod";
import { storedArtifact } from "./artifacts.js";
import type { Representation, Representations } from "./contracts.js";
import { selectOutput } from "./result-graph.js";
import { parseManifest } from "./results.js";
import { checkExtent, rangeKey, utf8Text } from "./selections.js";
import { validated } from "./validation.js";

const purposeSchema = z.enum(["model-input", "retrieval-text"]);
const recipeSchema = z.string().min(1);
const representationSchema = z.strictObject({
  source: selectionSchema,
  purpose: purposeSchema,
  recipe: recipeSchema,
  result: artifactRefSchema,
  output: z.string().min(1),
});

const active =
  "WHERE source_ref = ? AND range_key = ? AND purpose = ? AND recipe = ? AND retired_seq IS NULL";

export function createRepresentations(
  database: Database,
  cas: Cas,
): Representations {
  function lookup(
    rawSource: Representation["source"],
    purpose: Representation["purpose"],
    recipe: string,
  ) {
    const source = validated(selectionSchema, rawSource, ["source"]);
    validated(purposeSchema, purpose, ["purpose"]);
    validated(recipeSchema, recipe, ["recipe"]);
    return { source, key: rangeKey(source.range) };
  }

  return {
    find(rawSource, purpose, recipe) {
      const { source, key } = lookup(rawSource, purpose, recipe);
      return database.read((tx) => {
        checkExtent(storedArtifact(tx.sql, source.ref), source);
        const row = tx.sql
          .query<{ result_ref: string; output: string }>(
            `SELECT result_ref, output FROM representations ${active}`,
          )
          .get(source.ref, key, purpose, recipe);
        return row
          ? {
              source,
              purpose,
              recipe,
              result: row.result_ref,
              output: row.output,
            }
          : undefined;
      });
    },
    set(representation) {
      const { source, purpose, recipe, result, output } = validated(
        representationSchema,
        representation,
      );
      const key = rangeKey(source.range);
      const stored = database.read((tx) =>
        storedArtifact(tx.sql, result, "result"),
      );
      const { result: saved } = parseManifest(
        result,
        utf8Text(cas.readBytesSync(stored.blob), stored),
      );
      const selected = selectOutput(result, saved.files, output);
      database.write((tx) => {
        checkExtent(storedArtifact(tx.sql, source.ref), source);
        storedArtifact(tx.sql, result, "result");
        storedArtifact(tx.sql, selected.ref);
        tx.sql.run(
          `UPDATE representations SET retired_seq = ? ${active}`,
          tx.seq,
          source.ref,
          key,
          purpose,
          recipe,
        );
        tx.sql.run(
          `INSERT INTO representations (source_ref, range_key, purpose, recipe, result_ref, output, created_seq)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
          source.ref,
          key,
          purpose,
          recipe,
          result,
          output,
          tx.seq,
        );
      });
    },
    remove(rawSource, purpose, recipe) {
      const { source, key } = lookup(rawSource, purpose, recipe);
      database.write((tx) => {
        checkExtent(storedArtifact(tx.sql, source.ref), source);
        tx.sql.run(
          `UPDATE representations SET retired_seq = ? ${active}`,
          tx.seq,
          source.ref,
          key,
          purpose,
          recipe,
        );
      });
    },
  };
}
