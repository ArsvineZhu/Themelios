import type { Cas, Database } from "@themelios/storage";
import { createMaterials, type Materials } from "./materials.js";
import {
  createRepresentations,
  type Representations,
} from "./representations.js";
import { createResults, type Results } from "./results.js";

export {
  originSchema,
  type ArtifactInfo,
  type ArtifactRow,
  type Origin,
  type SourceLink,
} from "./artifacts.js";
export type { AcceptInput } from "./imports.js";
export type { MaterialRead, Materials, PreparedMaterial } from "./materials.js";
export type { Representation, Representations } from "./representations.js";
export type { PreparedResult, ResultManifest, Results } from "./results.js";
export type { TextBlock } from "./text-structure.js";
export { createImageAdapter, type ImageAdapterOptions } from "./image.js";
export { createWaveAdapter } from "./wave.js";
export { verifyContent } from "./verify.js";
export { collectContent } from "./collect.js";

export interface Content {
  readonly materials: Materials;
  readonly results: Results;
  readonly representations: Representations;
}

/** Binds content operations to the application's existing database and CAS. */
export function createContent(options: {
  database: Database;
  cas: Cas;
  maxImportBytes?: number;
  maxInlineBytes?: number;
}): Content {
  const { database, cas } = options;
  const limits = {
    get maxImportBytes() {
      return options.maxImportBytes ?? 1_073_741_824;
    },
    get maxInlineBytes() {
      return options.maxInlineBytes ?? 8_388_608;
    },
  };
  return {
    materials: createMaterials(database, cas, limits),
    results: createResults(database, cas, limits),
    representations: createRepresentations(database, cas),
  };
}
