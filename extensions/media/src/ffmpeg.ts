import { mkdtemp, readdir, realpath, rm, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  appError,
  mediaDecodeError,
  openCall,
  readMediaBytes,
  throwIfAborted,
  type CallOptions,
  type MediaInput,
} from "@themelios/core";
import { z } from "zod";

export interface MediaAdapterOptions {
  readonly ffmpeg?: string | undefined;
  readonly ffprobe?: string | undefined;
  readonly maxBytes?: number | undefined;
  readonly maxPixels?: number | undefined;
}

const demuxers =
  "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,mp3,aac,ogg,wav,flac,avi,mpeg,mpegts,aiff,asf,amr,ac3,eac3";
const localMedia = [
  "-protocol_whitelist",
  "file",
  "-format_whitelist",
  demuxers,
];

const metadata = z.object({
  format: z.object({
    duration: z
      .union([
        z.literal("N/A").transform(() => undefined),
        z.coerce.number().nonnegative(),
      ])
      .optional(),
  }),
});

export function mediaTools(options: MediaAdapterOptions) {
  const ffmpeg = Bun.which(options.ffmpeg ?? "ffmpeg");
  const paths = [ffmpeg && dirname(ffmpeg), process.env.PATH].filter(Boolean);
  const ffprobe = Bun.which(options.ffprobe ?? "ffprobe", {
    PATH: paths.join(delimiter),
  });
  return { ffmpeg, ffprobe };
}

/** Identifies the resolved binaries, including replacement at an unchanged path. */
export async function mediaToolsIdentity(tools: ReturnType<typeof mediaTools>) {
  return Promise.all(
    [tools.ffmpeg, tools.ffprobe].map(async (binary) => {
      if (!binary) return null;
      const path = await realpath(binary);
      const { dev, ino, size, mtimeNs } = await stat(path, { bigint: true });
      return [path, String(dev), String(ino), String(size), String(mtimeNs)];
    }),
  );
}

async function run(
  binary: string,
  args: readonly string[],
  signal: AbortSignal,
) {
  throwIfAborted(signal);
  const process = Bun.spawn([binary, "-hide_banner", "-v", "error", ...args], {
    signal,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, output, error] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  throwIfAborted(signal);
  if (code !== 0) {
    throw appError("content.decode_failed", {
      details: { reason: error.trim().slice(0, 1000), exitCode: code },
    });
  }
  return output;
}

export interface MediaWorkspace {
  readonly input: string;
  readonly directory: string;
  readonly maxBytes: number;
  durationMs(path: string): Promise<number | undefined>;
  convert(
    inputFlags: readonly string[],
    outputFlags: readonly string[],
    path: string,
  ): Promise<void>;
}

export async function withMedia<T>(
  tools: ReturnType<typeof mediaTools>,
  input: MediaInput,
  maxBytes: number,
  options: CallOptions | undefined,
  work: (workspace: MediaWorkspace) => Promise<T>,
): Promise<T> {
  const { ffmpeg, ffprobe } = tools;
  if (!ffmpeg || !ffprobe) {
    throw appError("input.capability_missing", {
      details: {
        mediaType: input.info.mediaType,
        required: "FFmpeg and ffprobe",
      },
    });
  }
  const call = openCall("media.ffmpeg", options);
  let directory: string | undefined;
  try {
    const data = await readMediaBytes(input, { signal: call.signal }, maxBytes);
    directory = await mkdtemp(join(tmpdir(), "themelios-media-"));
    const source = join(directory, "source");
    await Bun.write(source, data);
    return await work({
      input: source,
      directory,
      maxBytes,
      async durationMs(path) {
        const output = await run(
          ffprobe,
          [
            ...localMedia,
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            path,
          ],
          call.signal,
        );
        const value: unknown = JSON.parse(output);
        const { duration } = metadata.parse(value).format;
        return duration === undefined
          ? undefined
          : Math.round(duration * 1_000_000) / 1000;
      },
      async convert(inputFlags, outputFlags, path) {
        await run(
          ffmpeg,
          [
            "-nostdin",
            "-xerror",
            "-y",
            ...localMedia,
            ...inputFlags,
            "-i",
            source,
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
            ...outputFlags,
            "-fs",
            String(maxBytes),
            path,
          ],
          call.signal,
        );
      },
    });
  } catch (error) {
    call.throwIfAborted();
    throw mediaDecodeError(input, error);
  } finally {
    call.close();
    if (directory) {
      for (const entry of await readdir(directory))
        await rm(join(directory, entry), { force: true });
      await rmdir(directory);
    }
  }
}

export async function outputBytes(path: string, maxBytes: number) {
  const file = Bun.file(path);
  if (!(await file.exists()) || file.size === 0) {
    throw appError("content.range_invalid", {
      details: { reason: "The selection contains no decodable media" },
    });
  }
  if (file.size >= maxBytes) {
    throw appError("model.input_too_large", {
      details: { actualBytes: file.size, maxBytes },
    });
  }
  return file.bytes();
}
