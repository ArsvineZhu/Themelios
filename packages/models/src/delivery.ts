import {
  appError,
  type DeliveredMedia,
  type Extent,
  type MediaInput,
  type Range,
  type RepresentationCoverage,
} from "@themelios/core";
import type { ModelPart } from "./types.js";

function rangeBounds(
  range: Exclude<Range, { kind: "json" }>,
): readonly (readonly [number, number])[] {
  switch (range.kind) {
    case "text":
    case "pages":
      return [[range.start, range.end]];
    case "time":
      return [[range.startMs, range.endMs]];
    case "image":
      return [
        [range.x, range.x + range.width],
        [range.y, range.y + range.height],
      ];
  }
}

function within(
  actual: NonNullable<RepresentationCoverage["sourceRange"]>,
  requested: Range,
): boolean {
  if (actual.kind === "timePoint")
    return (
      requested.kind === "time" &&
      actual.atMs >= requested.startMs &&
      actual.atMs < requested.endMs
    );
  if (actual.kind !== requested.kind) return false;
  if (actual.kind === "json" || requested.kind === "json")
    return (
      actual.kind === "json" &&
      requested.kind === "json" &&
      actual.pointer === requested.pointer
    );
  const permitted = rangeBounds(requested);
  return rangeBounds(actual).every(([start, end], index) => {
    const [min, max] = permitted[index]!;
    return start >= min && end <= max;
  });
}

export function deliveredMedia(
  original: MediaInput,
  part: ModelPart,
  output?: { name: string; coverage?: RepresentationCoverage },
): DeliveredMedia {
  const coverage = output
    ? output.coverage
    : { sourceRange: original.range ?? null, extent: original.info.extent };
  if (
    !coverage ||
    (original.range &&
      (!coverage.sourceRange || !within(coverage.sourceRange, original.range)))
  ) {
    throw appError("input.capability_missing", {
      details: {
        mediaType: original.info.mediaType,
        required: "an output with verified coverage within the selected range",
      },
    });
  }
  return part.kind === "text"
    ? {
        mediaType: "text/plain",
        ...(output ? { name: output.name } : {}),
        sourceRange: coverage.sourceRange,
        extent: { kind: "text", bytes: Buffer.byteLength(part.text) },
      }
    : {
        mediaType: part.mediaType,
        ...(part.name === undefined ? {} : { name: part.name }),
        ...coverage,
      };
}

export function extentDescription(extent: Extent): string {
  switch (extent.kind) {
    case "text":
      return `${extent.bytes} bytes`;
    case "pages":
      return `${extent.pages} pages`;
    case "time":
      return `${extent.durationMs} ms`;
    case "image":
      return `${extent.width} × ${extent.height} px, ${extent.frames} frame(s)`;
    case "unknown":
      return "unknown";
  }
}
