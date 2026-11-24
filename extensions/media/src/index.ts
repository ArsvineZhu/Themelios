import { join } from "node:path";
import {
  appError,
  parseValue,
  rangeSchema,
  type MediaInput,
  type PreparedRepresentation,
  type RecipeDescription,
  type RepresentationAdapter,
  type RepresentationCoverage,
} from "@themelios/core";
import { z } from "zod";
import {
  mediaTools,
  mediaToolsIdentity,
  outputBytes,
  withMedia,
  type MediaAdapterOptions,
  type MediaWorkspace,
} from "./ffmpeg.js";

export type { MediaAdapterOptions } from "./ffmpeg.js";

const clipParameters = z.strictObject({});
const frameParameters = z.strictObject({
  maxWidth: z.int().positive().default(1600),
  maxHeight: z.int().positive().default(1600),
});
const audio = "media.audio";
const video = "video.clip";
const frame = "video.frame";
const version = "1";
const videoMime = ["video/*"];
const audioMime = ["audio/*", ...videoMime];

function ffmpegTime(ms: number) {
  return (ms / 1000).toFixed(6);
}

type TimeRange = Extract<NonNullable<MediaInput["range"]>, { kind: "time" }>;
type Cut = { start: number; end: number };

function timestampCut(range: TimeRange, durationMs = Infinity): Cut {
  const start = Math.ceil(range.startMs * 1000) / 1000;
  const end = Math.floor(range.endMs * 1000) / 1000;
  if (start >= end || range.endMs > durationMs)
    throw appError("content.range_invalid", {
      details: {
        range,
        durationMs: Number.isFinite(durationMs) ? durationMs : null,
      },
    });
  return { start, end };
}

async function selection(
  input: MediaInput,
  work: MediaWorkspace,
): Promise<Cut | undefined> {
  if (!input.range) return;
  const parsed = rangeSchema.safeParse(input.range);
  if (!parsed.success || parsed.data.kind !== "time")
    throw appError("content.range_invalid", {
      details: { range: input.range },
    });
  const { extent } = input.info;
  return timestampCut(
    parsed.data,
    extent.kind === "time"
      ? extent.durationMs
      : await work.durationMs(work.input),
  );
}

function representation(
  input: MediaInput,
  recipe: string,
  file: { name: string; mediaType: string; bytes: Uint8Array },
  coverage: RepresentationCoverage,
): PreparedRepresentation {
  return {
    outputs: [file.name],
    result: {
      value: coverage.extent,
      inputs: [
        { source: input.source, delivered: [input.source], role: "primary" },
      ],
      files: [
        { name: file.name, material: file, sourceIndices: [0], coverage },
      ],
      producer: {
        kind: "transform",
        name: recipe,
        version,
        details: { tool: "ffmpeg" },
      },
    },
  };
}

const clips = {
  [audio]: {
    name: "clip.wav",
    mediaType: "audio/wav",
    flags: ["-map", "0:a:0", "-c:a", "pcm_s16le"],
  },
  [video]: {
    name: "clip.mp4",
    mediaType: "video/mp4",
    flags: [
      "-map",
      "0:V:0",
      "-map",
      "0:a:0?",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
    ],
  },
};

async function clip(
  input: MediaInput,
  work: MediaWorkspace,
  recipe: keyof typeof clips,
) {
  const selected = await selection(input, work);
  const { name, mediaType, flags } = clips[recipe];
  const path = join(work.directory, name);
  const bounds = selected
    ? [
        "-ss",
        ffmpegTime(selected.start),
        "-t",
        ffmpegTime(selected.end - selected.start),
      ]
    : [];
  // Decode leading packets so codecs with a bit reservoir can reconstruct the start of the cut.
  await work.convert([], [...flags, ...bounds], path);
  const bytes = await outputBytes(path, work.maxBytes);
  const durationMs = await work.durationMs(path);
  if (!durationMs)
    throw appError("content.range_invalid", {
      details: { reason: "Decoded selection has no duration" },
    });
  const sourceRange = selected
    ? {
        kind: "time" as const,
        startMs: selected.start,
        endMs: Math.min(selected.end, selected.start + durationMs),
      }
    : null;
  return representation(
    input,
    recipe,
    { name, bytes, mediaType },
    { sourceRange, extent: { kind: "time", durationMs } },
  );
}

