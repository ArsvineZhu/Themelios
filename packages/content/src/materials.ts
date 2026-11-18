import {
  artifactRefSchema,
  openCall,
  selectionSchema,
  throwIfAborted,
  type ArtifactRef,
} from "@themelios/core";
import { resolveCut, type Cas, type Database } from "@themelios/storage";
import { z } from "zod";
import {
  addArtifact,
  decodeSelection,
  listArtifacts,
  prepareAdoption,
  publicInfo,
  retain,
  storedArtifact,
  type Query,
} from "./artifacts.js";
import type { Materials, PreparedMaterial, SourceLink } from "./contracts.js";
import {
  captureImport,
  importArtifact,
  type CapturedImport,
  type ImportLimits,
} from "./imports.js";
import { rawBytes, selectionText, utf8Text } from "./selections.js";
import { structureText } from "./text-structure.js";
import { contentError, validated } from "./validation.js";
import type { ScheduleContentWrite } from "./write-schedule.js";

function readSources(
  sql: Query,
  ref: ArtifactRef,
  depth: number,
): SourceLink[] {
  const edges = sql.query<
    { relation: SourceLink["relation"]; selection_json: string },
    [ArtifactRef]
  >(
    "SELECT relation, selection_json FROM artifact_edges WHERE owner_ref = ? ORDER BY relation, ordinal",
  );
  const expanded = new Set<ArtifactRef>();
  const found = new Map<string, SourceLink>();
  let current = new Set([ref]);
  for (let level = 0; level < depth && current.size > 0; level += 1) {
    const next = new Set<ArtifactRef>();
    for (const owner of current) {
      expanded.add(owner);
      for (const edge of edges.all(owner)) {
        const selection = decodeSelection(edge.selection_json, owner);
        const key = `${edge.relation}:${JSON.stringify(selection)}`;
        if (!found.has(key))
          found.set(key, { relation: edge.relation, selection });
        if (!expanded.has(selection.ref)) next.add(selection.ref);
      }
    }
    current = new Set([...next].filter((target) => !expanded.has(target)));
  }
  return [...found.values()];
}

export function createMaterials(
  database: Database,
  cas: Cas,
  limits: ImportLimits,
  scheduleWrite: ScheduleContentWrite,
): Materials {
  const lookup = (ref: ArtifactRef) =>
    database.read((tx) => storedArtifact(tx.sql, ref));
  async function prepare(
    captured: CapturedImport,
    signal: AbortSignal,
  ): Promise<PreparedMaterial> {
    const artifact = await importArtifact(cas, captured, limits, { signal });
    const { blob: _blob, ...info } = artifact;
    return {
      info: structuredClone(info),
      ...prepareAdoption(database, "materials.prepare", (tx) => {
        if (addArtifact(tx, artifact)) retain(tx.sql, artifact.ref, tx.seq);
        return { ref: artifact.ref };
      }),
    };
  }
  const materials: Materials = {
    prepare(input, options) {
      return scheduleWrite(
        "materials.prepare",
        () => {
          database.requireWritable("materials.prepare");
          const captured = captureImport(input, limits.maxInlineBytes);
          return (signal) => prepare(captured, signal);
        },
        options,
      );
    },

    accept(input, options) {
      return scheduleWrite(
        "materials.accept",
        () => {
          database.requireWritable("materials.accept");
          const captured = captureImport(input, limits.maxInlineBytes);
          return async (signal) => {
            const prepared = await prepare(captured, signal);
            try {
              throwIfAborted(signal);
              return database.write((tx) => prepared.adopt(tx));
            } finally {
              await prepared.close();
            }
          };
        },
        options,
      );
    },

    inspect(ref) {
      return publicInfo(lookup(ref));
    },

    async read(ref, options) {
      throwIfAborted(options?.signal);
      const artifact = lookup(ref);
      return {
        info: publicInfo(artifact),
        body: await cas.read(artifact.blob, options),
      };
    },

    async text(selection, options) {
      const scope = openCall("content.text", options);
      try {
        scope.throwIfAborted();
        const selected = validated(selectionSchema, selection);
        return await selectionText(
          cas,
          lookup(selected.ref),
          selected,
          scope.signal,
        );
      } finally {
        scope.close();
      }
    },

    async structure(ref, options) {
      const scope = openCall("content.structure", options);
      try {
        scope.throwIfAborted();
        const artifact = lookup(ref);
        if (!["text/plain", "text/markdown"].includes(artifact.mediaType)) {
          throw contentError("content.text_unavailable", {
            ref,
            mediaType: artifact.mediaType,
          });
        }
        const bytes = await rawBytes(cas, artifact, scope.signal);
        const blocks = structureText(
          ref,
          utf8Text(bytes, artifact),
          artifact.mediaType === "text/markdown",
        );
        scope.throwIfAborted();
        return blocks;
      } finally {
        scope.close();
      }
    },

    sources(ref, { depth = 1 } = {}) {
      validated(z.int().min(1).max(16), depth, ["depth"]);
      return database.read((tx) => {
        storedArtifact(tx.sql, ref);
        return readSources(tx.sql, ref, depth);
      });
    },

    list({ at, after, limit = 100 } = {}) {
      if (after !== undefined) validated(artifactRefSchema, after, ["after"]);
      validated(z.int().min(1).max(1000), limit, ["limit"]);
      return database.read((tx) =>
        listArtifacts(tx, resolveCut(tx, at), after, limit),
      );
    },

    retain(ref) {
      database.write((tx) => {
        storedArtifact(tx.sql, ref);
        retain(tx.sql, ref, tx.seq);
      });
    },

    release(ref) {
      database.write((tx) => {
        storedArtifact(tx.sql, ref);
        tx.sql.run(
          "UPDATE artifact_roots SET released_seq = ? WHERE artifact_ref = ? AND released_seq IS NULL",
          tx.seq,
          ref,
        );
      });
    },

    async export(ref, destination, options) {
      throwIfAborted(options?.signal);
      await cas.export(lookup(ref).blob, destination, options);
    },
  };
  return materials;
}
