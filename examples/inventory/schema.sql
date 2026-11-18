-- 应用表。Database.init 自建 store_meta/commits；Content 的公开 DDL 先于本文件执行。
CREATE TABLE inventory_imports (
  source_ref TEXT PRIMARY KEY REFERENCES artifacts(ref),
  commit_seq INTEGER NOT NULL UNIQUE REFERENCES commits(seq),
  row_count INTEGER NOT NULL CHECK (row_count > 0)
) STRICT;

CREATE TABLE inventory_versions (
  sku TEXT NOT NULL CHECK (length(sku) BETWEEN 1 AND 64 AND sku NOT GLOB '*[^A-Z0-9._-]*'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 0 AND 1000000000),
  source_ref TEXT NOT NULL REFERENCES inventory_imports(source_ref),
  source_record INTEGER NOT NULL CHECK (source_record > 0),
  valid_from_seq INTEGER NOT NULL REFERENCES commits(seq),
  valid_to_seq INTEGER REFERENCES commits(seq),
  CHECK (valid_to_seq IS NULL OR valid_to_seq > valid_from_seq),
  PRIMARY KEY (sku, valid_from_seq),
  UNIQUE (source_ref, source_record)
) STRICT;

CREATE UNIQUE INDEX inventory_current_sku
  ON inventory_versions(sku) WHERE valid_to_seq IS NULL;
CREATE INDEX inventory_versions_cut
  ON inventory_versions(valid_from_seq, valid_to_seq, sku);
CREATE INDEX inventory_versions_source
  ON inventory_versions(source_ref, source_record);
