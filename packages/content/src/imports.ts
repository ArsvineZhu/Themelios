import { open } from "node:fs/promises";
import { basename } from "node:path";
import {
  AppError,
  inlineMaterialSchema,
  openCall,
  type CallOptions,
  type RepresentationAdapter,
} from "@themelios/core";
import type { BlobInfo, Cas } from "@themelios/storage";
import { z } from "zod";
import {
  newArtifactRef,
  originSchema,
  type ArtifactDraft,
  type Origin,
} from "./artifacts.js";
import { detectMetadata, probeExtent } from "./media-metadata.js";
import { contentError, validated } from "./validation.js";

const inlineImportSchema = inlineMaterialSchema.extend({
  origin: originSchema.optional(),
});
const externalImportSchema = inlineImportSchema
  .omit({ bytes: true })
  .partial({ mediaType: true });
const acceptSchema = z.union([
  inlineImportSchema,
  externalImportSchema.extend({
    file: z.string().min(1),
  }),
  externalImportSchema.extend({
    body: z.instanceof(ReadableStream<Uint8Array>),
  }),
]);
export type AcceptInput = z.output<typeof acceptSchema>;

const credentialParam =
  /^(access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|auth|jwt|secret|password|passwd|key|token|signature|sig|x-amz-.*|x-goog-.*)$/i;

function cleanOrigin(origin: Origin): Origin {
  if (origin.kind !== "url" || !origin.locator) return structuredClone(origin);
  let locator: URL;
  try {
    locator = new URL(origin.locator);
  } catch (error) {
    throw contentError(
      "content.schema_invalid",
      {
        issues: [
          { path: "/origin/locator", constraint: "Expected an absolute URL" },
        ],
      },
      error,
    );
  }
  locator.username = "";
  locator.password = "";
  locator.hash = "";
  const credentials = Array.from(locator.searchParams.keys()).filter((key) =>
    credentialParam.test(key),
  );
  for (const key of credentials) locator.searchParams.delete(key);
  return { ...structuredClone(origin), locator: locator.href };
}

export interface ImportLimits {
  maxImportBytes: number;
  maxInlineBytes: number;
  adapters: readonly RepresentationAdapter[];
}

export function checkInlineImportSize(
  bytes: Uint8Array,
  maxBytes: number,
): void {
  if (bytes.byteLength > maxBytes)
    throw contentError("storage.limit_exceeded", {
      maxBytes,
      sizeBytes: bytes.byteLength,
    });
}

export type CapturedImport = ReturnType<typeof captureImport>;

export function captureImport(
  input: AcceptInput,
  maxInlineBytes: number,
  copyBytes = true,
) {
  const accepted = validated(acceptSchema, input);
  const origin =
    accepted.origin ??
    ("file" in accepted
      ? {
          kind: "file" as const,
          locator: accepted.file,
          capturedAt: new Date().toISOString(),
        }
      : undefined);
  const originInfo = origin && cleanOrigin(origin);
  if ("bytes" in accepted) {
    checkInlineImportSize(accepted.bytes, maxInlineBytes);
    return {
      ...accepted,
      bytes: copyBytes ? new Uint8Array(accepted.bytes) : accepted.bytes,
      origin: originInfo,
    };
  }
  return { ...accepted, origin: originInfo };
}

export async function importArtifact(
  cas: Cas,
  accepted: CapturedImport,
  limits: ImportLimits,
  options?: CallOptions,
): Promise<ArtifactDraft> {
  const scope = openCall("content.prepare_material", options);
  try {
    scope.throwIfAborted();
    const { mediaType: declared } = accepted;
    const { adapters } = limits;
    const name =
      accepted.name ??
      ("file" in accepted ? basename(accepted.file) : undefined);
    const originInfo = accepted.origin;
    const put = {
      signal: scope.signal,
      maxBytes:
        "bytes" in accepted ? limits.maxInlineBytes : limits.maxImportBytes,
    };
    let blob: BlobInfo;
    if ("bytes" in accepted) {
      blob = await cas.put(accepted.bytes, put);
    } else if ("file" in accepted) {
      const file = await open(accepted.file, "r");
      try {
        if (!(await file.stat()).isFile())
          throw contentError("content.decode_failed", {
            reason: "expected a regular file",
          });
        // Byte streams returned by Node's FileHandle and Bun's global share the Web Streams runtime contract.
        const body =
          file.readableWebStream() as unknown as ReadableStream<Uint8Array>;
        blob = await cas.put(body, put);
      } finally {
        await file.close();
      }
    } else {
      blob = await cas.put(accepted.body, put);
    }
    const detected = await detectMetadata(
      cas,
      blob,
      scope.signal,
      declared,
      name,
    );
    const ref = newArtifactRef();
    const info = {
      sizeBytes: blob.sizeBytes,
      ...detected,
      ...(name === undefined ? {} : { name }),
    };
    const extent = await probeExtent(
      {
        source: { ref },
        info,
        open(call) {
          return cas.read(blob.ref, call);
        },
      },
      adapters,
      { signal: scope.signal },
    );
    scope.throwIfAborted();
    return {
      ...info,
      ref,
      kind: "material",
      blob: blob.ref,
      extent,
      ...(originInfo === undefined ? {} : { origin: originInfo }),
    };
  } catch (error) {
    scope.throwIfAborted();
    if (error instanceof AppError) throw error;
    throw contentError(
      "content.decode_failed",
      { reason: String(error) },
      error,
    );
  } finally {
    scope.close();
  }
}
