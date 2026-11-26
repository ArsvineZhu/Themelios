import {
  defaultInlineMaterialBytes,
  type RepresentationAdapter,
} from "@themelios/core";
import type { Cas, Database } from "@themelios/storage";
import { createMaterials, type Materials } from "./materials.js";
import {
  createRepresentations,
  type Representations,
} from "./representations.js";
import { createResults, type Results } from "./results.js";

export {
  artifactInfoSchema,
  originSchema,
  sourceLinkSchema,
  type ArtifactInfo,
  type Origin,
  type SourceLink,
} from "./artifacts.js";
export type { AcceptInput } from "./imports.js";
export {
  materialOperationIds,
  retainedListOptionsSchema,
  sourceTraceOptionsSchema,
  type AnalyzedMaterialAdoption,
  type CapturedMaterial,
  type MaterialAttachment,
  type MaterialRead,
  type Materials,
} from "./materials.js";
export type { Representation, Representations } from "./representations.js";
export {
  resultOperationIds,
  type ResultAttachment,
  type Results,
} from "./results.js";
export { textBlockSchema, type TextBlock } from "./text-structure.js";
export { createImageAdapter, type ImageAdapterOptions } from "./image.js";
export { createWaveAdapter } from "./wave.js";
export { verifyContent } from "./verify.js";
export { collectContent } from "./collect.js";

export interface Content {
  readonly materials: Materials;
  readonly results: Results;
  readonly representations: Representations;
}

export const defaultContentImportBytes = 1_073_741_824;

/** Binds content operations to the application's existing database and CAS. */
export function createContent(options: {
  database: Database;
  cas: Cas;
  maxImportBytes?: number;
  maxInlineBytes?: number;
  /** Optional probes for media whose original extent is unknown at capture. */
  adapters?: readonly RepresentationAdapter[];
}): Content {
  const { database, cas } = options;
  const limits = () => {
    const maxImportBytes = options.maxImportBytes ?? defaultContentImportBytes;
    return {
      maxImportBytes,
      maxInlineBytes: Math.min(
        maxImportBytes,
        options.maxInlineBytes ?? defaultInlineMaterialBytes,
      ),
      adapters: [...(options.adapters ?? [])],
    };
  };
  const results = createResults(database, cas, limits);
  return {
    materials: createMaterials(database, cas, limits),
    results,
    representations: createRepresentations(database, results),
  };
}
