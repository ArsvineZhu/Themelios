import {
  AppError,
  appError,
  openCall,
  type CallOptions,
  type CallScope,
  type Json,
} from "@themelios/core";
import sharp, { type Metadata, type Sharp } from "sharp";
import { z } from "zod";
import type { MediaInput, RepresentationAdapter } from "./input-contracts.js";
import { readMediaBytes } from "./media-bytes.js";

const id = "image.normalize";
const version = "1";
const defaultMaxPixels = 40_000_000;
const formats = ["png", "jpeg", "webp"] as const;
type Format = (typeof formats)[number];
const imageType = (format: Format) => `image/${format}`;
const mimeTypes = formats.map(imageType);
const parametersSchema = z
  .strictObject({
    format: z.enum(["source", ...formats]).default("source"),
    maxWidth: z.int().positive().optional(),
    maxHeight: z.int().positive().optional(),
    quality: z.int().min(1).max(100).default(90),
    background: z.string().min(1).optional(),
  })
  .transform(({ maxWidth, maxHeight, background, ...settings }) => ({
    ...settings,
    ...(maxWidth === undefined ? {} : { maxWidth }),
    ...(maxHeight === undefined ? {} : { maxHeight }),
    ...(background === undefined ? {} : { background }),
  }));
type Parameters = z.infer<typeof parametersSchema>;

export interface ImageAdapterOptions {
  maxPixels?: number;
  maxBytes?: number;
}

function imageError(input: MediaInput, reason: unknown): AppError {
  return appError("content.decode_failed", {
    details: {
      mediaType: input.info.mediaType,
      name: input.info.name ?? null,
      ...("ref" in input.source ? { ref: input.source.ref } : {}),
      reason: String(reason),
    },
    cause: reason,
  });
}

async function loadedImage(
  input: MediaInput,
  maxPixels: number,
  options: CallOptions,
  maxBytes?: number,
) {
  const bytes = await readMediaBytes(input, options, maxBytes);
  const metadata = await sharp(bytes, { limitInputPixels: false }).metadata();
  const format = formats.find((candidate) => candidate === metadata.format);
  if (format === undefined || imageType(format) !== input.info.mediaType) {
    throw appError("content.media_mismatch", {
      details: {
        declared: input.info.mediaType,
        detected: format === undefined ? metadata.format : imageType(format),
      },
    });
  }
  const { width, height } = metadata.autoOrient ?? metadata;
  const frames = metadata.pages ?? 1;
  const pixels = width * height * frames;
  if (pixels > maxPixels)
    throw appError("model.input_too_large", {
      details: { name: input.info.name ?? null, maxPixels, pixels },
    });
  return {
    bytes,
    metadata,
    format,
    width,
    height,
    frames,
    rotate: (metadata.orientation ?? 1) > 1,
  };
}

type CapturedImage = Awaited<ReturnType<typeof loadedImage>>;

async function withImage<T>(
  input: MediaInput,
  maxPixels: number,
  maxBytes: number | undefined,
  options: CallOptions | undefined,
  work: (image: CapturedImage, call: CallScope) => T | Promise<T>,
): Promise<T> {
  const scope = openCall(id, options);
  try {
    const image = await loadedImage(
      input,
      maxPixels,
      { signal: scope.signal },
      maxBytes,
    );
    scope.throwIfAborted();
    const output = await work(image, scope);
    scope.throwIfAborted();
    return output;
  } catch (error) {
    scope.throwIfAborted();
    if (error instanceof AppError) throw error;
    throw imageError(input, error);
  } finally {
    scope.close();
  }
}

function requireSingleFrame(input: MediaInput, frames: number): void {
  if (frames === 1) return;
  throw appError("input.capability_missing", {
    details: {
      mediaType: input.info.mediaType,
      reason: "select a frame with an animation adapter",
    },
  });
}

export function imageNeedsOrientation(
  input: MediaInput,
  maxPixels = defaultMaxPixels,
  options?: CallOptions,
  maxBytes?: number,
): Promise<boolean> {
  return withImage(input, maxPixels, maxBytes, options, (image) => {
    requireSingleFrame(input, image.frames);
    return image.rotate;
  });
}

function checkRange(input: MediaInput, width: number, height: number) {
  const range = input.range;
  if (!range) return undefined;
  if (
    range.kind !== "image" ||
    range.x + range.width > width ||
    range.y + range.height > height ||
    ![range.x, range.y, range.width, range.height].every(
      Number.isSafeInteger,
    ) ||
    range.x < 0 ||
    range.y < 0 ||
    range.width <= 0 ||
    range.height <= 0
  ) {
    throw appError("content.range_invalid", {
      details: {
        range,
        ...("ref" in input.source ? { ref: input.source.ref } : {}),
        reason: "invalid rectangle in the oriented image",
        width,
        height,
      },
    });
  }
  return {
    left: range.x,
    top: range.y,
    width: range.width,
    height: range.height,
  };
}

