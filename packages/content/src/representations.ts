import {
  registerRepresentation,
  representationKey,
} from "./representation-index.js";
import {
  artifactRefSchema,
  representationPurposeSchema,
  resultOutputNamesSchema,
  selectionRangeKey,
  selectionSchema,
  throwIfAborted,
  type ArtifactRef,
  type CallOptions,
  type SavedRepresentation,
  type Selection,
} from "@themelios/core";
import type { Database } from "@themelios/storage";
import { z } from "zod";
import { storedArtifact } from "./artifacts.js";
import type { Results } from "./results.js";
import { checkExtent } from "./selections.js";
import { jsonValue, validated } from "./validation.js";

export interface Representations {
  /** Reads the saved result and output names for this reuse key, if registered. */
  read(
    source: Selection,
    purpose: Representation["purpose"],
    recipe: string,
    options?: CallOptions,
  ): Promise<SavedRepresentation | undefined>;
  /** Indexes named outputs from a saved result with matching source provenance. */
  set(representation: Representation, options?: CallOptions): Promise<void>;
  remove(
    source: Selection,
    purpose: Representation["purpose"],
    recipe: string,
  ): void;
}

const recipeSchema = z.string().min(1);
const representationSchema = z.strictObject({
  source: selectionSchema,
  purpose: representationPurposeSchema,
  recipe: recipeSchema,
  result: artifactRefSchema,
  outputs: resultOutputNamesSchema,
});
export type Representation = z.infer<typeof representationSchema>;

export function createRepresentations(
  database: Database,
  results: Results,
): Representations {
  function lookup(
    rawSource: Representation["source"],
    purpose: Representation["purpose"],
    recipe: string,
  ) {
    const source = validated(selectionSchema, rawSource, ["source"]);
    validated(representationPurposeSchema, purpose, ["purpose"]);
    validated(recipeSchema, recipe, ["recipe"]);
    return { source, key: selectionRangeKey(source.range) };
  }

  return {
    async read(rawSource, purpose, recipe, options) {
      throwIfAborted(options?.signal);
      const { source, key } = lookup(rawSource, purpose, recipe);
      const row = database.read((tx) => {
        checkExtent(storedArtifact(tx.sql, source.ref), source);
        return tx.sql
          .query<{ result_ref: ArtifactRef; outputs_json: string }>(
            `SELECT result_ref, outputs_json FROM representations ${representationKey}`,
          )
          .get(source.ref, key, purpose, recipe);
      });
      if (!row) return;
      const outputs = validated(
        resultOutputNamesSchema,
        jsonValue(row.outputs_json, row.result_ref),
        ["outputs"],
      );
      return { result: await results.read(row.result_ref, options), outputs };
    },
    async set(representation, options) {
      database.requireWritable("representations.set");
      const { result, ...entry } = validated(
        representationSchema,
        representation,
      );
      const saved = await results.read(result, options);
      throwIfAborted(options?.signal);
      database.write((tx) => registerRepresentation(tx, saved, entry));
    },
    remove(rawSource, purpose, recipe) {
      const { source, key } = lookup(rawSource, purpose, recipe);
      database.write((tx) => {
        checkExtent(storedArtifact(tx.sql, source.ref), source);
        tx.sql.run(
          `DELETE FROM representations ${representationKey}`,
          source.ref,
          key,
          purpose,
          recipe,
        );
      });
    },
  };
}
