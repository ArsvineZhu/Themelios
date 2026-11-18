import {
  activeRepresentation,
  registerRepresentation,
} from "./representation-index.js";
import {
  artifactRefSchema,
  selectionSchema,
  type ArtifactRef,
  type Selection,
} from "@themelios/core";
import type { Cas, Database } from "@themelios/storage";
import { z } from "zod";
import { storedArtifact } from "./artifacts.js";
import { selectOutput } from "./result-graph.js";
import { parseManifest } from "./results.js";
import { checkExtent, rangeKey, utf8Text } from "./selections.js";
import { validated } from "./validation.js";

export interface Representation {
  source: Selection;
  purpose: "model-input" | "retrieval-text";
  recipe: string;
  result: ArtifactRef;
  outputs: readonly string[];
}

export interface Representations {
  find(
    source: Selection,
    purpose: Representation["purpose"],
    recipe: string,
  ): Representation | undefined;
  set(representation: Representation): void;
  remove(
    source: Selection,
    purpose: Representation["purpose"],
    recipe: string,
  ): void;
}

const purposeSchema = z.enum(["model-input", "retrieval-text"]);
const recipeSchema = z.string().min(1);
const representationSchema = z.strictObject({
  source: selectionSchema,
  purpose: purposeSchema,
  recipe: recipeSchema,
  result: artifactRefSchema,
  outputs: z.array(z.string().min(1)).min(1),
});

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
          .query<{ result_ref: ArtifactRef; outputs_json: string }>(
            `SELECT result_ref, outputs_json FROM representations ${activeRepresentation}`,
          )
          .get(source.ref, key, purpose, recipe);
        return row
          ? {
              source,
              purpose,
              recipe,
              result: row.result_ref,
              outputs: validated(
                representationSchema.shape.outputs,
                JSON.parse(row.outputs_json),
                ["outputs"],
              ),
            }
          : undefined;
      });
    },
    set(representation) {
      const parsed = validated(representationSchema, representation);
      const { source, result, outputs } = parsed;
      const stored = database.read((tx) =>
        storedArtifact(tx.sql, result, "result"),
      );
      const { result: saved } = parseManifest(
        result,
        utf8Text(cas.readBytesSync(stored.blob), stored),
      );
      const selections = outputs.map((output) =>
        selectOutput(result, saved.files, output),
      );
      database.write((tx) => {
        checkExtent(storedArtifact(tx.sql, source.ref), source);
        storedArtifact(tx.sql, result, "result");
        for (const selected of selections) storedArtifact(tx.sql, selected.ref);
        registerRepresentation(tx, parsed);
      });
    },
    remove(rawSource, purpose, recipe) {
      const { source, key } = lookup(rawSource, purpose, recipe);
      database.write((tx) => {
        checkExtent(storedArtifact(tx.sql, source.ref), source);
        tx.sql.run(
          `UPDATE representations SET retired_seq = ? ${activeRepresentation}`,
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
