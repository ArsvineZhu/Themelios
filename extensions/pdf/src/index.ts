import {
  appError,
  type Json,
  type MediaInput,
  type PreparedRepresentation,
  type RecipeDescription,
  type RepresentationAdapter,
  type RepresentationCoverage,
  type RepresentationFile,
} from "@themelios/core";
import { z } from "zod";
import {
  bounds,
  parameters,
  pdfjsVersion,
  withPdf,
  type PdfAdapterOptions,
} from "./document.js";
import { copyPages, renderPages } from "./pages.js";
import { extractText } from "./text.js";

export type { PdfAdapterOptions } from "./document.js";

const inputMimeTypes = ["application/pdf"];
const version = "1";
const empty = z.strictObject({});
const renderParameters = z.strictObject({
  maxWidth: z.int().positive().default(1600),
  maxHeight: z.int().positive().default(1600),
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
  maxBytes = 67_108_864,
  maxPixels = 40_000_000,
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
      description: recipe("pdf.text", ["text"], ["text/plain"], empty, 10),
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
        parameters(empty, raw);
        return withPdf(
          input,
          maxBytes,
          options,
          async (pdf, _bytes, signal) => {
            const { bytes, pages, emptyPages } = await extractText(
              pdf,
              bounds(input, pdf.numPages),
              signal,
            );
            enforceBytes(bytes.byteLength);
            return prepared(
              input,
              "pdf.text",
              { pages, emptyPages },
              [
                file("text.txt", bytes, "text/plain", {
                  sourceRange: input.range ?? null,
                  extent: { kind: "text", bytes: bytes.byteLength },
                }),
              ],
              { library: "pdfjs-dist", libraryVersion: pdfjsVersion },
            );
          },
        );
      },
    },
    {
      description: recipe(
        "pdf.pages",
        ["text", "visual"],
        ["application/pdf"],
        empty,
        40,
      ),
      probe,
      available,
      prepare(input, raw, options) {
        parameters(empty, raw);
        return withPdf(input, maxBytes, options, async (pdf, data, signal) => {
          const { bytes, pages } = await copyPages(
            data,
            bounds(input, pdf.numPages),
            signal,
          );
          enforceBytes(bytes.byteLength);
          return prepared(
            input,
            "pdf.pages",
            { pages },
            [
              file("pages.pdf", bytes, "application/pdf", {
                sourceRange: input.range ?? null,
                extent: { kind: "pages", pages: pages.length },
              }),
            ],
            { library: "pdf-lib", libraryVersion: "1.17.1" },
          );
        });
      },
    },
    {
      description: recipe(
        "pdf.render",
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
        const settings = parameters(renderParameters, raw);
        return withPdf(
          input,
          maxBytes,
          options,
          async (pdf, _bytes, signal) => {
            const { files, pages } = await renderPages(
              pdf,
              bounds(input, pdf.numPages),
              { ...settings, maxBytes, maxPixels },
              signal,
            );
            return prepared(input, "pdf.render", { pages }, files, {
              library: "pdfjs-dist",
              libraryVersion: pdfjsVersion,
              parameters: settings,
            });
          },
        );
      },
    },
  ];
}
