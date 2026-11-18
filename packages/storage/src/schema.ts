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
`;
