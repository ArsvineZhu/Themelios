import {
  completedSchema,
  type ArtifactRef,
  type Completed,
  type InlineMaterial,
  type Material,
  type SavedFile,
  type SavedResult,
  type Selection,
} from "@themelios/core";
import type { SourceLink } from "./artifacts.js";
import { contentError, pointer, validated } from "./validation.js";

/** Snapshots mutable caller values before preparing bytes, keeping shared graph identities. */
export function captureResult(
  root: Completed,
  maxInlineBytes: number,
): Completed {
  const active = new WeakSet<Completed>();
  const captured = new WeakMap<Completed, Completed>();
  const inlines = new WeakMap<Material, InlineMaterial>();

  function copyInline(
    original: Material,
    material: InlineMaterial,
  ): InlineMaterial {
    const reused = inlines.get(original);
    if (reused) return reused;
    if (material.bytes.byteLength > maxInlineBytes) {
      throw contentError("storage.limit_exceeded", {
        maxBytes: maxInlineBytes,
        sizeBytes: material.bytes.byteLength,
      });
    }
    const inline = { ...material, bytes: new Uint8Array(material.bytes) };
    inlines.set(original, inline);
    return inline;
  }

  function copyMaterial(
    original: Material,
    material: Material,
    path: (string | number)[],
  ): Material {
    if ("bytes" in material) return copyInline(original, material);
    if ("ref" in material || typeof material.result === "string")
      return material;
    return {
      ...material,
      result: copyResult(material.result, [...path, "result"]),
    };
  }

  function copyResult(
    original: Completed,
    path: (string | number)[],
  ): Completed {
    if (active.has(original))
      throw contentError("content.result_cycle", { path: pointer(path) });
    const reused = captured.get(original);
    if (reused) return reused;
    active.add(original);
    try {
      const { inputs, files, ...manifest } = validated(
        completedSchema,
        original,
        path,
      );
      const result: Completed = {
        ...structuredClone(manifest),
        inputs: inputs.map(({ source, delivered, ...metadata }, index) => ({
          ...metadata,
          source: copyMaterial(original.inputs[index]!.source, source, [
            ...path,
            "inputs",
            index,
            "source",
          ]),
          delivered: delivered.map((item, ordinal) =>
            copyMaterial(original.inputs[index]!.delivered[ordinal]!, item, [
              ...path,
              "inputs",
              index,
              "delivered",
              ordinal,
            ]),
          ),
        })),
        files: files.map(({ material, ...metadata }, index) => ({
          ...metadata,
          material:
            "bytes" in material
              ? copyInline(original.files[index]!.material, material)
              : material,
        })),
      };
      captured.set(original, result);
      return result;
    } finally {
      active.delete(original);
    }
  }

  return copyResult(root, []);
}

export function selectOutput(
  ref: ArtifactRef,
  files: Readonly<Record<string, SavedFile>>,
  output = "$value",
): Selection {
  if (output === "$value")
    return { ref, range: { kind: "json", pointer: "/value" } };
  if (!Object.hasOwn(files, output)) {
    throw contentError("content.output_not_found", {
      output,
      availableNames: ["$value", ...Object.keys(files)],
    });
  }
  return files[output]!.material;
}

export function resultLinks(
  result: Pick<SavedResult, "inputs" | "files">,
  upstream: readonly ArtifactRef[],
): SourceLink[] {
  return [
    ...result.inputs.flatMap((use) =>
      [use.source, ...use.delivered].map((selection) => ({
        selection,
        relation: "input" as const,
      })),
    ),
    ...Object.values(result.files).map((file) => ({
      selection: file.material,
      relation: "file" as const,
    })),
    ...upstream.map((ref) => ({
      selection: { ref },
      relation: "representation-source" as const,
    })),
  ];
}
