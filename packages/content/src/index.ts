import type { Cas, Database } from "@themelios/storage";
import type { Content } from "./contracts.js";
import { createMaterials } from "./materials.js";
import { createRepresentations } from "./representations.js";
import { createResults } from "./results.js";
import {
  runContentWrite,
  type ScheduleContentWrite,
} from "./write-schedule.js";

export { probeMediaType } from "./media-metadata.js";
export { verifyContent } from "./verify.js";
export type { ScheduleContentWrite } from "./write-schedule.js";
export type {
  AcceptInput,
  ArtifactInfo,
  ArtifactRow,
  Content,
  Extent,
  MaterialRead,
  Materials,
  Origin,
  PreparedMaterial,
  PreparedResult,
  Representation,
  Representations,
  ResultManifest,
  Results,
  SourceLink,
  TextBlock,
} from "./contracts.js";

/** Binds content operations to the application's existing database and CAS. */
export function createContent(options: {
  database: Database;
  cas: Cas;
  maxImportBytes?: number;
  maxInlineBytes?: number;
  scheduleWrite?: ScheduleContentWrite;
}): Content {
  const {
    database,
    cas,
    maxImportBytes = 1_073_741_824,
    maxInlineBytes = 8_388_608,
    scheduleWrite = runContentWrite,
  } = options;
  const limits = { maxImportBytes, maxInlineBytes };
  return {
    materials: createMaterials(database, cas, limits, scheduleWrite),
    results: createResults(database, cas, limits, scheduleWrite),
    representations: createRepresentations(database, cas),
    // The application owns the database and CAS supplied to this binding.
    close() {
      return Promise.resolve();
    },
  };
}
