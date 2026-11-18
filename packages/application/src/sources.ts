import { fileURLToPath } from "node:url";
import { appError, type CallOptions } from "@themelios/core";
import type { Network } from "@themelios/runtime/network";
import type { SourceAdapter, SourceRequest } from "./input-contracts.js";

export function createSourceAdapters(
  network: Network,
): readonly SourceAdapter[] {
  return [
    {
      schemes: ["file"],
      async open(request) {
        const file = fileURLToPath(request.uri);
        return {
          file,
          ...(request.mediaType === undefined
            ? {}
            : { mediaType: request.mediaType }),
          ...(request.name === undefined ? {} : { name: request.name }),
        };
      },
    },
    {
      schemes: ["http", "https"],
      async open(request, options) {
        const response = await network.fetch(
          request.uri,
          options?.signal ? { signal: options.signal } : undefined,
        );
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw appError("network.failed", {
            details: {
              method: "GET",
              origin: new URL(request.uri).origin,
              phase: "response",
              status: response.status,
            },
          });
        }
        const mediaType =
          request.mediaType ??
          response.headers.get("content-type")?.split(";")[0]?.trim() ??
          "application/octet-stream";
        const etag = response.headers.get("etag");
        const lastModified = response.headers.get("last-modified");
        return {
          body: response.body,
          mediaType,
          ...(request.name === undefined ? {} : { name: request.name }),
          origin: {
            kind: "url",
            locator: response.url || request.uri,
            capturedAt: new Date().toISOString(),
            metadata: {
              ...(etag === null ? {} : { etag }),
              ...(lastModified === null ? {} : { lastModified }),
            },
          },
        };
      },
    },
  ];
}

export function openSource(
  adapters: readonly SourceAdapter[],
  request: SourceRequest,
  options?: CallOptions,
) {
  const protocol = URL.parse(request.uri)?.protocol.slice(0, -1);
  const matches = adapters.filter(
    (adapter) => protocol && adapter.schemes.includes(protocol),
  );
  if (matches.length !== 1)
    throw appError("input.capability_missing", {
      details: { required: protocol ?? "source adapter" },
    });
  return matches[0]!.open(request, options);
}
