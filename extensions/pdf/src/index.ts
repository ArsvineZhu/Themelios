import {
  appError,
  defaultImagePixels,
  defaultMediaInputBytes,
  parseValue,
  plainTextMediaType,
  type Json,
  type MediaInput,
  type PreparedRepresentation,
  type RecipeDescription,
  type RepresentationAdapter,
  type RepresentationCoverage,
  type RepresentationFile,
} from "@themelios/core";
import pdfLibPackage from "pdf-lib/package.json" with { type: "json" };
import { z } from "zod";
import {
  bounds,
  pdfMediaType,
  pdfjsVersion,
  withPdf,
  withPdfBytes,
  type PdfAdapterOptions,
} from "./document.js";
import { copyPages, renderPages } from "./pages.js";
import { extractText } from "./text.js";

export type { PdfAdapterOptions } from "./document.js";

const inputMimeTypes = [pdfMediaType];
const textRecipe = "pdf.text";
const pagesRecipe = "pdf.pages";
const renderRecipe = "pdf.render";
const version = "1";
const empty = z.strictObject({});
const renderDimension = z.int().positive().default(1600);
const renderParameters = z.strictObject({
  maxWidth: renderDimension,
  maxHeight: renderDimension,
});

function prepared(
  input: MediaInput,
  id: string,
  value: Json,
  files: RepresentationFile[],
  details: Json,
): PreparedRepresentation {
  return {
    outputs: files.map((file) => file.name),
    result: {
      value,
      files,
      inputs: [
        { source: input.source, delivered: [input.source], role: "primary" },
      ],
      producer: { kind: "transform", name: id, version, details },
    },
  };
}

function file(
  name: string,
  bytes: Uint8Array,
  mediaType: string,
  coverage: RepresentationCoverage,
): RepresentationFile {
  return {
    name,
    material: { name, bytes, mediaType },
    sourceIndices: [0],
    coverage,
  };
}

/** PDF adapters can be registered independently of a task or model provider. */
export function createPdfAdapters({
  maxBytes = defaultMediaInputBytes,
  maxPixels = defaultImagePixels,
}: PdfAdapterOptions = {}): readonly RepresentationAdapter[] {
  const probe: RepresentationAdapter["probe"] = (input, options) =>
    withPdf(input, maxBytes, options, async (pdf) => ({
      kind: "pages",
      pages: pdf.numPages,
    }));
  const available = async () => ({ available: true, missing: [] });
  function recipe(
    id: string,
    supplies: RecipeDescription["supplies"],
    outputMimeTypes: string[],
    schema: z.ZodType<Json>,
    priority: number,
  ): RecipeDescription {
    return {
      id,
      version,
      inputMimeTypes,
      supplies,
      outputMimeTypes,
      parameters: schema,
      priority,
      titleKey: `recipe.${id}.title`,
    };
  }
  function enforceBytes(size: number) {
    if (size > maxBytes)
      throw appError("model.input_too_large", {
        details: { actualBytes: size, maxBytes },
      });
  }
  return [
    {
      description: recipe(
        textRecipe,
        ["text"],
        [plainTextMediaType],
        empty,
        10,
      ),
      validateForModel(representation, input) {
        const value = representation.result.value as { emptyPages: number[] };
        if (value.emptyPages.length) {
          throw appError("input.capability_missing", {
            details: {
              mediaType: input.info.mediaType,
              required: "text on every selected PDF page; use a visual route",
              emptyPages: value.emptyPages,
            },
          });
        }
      },
      probe,
      available,
      prepare(input, raw, options) {
        parseValue(empty, raw, "input.invalid");
        return withPdf(input, maxBytes, options, async (pdf, signal) => {
          const { bytes, pages, emptyPages } = await extractText(
            pdf,
            bounds(input, pdf.numPages),
            signal,
          );
          enforceBytes(bytes.byteLength);
          return prepared(
            input,
            textRecipe,
            { pages, emptyPages },
            [
              file("text.txt", bytes, plainTextMediaType, {
                sourceRange: input.range ?? null,
                extent: { kind: "text", bytes: bytes.byteLength },
              }),
            ],
            { library: "pdfjs-dist", libraryVersion: pdfjsVersion },
          );
        });
      },
    },
    {
      description: recipe(
        pagesRecipe,
        ["text", "visual"],
        [pdfMediaType],
        empty,
        40,
      ),
      probe,
      available,
      prepare(input, raw, options) {
        parseValue(empty, raw, "input.invalid");
        return withPdfBytes(input, maxBytes, options, async (data, signal) => {
          const { bytes, pages } = await copyPages(input, data, signal);
          enforceBytes(bytes.byteLength);
          return prepared(
            input,
            pagesRecipe,
            { pages },
            [
              file("pages.pdf", bytes, pdfMediaType, {
                sourceRange: input.range ?? null,
                extent: { kind: "pages", pages: pages.length },
              }),
            ],
            {
              library: pdfLibPackage.name,
              libraryVersion: pdfLibPackage.version,
            },
          );
        });
      },
    },
    {
      description: recipe(
        renderRecipe,
        ["visual"],
        ["image/png"],
        renderParameters,
        30,
      ),
      probe,
      async available() {
        try {
          await import("@napi-rs/canvas");
          return { available: true, missing: [] };
        } catch {
          return { available: false, missing: ["@napi-rs/canvas"] };
        }
      },
      prepare(input, raw, options) {
        const settings = parseValue(renderParameters, raw, "input.invalid");
        return withPdf(input, maxBytes, options, async (pdf, signal) => {
          const { files, pages } = await renderPages(
            pdf,
            bounds(input, pdf.numPages),
            { ...settings, maxBytes, maxPixels },
            signal,
          );
          return prepared(input, renderRecipe, { pages }, files, {
            library: "pdfjs-dist",
            libraryVersion: pdfjsVersion,
            parameters: settings,
          });
        });
      },
    },
  ];
}
