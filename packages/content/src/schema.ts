export const contentSchemaSql = `
CREATE TABLE artifacts (
  ref TEXT PRIMARY KEY,
  agent_code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('material', 'result')),
  media_type TEXT NOT NULL,
  blob_ref TEXT NOT NULL CHECK (
    length(blob_ref) = 71 AND substr(blob_ref, 1, 7) = 'sha256:'
    AND substr(blob_ref, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  name TEXT,
  extent_json TEXT NOT NULL CHECK (json_valid(extent_json)),
  origin_json TEXT CHECK (origin_json IS NULL OR json_valid(origin_json)),
  created_seq INTEGER NOT NULL REFERENCES commits(seq),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX artifacts_created ON artifacts(created_seq, ref);
CREATE INDEX artifacts_blob ON artifacts(blob_ref);

CREATE TABLE artifact_edges (
  owner_ref TEXT NOT NULL REFERENCES artifacts(ref),
  relation TEXT NOT NULL CHECK (relation IN ('input', 'file', 'representation-source')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  target_ref TEXT NOT NULL REFERENCES artifacts(ref),
  selection_json TEXT NOT NULL CHECK (json_valid(selection_json)),
  PRIMARY KEY (owner_ref, relation, ordinal)
) STRICT;
CREATE INDEX artifact_edges_target ON artifact_edges(target_ref);

CREATE TABLE artifact_roots (
  artifact_ref TEXT NOT NULL REFERENCES artifacts(ref),
  retained_seq INTEGER NOT NULL REFERENCES commits(seq),
  released_seq INTEGER REFERENCES commits(seq),
  CHECK (released_seq IS NULL OR released_seq > retained_seq),
  PRIMARY KEY (artifact_ref, retained_seq)
) STRICT;
CREATE UNIQUE INDEX artifact_roots_active ON artifact_roots(artifact_ref) WHERE released_seq IS NULL;
CREATE INDEX artifact_roots_history ON artifact_roots(retained_seq, released_seq);

CREATE TABLE representations (
  source_ref TEXT NOT NULL REFERENCES artifacts(ref),
  range_key TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('model-input', 'retrieval-text')),
  recipe TEXT NOT NULL,
  result_ref TEXT NOT NULL REFERENCES artifacts(ref),
  outputs_json TEXT NOT NULL CHECK (json_valid(outputs_json)),
  created_seq INTEGER NOT NULL REFERENCES commits(seq),
  retired_seq INTEGER REFERENCES commits(seq),
  CHECK (retired_seq IS NULL OR retired_seq > created_seq),
  PRIMARY KEY (source_ref, range_key, purpose, recipe, created_seq)
) STRICT;
CREATE UNIQUE INDEX representations_active ON representations(source_ref, range_key, purpose, recipe)
  WHERE retired_seq IS NULL;
CREATE INDEX representations_result ON representations(result_ref);
`;
