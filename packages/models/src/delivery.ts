import {
  appError,
  matchesMime,
  plainTextMediaType,
  type DeliveredMedia,
  type Extent,
  type MediaInput,
  type Range,
  type RepresentationCoverage,
} from "@themelios/core";
import type { ModelCapabilities, ModelPart } from "./types.js";

export function partMediaType(part: ModelPart): string {
  return part.kind === "text" ? plainTextMediaType : part.mediaType;
}

export function partBytes(part: ModelPart): number {
  return part.kind === "text"
    ? Buffer.byteLength(part.text)
    : part.bytes.byteLength;
}

export function modelAcceptsMedia(
  model: ModelCapabilities,
  mediaType: string,
): boolean {
  return model.inputMimeTypes.some((pattern) =>
    matchesMime(pattern, mediaType),
  );
}

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
  output?: { name?: string; coverage?: RepresentationCoverage },
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
        mediaType: plainTextMediaType,
        ...(output?.name === undefined ? {} : { name: output.name }),
        sourceRange: coverage.sourceRange,
        extent: { kind: "text", bytes: partBytes(part) },
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

export function rangeDescription(
  range: RepresentationCoverage["sourceRange"],
): string {
  if (!range) return "full";
  switch (range.kind) {
    case "text":
      return `bytes ${range.start}..${range.end}`;
    case "pages":
      return range.end === range.start + 1
        ? `page ${range.start}`
        : `pages ${range.start}..${range.end - 1}`;
    case "time":
      return `${range.startMs}ms..${range.endMs}ms`;
    case "image":
      return `region ${range.x},${range.y} ${range.width}x${range.height} px`;
    case "json":
      return `pointer ${range.pointer}`;
    case "timePoint":
      return `frame at ${range.atMs} ms`;
  }
}

export function deliveredDescription({
  sourceRange,
  extent,
  mediaType,
  name,
}: DeliveredMedia): string {
  return `${name ?? mediaType}: ${rangeDescription(sourceRange)} (${mediaType}, ${extentDescription(extent)})`;
}
