import { open } from "node:fs/promises";
import { basename } from "node:path";
import { AppError, openCall, type CallOptions } from "@themelios/core";
import type { BlobInfo, Cas } from "@themelios/storage";
import { z } from "zod";
import {
  newArtifactRef,
  mediaTypeSchema,
  originSchema,
  type ArtifactDraft,
} from "./artifacts.js";
import type { AcceptInput, Origin } from "./contracts.js";
import { detectMetadata } from "./media-metadata.js";
import { contentError, validated } from "./validation.js";

const importFields = {
  mediaType: mediaTypeSchema,
  name: z.string().min(1).optional(),
  origin: originSchema.optional(),
};
const acceptSchema = z.union([
  z.strictObject({ ...importFields, bytes: z.instanceof(Uint8Array) }),
  z.strictObject({
    ...importFields,
    mediaType: mediaTypeSchema.optional(),
    file: z.string().min(1),
  }),
  z.strictObject({
    ...importFields,
    body: z.instanceof(ReadableStream<Uint8Array>),
  }),
]);

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
    if (accepted.bytes.byteLength > maxInlineBytes) {
      throw contentError("storage.limit_exceeded", {
        maxBytes: maxInlineBytes,
        sizeBytes: accepted.bytes.byteLength,
      });
    }
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
    const { mediaType, extent } = await detectMetadata(
      cas,
      blob,
      scope.signal,
      declared,
      name,
    );
    scope.throwIfAborted();
    return {
      ref: newArtifactRef(),
      kind: "material",
      blob: blob.ref,
      sizeBytes: blob.sizeBytes,
      mediaType,
      extent,
      ...(name === undefined ? {} : { name }),
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
