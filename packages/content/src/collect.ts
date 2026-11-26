import {
  collectStorage,
  foreignKeyParents,
  type Cas,
  type CollectionOptions,
  type Database,
  type WriteTransaction,
} from "@themelios/storage";
import { contentTables } from "./schema.js";

/** Prunes the Content graph and sweeps CAS under the caller's offline instance lock. */
export async function collectContent(
  database: Database,
  cas: Cas,
  options: CollectionOptions = {},
) {
  let removedArtifacts = 0;
  const report = await collectStorage(database, cas, {
    ...options,
    prune(tx, floor) {
      const applicationPrune = options.prune?.(tx, floor);
      removedArtifacts = pruneArtifacts(tx, floor);
      return applicationPrune;
    },
  });
  return { ...report, removedArtifacts };
}

function pruneArtifacts({ sql }: WriteTransaction, floor: bigint): number {
  sql.run(
    "CREATE TEMP TABLE keep_artifacts (ref TEXT PRIMARY KEY) WITHOUT ROWID",
  );
  const keep = sql.query("INSERT OR IGNORE INTO keep_artifacts VALUES (?)");
  // Content's own foreign keys express graph relations and explicit retention.
  for (const { ref } of foreignKeyParents<{ ref: string }>(sql, {
    table: "artifacts",
    key: "ref",
    excludeOwners: contentTables,
  })) {
    keep.run(ref);
  }
  sql.run(
    `INSERT OR IGNORE INTO keep_artifacts
    WITH RECURSIVE kept(ref) AS (
      SELECT ref FROM keep_artifacts
      UNION SELECT artifact_ref FROM artifact_retention WHERE released_seq IS NULL OR released_seq > ?
      UNION SELECT e.target_ref FROM kept k JOIN artifact_edges e ON e.owner_ref = k.ref
      UNION SELECT p.result_ref FROM kept k JOIN representations p ON p.source_ref = k.ref
    ) SELECT ref FROM kept`,
    floor,
  );
  const unretained =
    "(SELECT ref FROM artifacts WHERE ref NOT IN (SELECT ref FROM keep_artifacts))";
  sql.run(`DELETE FROM representations WHERE source_ref IN ${unretained}`);
  sql.run(`DELETE FROM artifact_edges WHERE owner_ref IN ${unretained}`);
  sql.run("DELETE FROM artifact_retention WHERE released_seq <= ?", floor);
  const removed = sql.run(
    `DELETE FROM artifacts WHERE ref IN ${unretained}`,
  ).changes;
  sql.run("DROP TABLE keep_artifacts");
  return Number(removed);
}
