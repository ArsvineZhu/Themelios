import {
  appError,
  mediaDecodeError,
  openCall,
  parseValue,
  rangeSchema,
  readMediaBytes,
  type CallOptions,
  type CallScope,
  type MediaInput,
  type Json,
  type RepresentationAdapter,
  type RepresentationFile,
} from "@themelios/core";
import sharp, { type Metadata, type Sharp } from "sharp";
import { z } from "zod";
export interface ImageAdapterOptions {
  maxPixels?: number;
  maxBytes?: number;
}

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
    quality: z.int().min(1).max(100).optional(),
    background: z.string().min(1).optional(),
  })
  .transform(({ maxWidth, maxHeight, quality, background, ...settings }) => ({
    ...settings,
    ...(maxWidth === undefined ? {} : { maxWidth }),
    ...(maxHeight === undefined ? {} : { maxHeight }),
    ...(quality === undefined ? {} : { quality }),
    ...(background === undefined ? {} : { background }),
  }));

async function loadedImage(
  input: MediaInput,
  maxPixels: number,
  options: CallOptions,
  maxBytes = 67_108_864,
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
    throw mediaDecodeError(input, error);
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

function checkRange(input: MediaInput, width: number, height: number) {
  const range = input.range;
  if (!range) return undefined;
  const parsed = rangeSchema.safeParse(range);
  if (
    !parsed.success ||
    parsed.data.kind !== "image" ||
    parsed.data.x + parsed.data.width > width ||
    parsed.data.y + parsed.data.height > height
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
  const { x, y, width: cropWidth, height: cropHeight } = parsed.data;
  return {
    left: x,
    top: y,
    width: cropWidth,
    height: cropHeight,
  };
}

async function orient(
  bytes: Uint8Array,
  metadata: Metadata,
  maxPixels: number,
): Promise<Sharp> {
  const decoder = sharp(bytes, { limitInputPixels: maxPixels });
  if ((metadata.orientation ?? 1) === 1) return decoder;
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
  parameters: { quality?: number; background?: string },
  hasAlpha: boolean,
): Sharp {
  if (format === "png") return image.png();
  const quality = parameters.quality ?? 90;
  if (format === "webp") return image.webp({ quality });
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
  return image.jpeg({ quality });
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
    requiresNormalization(input, options) {
      return withImage(input, maxPixels, maxBytes, options, (image) => {
        requireSingleFrame(input, image.frames);
        return image.rotate;
      });
    },
    cacheIdentity: () => ({
      libraries: Object.entries(sharp.versions).map(([library, version]) => [
        library,
        version ?? null,
      ]),
      maxPixels,
    }),
    parametersForModel(inputMime, acceptedMime, parameters) {
      const parsed = parametersSchema.safeParse(parameters);
      if (!parsed.success || acceptedMime(inputMime)) return parameters;
      const value = parsed.data;
      if (value.format !== "source") return parameters;
      const format = formats.find((candidate) =>
        acceptedMime(imageType(candidate)),
      );
      return format ? { ...value, format } : value;
    },
    async prepare(input, raw, options) {
      const parameters = parseValue(parametersSchema, raw, "input.invalid");
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
            (format !== "png" && parameters.quality !== undefined);
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
          const files: RepresentationFile[] = [
            {
              name: "image",
              sourceIndices: [0],
              coverage: {
                sourceRange: input.range ?? null,
                extent: {
                  kind: "image",
                  width: output.width,
                  height: output.height,
                  frames,
                },
              },
              material: {
                bytes: output.bytes,
                mediaType: imageType(format),
                name: `image.${format}`,
              },
            },
          ];
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
              files,
              producer: { kind: "transform", name: id, version, details },
            },
          };
        },
      );
    },
  };
}
