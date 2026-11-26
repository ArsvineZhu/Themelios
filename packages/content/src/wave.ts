import {
  appError,
  mediaDecodeError,
  mediaRangeFits,
  openCall,
  parseValue,
  rangeSchema,
  readMediaBytes,
  type CallOptions,
  type MediaInput,
  type RepresentationAdapter,
} from "@themelios/core";
import { WaveFile } from "wavefile";
import { z } from "zod";

const id = "audio.wave.slice";
const version = "1";
const parameters = z.strictObject({});
const format = z.object({
  audioFormat: z.literal(1),
  numChannels: z.int().positive(),
  sampleRate: z.int().positive(),
  blockAlign: z.int().positive(),
  bitsPerSample: z.union([
    z.literal(8),
    z.literal(16),
    z.literal(24),
    z.literal(32),
  ]),
});
const dataChunk = z.object({
  samples: z.instanceof(Uint8Array),
  chunkSize: z.int().nonnegative(),
});

function frameTime(frame: number, sampleRate: number) {
  return (frame * 1000) / sampleRate;
}

function frameAt(ms: number, sampleRate: number, round: typeof Math.floor) {
  const position = (ms * sampleRate) / 1000;
  const nearest = Math.round(position);
  // Recover exact boundaries from the same time coordinates reported by probe and prepare.
  return frameTime(nearest, sampleRate) === ms ? nearest : round(position);
}

/** Cuts PCM WAV at frame boundaries and writes a new container without original metadata. */
export function createWaveAdapter({
  maxBytes,
}: { maxBytes?: number } = {}): RepresentationAdapter {
  async function read(input: MediaInput, options?: CallOptions) {
    const call = openCall(id, options);
    try {
      const bytes = await readMediaBytes(
        input,
        { signal: call.signal },
        maxBytes,
      );
      const wave = new WaveFile(bytes);
      const fmt = format.safeParse(wave.fmt);
      if (wave.container !== "RIFF" || !fmt.success) return undefined;
      const { numChannels, sampleRate, blockAlign, bitsPerSample } = fmt.data;
      const { samples, chunkSize } = dataChunk.parse(wave.data);
      if (
        blockAlign !== numChannels * (bitsPerSample / 8) ||
        chunkSize !== samples.length ||
        samples.length % blockAlign !== 0
      )
        throw new Error("Invalid PCM frame layout");
      call.throwIfAborted();
      return {
        ...fmt.data,
        samples,
        durationMs: frameTime(samples.length / blockAlign, sampleRate),
      };
    } catch (error) {
      call.throwIfAborted();
      throw mediaDecodeError(input, error);
    } finally {
      call.close();
    }
  }

  return {
    description: {
      id,
      version,
      inputMimeTypes: ["audio/wav", "audio/x-wav", "audio/wave"],
      outputMimeTypes: ["audio/wav"],
      supplies: ["speech"],
      parameters,
      priority: 100,
      titleKey: "recipe.audio.wave.slice.title",
    },
    async available() {
      return { available: true, missing: [] };
    },
    async probe(input, options) {
      const wave = await read(input, options);
      return wave
        ? { kind: "time", durationMs: wave.durationMs }
        : { kind: "unknown" };
    },
    async prepare(input, raw, options) {
      parseValue(parameters, raw, "input.invalid");
      const wave = await read(input, options);
      if (!wave) {
        throw appError("input.capability_missing", {
          details: {
            mediaType: input.info.mediaType,
            required: "RIFF PCM WAV slicer for this encoding",
          },
        });
      }
      const {
        samples,
        numChannels,
        blockAlign,
        sampleRate,
        bitsPerSample,
        durationMs,
      } = wave;
      const range = input.range;
      const start =
        range?.kind === "time"
          ? frameAt(range.startMs, sampleRate, Math.ceil)
          : 0;
      const end =
        range?.kind === "time"
          ? frameAt(range.endMs, sampleRate, Math.floor)
          : samples.length / blockAlign;
      if (
        range &&
        (range.kind !== "time" ||
          !rangeSchema.safeParse(range).success ||
          !mediaRangeFits(range, { kind: "time", durationMs }) ||
          start >= end)
      ) {
        throw appError("content.range_invalid", {
          details: {
            range,
            durationMs,
            reason: "Expected a time interval containing complete PCM frames",
          },
        });
      }
      const slice = samples.subarray(start * blockAlign, end * blockAlign);
      const output = new WaveFile();
      output.fromScratch(numChannels, sampleRate, String(bitsPerSample), []);
      Object.assign(output.data, { samples: slice, chunkSize: slice.length });
      const bytes = output.toBuffer();
      const name = "segment.wav";
      const sourceRange = range
        ? {
            kind: "time" as const,
            startMs: frameTime(start, sampleRate),
            endMs: frameTime(end, sampleRate),
          }
        : null;
      return {
        outputs: [name],
        result: {
          value: { sampleRate, numChannels },
          files: [
            {
              name,
              material: { name, bytes, mediaType: "audio/wav" },
              sourceIndices: [0],
              coverage: {
                sourceRange,
                extent: {
                  kind: "time",
                  durationMs: frameTime(end - start, sampleRate),
                },
              },
            },
          ],
          inputs: [
            {
              source: input.source,
              delivered: [input.source],
              role: "primary",
            },
          ],
          producer: { kind: "transform", name: id, version },
        },
      };
    },
  };
}
