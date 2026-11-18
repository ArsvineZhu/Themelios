export { extentSchema } from "./artifacts.js";
import type { Cas, Database } from "@themelios/storage";
import { createMaterials, type Materials } from "./materials.js";
import {
  createRepresentations,
  type Representations,
} from "./representations.js";
import { createResults, type Results } from "./results.js";

export type {
  ArtifactInfo,
  ArtifactRow,
  Extent,
  Origin,
  SourceLink,
} from "./artifacts.js";
export type { AcceptInput } from "./imports.js";
export type { MaterialRead, Materials, PreparedMaterial } from "./materials.js";
export { probeMediaType } from "./media-metadata.js";
export type { Representation, Representations } from "./representations.js";
export type { PreparedResult, ResultManifest, Results } from "./results.js";
export type { TextBlock } from "./text-structure.js";
export {
  createImageAdapter,
  imageNeedsOrientation,
  type ImageAdapter,
  type ImageAdapterOptions,
  type ImageMediaInput,
  type ImageRecipeDescription,
  type PreparedImageResult,
} from "./image.js";
export { verifyContent } from "./verify.js";

export interface Content {
  readonly materials: Materials;
  readonly results: Results;
  readonly representations: Representations;
  close(): Promise<void>;
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
    // The application owns the database and CAS supplied to this binding.
    close() {
      return Promise.resolve();
    },
  };
}
