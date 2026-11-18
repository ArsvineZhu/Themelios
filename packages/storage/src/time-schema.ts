export const timeSchemaSql = `
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
`;