async function orient(
  bytes: Uint8Array,
  metadata: Metadata,
  maxPixels: number,
): Promise<Sharp> {
  const decoder = sharp(bytes, { limitInputPixels: maxPixels });
  if ((metadata.orientation ?? 1) === 1) return decoder;
  // Flatten EXIF orientation into pixels before applying crop coordinates.
  const { data, info } = await decoder
    .autoOrient()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
    limitInputPixels: maxPixels,
  });
}

function encode(
  image: Sharp,
  format: Format,
  parameters: Parameters,
  hasAlpha: boolean,
): Sharp {
  if (format === "png") return image.png();
  if (format === "webp") return image.webp({ quality: parameters.quality });
  if (hasAlpha) {
    if (!parameters.background)
      throw appError("input.invalid", {
        details: {
          issues: [
            {
              path: ["background"],
              reason:
                "A background color is required to convert transparency to JPEG",
            },
          ],
        },
      });
    image.flatten({ background: parameters.background });
  }
  return image.jpeg({ quality: parameters.quality });
}

export function createImageAdapter({
  maxPixels = defaultMaxPixels,
  maxBytes,
}: ImageAdapterOptions = {}): RepresentationAdapter {
  return {
    description: {
      id,
      version,
      inputMimeTypes: mimeTypes,
      outputMimeTypes: mimeTypes,
      supplies: ["visual"],
      priority: 100,
      titleKey: "recipe.image.normalize.title",
      parameters: parametersSchema,
    },
    async available() {
      const missing = formats.filter(
        (format) =>
          !sharp.format[format].input.buffer ||
          !sharp.format[format].output.buffer,
      );
      return { available: missing.length === 0, missing };
    },
    probe(input, options) {
      return withImage(
        input,
        maxPixels,
        maxBytes,
        options,
        ({ width, height, frames }) => ({
          kind: "image",
          width,
          height,
          frames,
        }),
      );
    },
    async prepare(input, raw, options) {
      const checked = parametersSchema.safeParse(raw);
      if (!checked.success)
        throw appError("input.invalid", {
          details: {
            issues: checked.error.issues.map((issue) => ({
              path: issue.path.map(String),
              reason: issue.message,
            })),
          },
        });
      const parameters = checked.data;
      return withImage(
        input,
        maxPixels,
        maxBytes,
        options,
        async (
          {
            metadata,
            bytes,
            format: originalFormat,
            width,
            height,
            frames,
            rotate,
          },
          scope,
        ) => {
          requireSingleFrame(input, frames);
          const crop = checkRange(input, width, height);
          const format =
            parameters.format === "source" ? originalFormat : parameters.format;
          const resize =
            (crop?.width ?? width) > (parameters.maxWidth ?? Infinity) ||
            (crop?.height ?? height) > (parameters.maxHeight ?? Infinity);
          const reencode =
            format !== originalFormat ||
            (format !== "png" &&
              typeof raw === "object" &&
              raw !== null &&
              Object.hasOwn(raw, "quality"));
          let output = { bytes, width, height };
          if (rotate || crop || resize || reencode) {
            const image = await orient(bytes, metadata, maxPixels);
            scope.throwIfAborted();
            if (crop) image.extract(crop);
            if (resize)
              image.resize(parameters.maxWidth, parameters.maxHeight, {
                fit: "inside",
                withoutEnlargement: true,
              });
            const { data, info } = await encode(
              image,
              format,
              parameters,
              metadata.hasAlpha,
            ).toBuffer({ resolveWithObject: true });
            output = { bytes: data, width: info.width, height: info.height };
          }
          scope.throwIfAborted();
          const details: Json = {
            library: "sharp",
            libraryVersion: sharp.versions.sharp,
            parameters,
          };
          return {
            outputs: ["image"],
            result: {
              value: { width: output.width, height: output.height, format },
              inputs: [
                {
                  source: input.source,
                  delivered: [input.source],
                  role: "primary",
                },
              ],
              files: [
                {
                  name: "image",
                  sourceIndices: [0],
                  material: {
                    bytes: output.bytes,
                    mediaType: imageType(format),
                    name: `image.${format}`,
                  },
                },
              ],
              producer: { kind: "transform", name: id, version, details },
            },
          };
        },
      );
    },
  };
}
