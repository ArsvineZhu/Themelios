import {
  artifactRefSchema,
  completedSchema,
  type ArtifactRef,
  type Completed,
  type InlineMaterial,
  type InputUse,
  type Material,
  type SavedFile,
  type SavedResult,
  type Selection,
} from "@themelios/core";
import { contentError, pointer, validated } from "./validation.js";

export type CapturedOutput = {
  result: CapturedResult | { ref: ArtifactRef };
  output?: string;
};
export type CapturedMaterial = InlineMaterial | Selection | CapturedOutput;
export type CapturedResult = Omit<Completed, "inputs" | "files"> & {
  inputs: readonly InputUse<CapturedMaterial>[];
  files: readonly {
    name: string;
    material: InlineMaterial | Selection;
    sourceIndices: readonly number[];
  }[];
};

/** Snapshots mutable caller values before preparing bytes, keeping shared graph identities. */
export function captureResult(
  root: Completed,
  maxInlineBytes: number,
): CapturedResult {
  const active = new WeakSet<Completed>();
  const captured = new WeakMap<Completed, CapturedResult>();
  const inlines = new WeakMap<Material, InlineMaterial>();

  function copyMaterial(
    original: Material,
    material: Material,
    path: (string | number)[],
  ): CapturedMaterial {
    if ("bytes" in material) {
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
    if ("ref" in material) return material;
    const result =
      "ref" in material.result
        ? {
            ref: validated(artifactRefSchema, material.result.ref, [
              ...path,
              "result",
              "ref",
            ]),
          }
        : copyResult(material.result, [...path, "result"]);
    return material.output === undefined
      ? { result }
      : { result, output: material.output };
  }

  function copyResult(
    original: Completed,
    path: (string | number)[],
  ): CapturedResult {
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
      const result: CapturedResult = {
        ...structuredClone(manifest),
        inputs: inputs.map(({ source, delivered, role }, index) => ({
          role,
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
        files: files.map(({ name, material, sourceIndices }, index) => ({
          name,
          material: copyMaterial(original.files[index]!.material, material, [
            ...path,
            "files",
            index,
            "material",
          ]) as InlineMaterial | Selection,
          sourceIndices,
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
  result: Pick<SavedResult, "inputs" | "files" | "mappings">,
  upstream: readonly ArtifactRef[],
) {
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
    ...(result.mappings?.map((mapping) => ({
      selection: mapping.source,
      relation: "copy" as const,
    })) ?? []),
    ...upstream.map((ref) => ({
      selection: { ref },
      relation: "representation-source" as const,
    })),
  ];
}
