-- 当前应用格式的初始化 DDL。由 Database.init 在一次事务中执行。
-- format_id/时间由初始化程序绑定插入；open 只验证现有格式。
CREATE TABLE store_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  format_id TEXT NOT NULL,
  commit_seq INTEGER NOT NULL DEFAULT 0 CHECK (commit_seq >= 0),
  history_floor INTEGER NOT NULL DEFAULT 0 CHECK (history_floor >= 0 AND history_floor <= commit_seq)
) STRICT;

CREATE TABLE commits (
  seq INTEGER PRIMARY KEY CHECK (seq > 0),
  recorded_at TEXT NOT NULL
) STRICT;

CREATE TABLE artifacts (
  ref TEXT PRIMARY KEY,
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
  relation TEXT NOT NULL CHECK (relation IN ('input', 'file', 'copy', 'representation-source')),
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
  output TEXT NOT NULL,
  created_seq INTEGER NOT NULL REFERENCES commits(seq),
  retired_seq INTEGER REFERENCES commits(seq),
  CHECK (retired_seq IS NULL OR retired_seq > created_seq),
  PRIMARY KEY (source_ref, range_key, purpose, recipe, created_seq)
) STRICT;
CREATE UNIQUE INDEX representations_active ON representations(source_ref, range_key, purpose, recipe)
  WHERE retired_seq IS NULL;
CREATE INDEX representations_result ON representations(result_ref);

CREATE TABLE time_domains (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  ticks_per_second INTEGER NOT NULL CHECK (ticks_per_second > 0),
  created_seq INTEGER NOT NULL REFERENCES commits(seq)
) STRICT;

CREATE TABLE time_mappings (
  ref TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES time_domains(id),
  effective_from_utc_ms INTEGER NOT NULL,
  effective_until_utc_ms INTEGER,
  origin_utc_ms INTEGER NOT NULL,
  origin_ticks TEXT NOT NULL,
  rate_numerator TEXT NOT NULL,
  rate_denominator TEXT NOT NULL,
  created_seq INTEGER NOT NULL REFERENCES commits(seq),
  retired_seq INTEGER REFERENCES commits(seq),
  CHECK (effective_until_utc_ms IS NULL OR effective_until_utc_ms > effective_from_utc_ms),
  CHECK (retired_seq IS NULL OR retired_seq > created_seq)
) STRICT;
CREATE INDEX time_mappings_lookup ON time_mappings(domain_id, effective_from_utc_ms, created_seq);
