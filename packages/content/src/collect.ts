import {
  collectStorage,
  type Cas,
  type CollectionOptions,
  type Database,
  type WriteTransaction,
} from "@themelios/storage";

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
  sql.run(
    `INSERT INTO keep_artifacts
    WITH RECURSIVE kept(ref) AS (
      SELECT artifact_ref FROM artifact_roots WHERE released_seq IS NULL OR released_seq > ?
      UNION SELECT e.target_ref FROM kept k JOIN artifact_edges e ON e.owner_ref = k.ref
      UNION SELECT p.result_ref FROM kept k JOIN representations p ON p.source_ref = k.ref
        WHERE p.retired_seq IS NULL OR p.retired_seq > ?
    ) SELECT ref FROM kept`,
    floor,
    floor,
  );
  const unretained =
    "(SELECT ref FROM artifacts WHERE ref NOT IN (SELECT ref FROM keep_artifacts))";
  sql.run(
    `DELETE FROM representations WHERE retired_seq <= ? OR source_ref IN ${unretained} OR result_ref IN ${unretained}`,
    floor,
  );
  sql.run(
    `DELETE FROM artifact_edges WHERE owner_ref IN ${unretained} OR target_ref IN ${unretained}`,
  );
  sql.run(
    `DELETE FROM artifact_roots WHERE released_seq <= ? OR artifact_ref IN ${unretained}`,
    floor,
  );
  const removed = sql.run(
    `DELETE FROM artifacts WHERE ref IN ${unretained}`,
  ).changes;
  sql.run("DROP TABLE keep_artifacts");
  return Number(removed);
}