async function inspectFrame(
  work: MediaWorkspace,
  { start, end }: Cut = { start: 0, end: Infinity },
) {
  const [entry = ""] = await Array.fromAsync(
    new Bun.Glob("frame-*.png").scan({ cwd: work.directory }),
  );
  const atMs = Number.parseInt(entry.slice(6, -4), 10) / 1000;
  if (!(atMs >= start && atMs < end)) {
    throw appError("content.range_invalid", {
      details: { reason: "No decoded frame in the selected time range" },
    });
  }
  return {
    atMs,
    bytes: await outputBytes(join(work.directory, entry), work.maxBytes),
  };
}

async function extractFrame(
  input: MediaInput,
  work: MediaWorkspace,
  settings: z.output<typeof frameParameters>,
  maxPixels: number,
) {
  const selected = await selection(input, work);
  const trim = selected
    ? `trim=start=${ffmpegTime(selected.start)}:end=${ffmpegTime(selected.end)},`
    : "";
  const { maxWidth, maxHeight } = settings;
  const scale = `scale=w='min(iw,${maxWidth})':h='min(ih,${maxHeight})':force_original_aspect_ratio=decrease`;
  await work.convert(
    ["-copyts", "-start_at_zero"],
    [
      "-map",
      "0:V:0",
      "-vf",
      trim + scale,
      "-frames:v",
      "1",
      "-fps_mode",
      "passthrough",
      "-enc_time_base",
      "1:1000000",
      "-frame_pts",
      "1",
    ],
    join(work.directory, "frame-%d.png"),
  );
  const { atMs, bytes } = await inspectFrame(work, selected);
  // The PNG IHDR dimensions describe the actual encoded frame after scaling.
  const dimensions = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  const width = dimensions.getUint32(16);
  const height = dimensions.getUint32(20);
  if (width * height > maxPixels) {
    throw appError("model.input_too_large", {
      details: { maxPixels, pixels: width * height },
    });
  }
  return representation(
    input,
    frame,
    { name: "frame.png", bytes, mediaType: "image/png" },
    {
      sourceRange: { kind: "timePoint", atMs },
      extent: { kind: "image", width, height, frames: 1 },
    },
  );
}

/** Installs local FFmpeg recipes. Binaries are resolved for each adapter set from configured paths or PATH. */
export function createMediaAdapters(
  options: MediaAdapterOptions = {},
): readonly RepresentationAdapter[] {
  const tools = mediaTools(options);
  const maxBytes = options.maxBytes ?? 67_108_864;
  const maxPixels = options.maxPixels ?? 40_000_000;
  const missing = [
    !tools.ffmpeg && "ffmpeg",
    !tools.ffprobe && "ffprobe",
  ].filter((name): name is string => Boolean(name));
  const available = async () => ({ available: missing.length === 0, missing });
  const probe: RepresentationAdapter["probe"] = (input, call) =>
    withMedia(tools, input, maxBytes, call, async (work) => {
      const durationMs = await work.durationMs(work.input);
      return durationMs === undefined
        ? { kind: "unknown" }
        : { kind: "time", durationMs };
    });
  function description(
    id: string,
    inputMimeTypes: readonly string[],
    output: string,
    supplies: RecipeDescription["supplies"],
    priority: number,
    parameters: RecipeDescription["parameters"] = clipParameters,
  ): RecipeDescription {
    return {
      id,
      version,
      inputMimeTypes,
      outputMimeTypes: [output],
      supplies,
      priority,
      parameters,
      titleKey: `recipe.${id}.title`,
    };
  }
  function clipAdapter(
    id: keyof typeof clips,
    inputMimeTypes: readonly string[],
    supplies: RecipeDescription["supplies"],
    priority: number,
  ): RepresentationAdapter {
    return {
      description: description(
        id,
        inputMimeTypes,
        clips[id].mediaType,
        supplies,
        priority,
      ),
      available,
      probe,
      cacheIdentity: () => mediaToolsIdentity(tools),
      prepare(input, raw, call) {
        parseValue(clipParameters, raw, "input.invalid");
        return withMedia(tools, input, maxBytes, call, (work) =>
          clip(input, work, id),
        );
      },
    };
  }
  return [
    clipAdapter(video, videoMime, ["visual", "speech", "motion"], 120),
    {
      description: description(
        frame,
        videoMime,
        "image/png",
        ["visual"],
        115,
        frameParameters,
      ),
      available,
      probe,
      cacheIdentity: async () => ({
        tools: await mediaToolsIdentity(tools),
        maxPixels,
      }),
      prepare(input, raw, call) {
        const settings = parseValue(frameParameters, raw, "input.invalid");
        return withMedia(tools, input, maxBytes, call, (work) =>
          extractFrame(input, work, settings, maxPixels),
        );
      },
    },
    clipAdapter(audio, audioMime, ["speech"], 110),
  ];
}
