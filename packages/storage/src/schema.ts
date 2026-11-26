import {
  blobDigestHexCharacters,
  blobDigestHexLength,
  blobRefPrefix,
  customTimeDomainSchema,
  UTC_TIME_DOMAIN,
} from "@themelios/core";

const customDomainKinds = customTimeDomainSchema.options
  .map((domain) => `'${domain.shape.kind.value}'`)
  .join(", ");

export const storageSchemaSql = `
CREATE TABLE store_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  format_id TEXT NOT NULL,
  history_floor INTEGER NOT NULL DEFAULT 0 CHECK (history_floor >= 0)
) STRICT;

CREATE TABLE commits (
  seq INTEGER PRIMARY KEY CHECK (seq > 0),
  recorded_at TEXT NOT NULL
) STRICT;

CREATE TABLE blobs (
  ref TEXT PRIMARY KEY CHECK (
    length(ref) = ${blobRefPrefix.length + blobDigestHexLength}
    AND substr(ref, 1, ${blobRefPrefix.length}) = '${blobRefPrefix}'
    AND substr(ref, ${blobRefPrefix.length + 1}) NOT GLOB '*[^${blobDigestHexCharacters}]*'
  ),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER})
) STRICT;

CREATE TABLE time_domains (
  id TEXT PRIMARY KEY CHECK (id <> '${UTC_TIME_DOMAIN.id}'),
  kind TEXT NOT NULL CHECK (kind IN (${customDomainKinds})),
  label TEXT NOT NULL,
  tick_numerator TEXT,
  tick_denominator TEXT,
  created_seq INTEGER NOT NULL REFERENCES commits(seq),
  CHECK ((tick_numerator IS NULL) = (tick_denominator IS NULL))
) STRICT;
`;
