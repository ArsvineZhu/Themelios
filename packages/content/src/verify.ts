import { openCall, type ArtifactRef, type CallOptions } from "@themelios/core";
import type { Cas, Database } from "@themelios/storage";
import { indexEdges, storedArtifact } from "./artifacts.js";
import type { SourceLink } from "./contracts.js";
import { resultLinks } from "./result-graph.js";
import { parseManifest } from "./results.js";
import { rawBytes, utf8Text } from "./selections.js";
import { contentError } from "./validation.js";

interface StoredEdge {
  relation: SourceLink["relation"];
  ordinal: bigint;
  target_ref: ArtifactRef;
  selection_json: string;
}

/** Confirms that the retained result bodies and their SQLite edge index describe the same graph. */
export async function verifyContent(
  database: Database,
  cas: Cas,
  options?: CallOptions,
): Promise<void> {
  const call = openCall("content.verify", options);
  try {
    const resultRefs = database.read((tx) =>
      tx.sql
        .query<{ ref: ArtifactRef }>(
          "SELECT ref FROM artifacts WHERE kind = 'result' ORDER BY ref",
        )
        .all(),
    );
    for (const { ref } of resultRefs) {
      call.throwIfAborted();
      const artifact = database.read((tx) =>
        storedArtifact(tx.sql, ref, "result"),
      );
      try {
        const { result, upstreamResults } = parseManifest(
          ref,
          utf8Text(await rawBytes(cas, artifact, call.signal), artifact),
        );
        const expected = new Map<string, SourceLink>();
        for (const edge of indexEdges(resultLinks(result, upstreamResults)))
          expected.set(`${edge.relation}:${edge.ordinal}`, edge);
        const indexed = database.read((tx) =>
          tx.sql
            .query<StoredEdge>(
              "SELECT relation, ordinal, target_ref, selection_json FROM artifact_edges WHERE owner_ref = ?",
            )
            .all(ref),
        );
        if (
          indexed.length !== expected.size ||
          indexed.some((edge) => {
            const selected = expected.get(
              `${edge.relation}:${edge.ordinal}`,
            )?.selection;
            return (
              edge.target_ref !== selected?.ref ||
              edge.selection_json !== JSON.stringify(selected)
            );
          })
        ) {
          throw new Error("Result manifest and source index disagree");
        }
      } catch (error) {
        call.throwIfAborted();
        throw contentError(
          "content.result_corrupt",
          { ref, blobRef: artifact.blob, reason: String(error) },
          error,
        );
      }
    }
  } finally {
    call.close();
  }
}
