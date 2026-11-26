import { representationPurposeSchema } from "@themelios/core";
import { artifactInfoSchema, sourceLinkSchema } from "./artifacts.js";

const sqlEnum = (values: readonly string[]) =>
  values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");

// All Content tables are declared here. Their FKs describe the internal graph,
// and collection discovers owning application FKs outside this declaration.
const tables = {
  artifacts: `(
  ref TEXT PRIMARY KEY,
  agent_code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN (${sqlEnum(artifactInfoSchema.shape.kind.options)})),
  media_type TEXT NOT NULL,
  blob_ref TEXT NOT NULL REFERENCES blobs(ref),
  name TEXT,
  extent_json TEXT NOT NULL CHECK (json_valid(extent_json)),
  origin_json TEXT CHECK (origin_json IS NULL OR json_valid(origin_json)),
  created_seq INTEGER NOT NULL REFERENCES commits(seq)
) STRICT;
CREATE INDEX artifacts_created ON artifacts(created_seq, ref);
CREATE INDEX artifacts_blob ON artifacts(blob_ref);`,

  artifact_edges: `(
  owner_ref TEXT NOT NULL REFERENCES artifacts(ref),
  relation TEXT NOT NULL CHECK (relation IN (${sqlEnum(sourceLinkSchema.shape.relation.options)})),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  target_ref TEXT NOT NULL REFERENCES artifacts(ref),
  range_json TEXT CHECK (range_json IS NULL OR json_valid(range_json)),
  PRIMARY KEY (owner_ref, relation, ordinal)
) STRICT;
CREATE INDEX artifact_edges_target ON artifact_edges(target_ref);`,

  artifact_retention: `(
  artifact_ref TEXT NOT NULL REFERENCES artifacts(ref),
  retained_seq INTEGER NOT NULL REFERENCES commits(seq),
  released_seq INTEGER REFERENCES commits(seq),
  CHECK (released_seq IS NULL OR released_seq > retained_seq),
  PRIMARY KEY (artifact_ref, retained_seq)
) STRICT;
CREATE UNIQUE INDEX artifact_retention_active ON artifact_retention(artifact_ref) WHERE released_seq IS NULL;
CREATE INDEX artifact_retention_history ON artifact_retention(retained_seq, released_seq);`,

  representations: `(
  source_ref TEXT NOT NULL REFERENCES artifacts(ref),
  range_key TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN (${sqlEnum(representationPurposeSchema.options)})),
  recipe TEXT NOT NULL,
  result_ref TEXT NOT NULL REFERENCES artifacts(ref),
  outputs_json TEXT NOT NULL CHECK (json_valid(outputs_json)),
  PRIMARY KEY (source_ref, range_key, purpose, recipe)
) STRICT;
CREATE INDEX representations_result ON representations(result_ref);`,
};

/** @internal Used to distinguish Content's graph from owning business FKs. */
export const contentTables = Object.freeze(Object.keys(tables));
export const contentSchemaSql = Object.entries(tables)
  .map(([name, definition]) => `CREATE TABLE ${name} ${definition}`)
  .join("\n");
