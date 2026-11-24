export const storageSchemaSql = `
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

CREATE TABLE blobs (
  ref TEXT PRIMARY KEY CHECK (
    length(ref) = 71 AND substr(ref, 1, 7) = 'sha256:'
    AND substr(ref, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 0 AND 9007199254740991)
) STRICT;

CREATE TABLE time_domains (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('utc', 'linear', 'opaque')),
  label TEXT NOT NULL,
  tick_numerator TEXT,
  tick_denominator TEXT,
  created_seq INTEGER NOT NULL REFERENCES commits(seq)
) STRICT;
`;
