import {
  artifactRefSchema,
  commitPointSchema,
  instantSchema,
} from "@themelios/core";
import { z } from "zod";

const skuCharacters = "A-Z0-9._-";
const maxSkuLength = 64;
const maxNameLength = 200;
const maxQuantity = 1_000_000_000;
export const skuSchema = z
  .string()
  .regex(new RegExp("^[" + skuCharacters + "]{1," + maxSkuLength + "}$"));
const inventoryValuesSchema = z.strictObject({
  sku: skuSchema,
  name: z
    .string()
    .min(1)
    .max(maxNameLength)
    .refine((value) => value.trim().length > 0),
  quantity: z.int().min(0).max(maxQuantity),
});
export const rowSchema = inventoryValuesSchema.extend({
  quantity: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .transform(Number)
    .pipe(inventoryValuesSchema.shape.quantity),
});
export type CsvRow = z.infer<typeof rowSchema> & { sourceRecord: number };

export const importOutput = z.strictObject({
  cut: commitPointSchema,
  sourceRef: artifactRefSchema,
  rows: z.int().positive(),
});
const inventoryRowSchema = inventoryValuesSchema.extend({
  sourceRef: artifactRefSchema,
  sourceRecord: z.int().positive(),
  validFrom: commitPointSchema,
  recordedAt: instantSchema,
});
const inventoryVersionSchema = inventoryRowSchema.extend({
  validTo: commitPointSchema.nullable(),
});
export const inventoryListSchema = z.strictObject({
  cut: commitPointSchema,
  rows: z.array(inventoryRowSchema),
});
export const inventoryHistorySchema = inventoryListSchema.extend({
  rows: z.array(inventoryVersionSchema),
});
export const inventoryExportSchema = z.strictObject({
  sourceRef: artifactRefSchema,
  destination: z.string().min(1),
});

export type InventoryRow = z.infer<typeof inventoryRowSchema>;

export const inventorySchemaSql = `
CREATE TABLE inventory_imports (
  source_ref TEXT PRIMARY KEY REFERENCES artifacts(ref),
  commit_seq INTEGER NOT NULL UNIQUE REFERENCES commits(seq),
  row_count INTEGER NOT NULL CHECK (row_count > 0)
) STRICT;

CREATE TABLE inventory_versions (
  sku TEXT NOT NULL CHECK (length(sku) BETWEEN 1 AND ${maxSkuLength} AND sku NOT GLOB '*[^${skuCharacters}]*'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND ${maxNameLength}),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 0 AND ${maxQuantity}),
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
`;
