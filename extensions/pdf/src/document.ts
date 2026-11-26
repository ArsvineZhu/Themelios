import {
  appError,
  mediaDecodeError,
  mediaRangeFits,
  openCall,
  rangeSchema,
  readMediaBytes,
  type CallOptions,
  type MediaInput,
  type Range,
} from "@themelios/core";
import {
  getDocument,
  version,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const assets = dirname(
  fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")),
).replaceAll("\\", "/");

export { version as pdfjsVersion };
export const pdfMediaType = "application/pdf";
export type PageBounds = Readonly<
  Pick<Extract<Range, { kind: "pages" }>, "start" | "end">
>;

export interface PdfAdapterOptions {
  maxBytes?: number;
  maxPixels?: number;
}

export async function withPdfBytes<T>(
  input: MediaInput,
  maxBytes: number,
  options: CallOptions | undefined,
  work: (bytes: Uint8Array, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const call = openCall("pdf.read", options);
  try {
    if (input.info.mediaType !== pdfMediaType) {
      throw appError("content.media_mismatch", {
        details: {
          declared: input.info.mediaType,
          detected: pdfMediaType,
        },
      });
    }
    const bytes = await readMediaBytes(
      input,
      { signal: call.signal },
      maxBytes,
    );
    const result = await work(bytes, call.signal);
    call.throwIfAborted();
    return result;
  } catch (error) {
    call.throwIfAborted();
    throw mediaDecodeError(input, error);
  } finally {
    call.close();
  }
}

export function withPdf<T>(
  input: MediaInput,
  maxBytes: number,
  options: CallOptions | undefined,
  work: (pdf: PDFDocumentProxy, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return withPdfBytes(input, maxBytes, options, async (bytes, signal) => {
    signal.throwIfAborted();
    const task = getDocument({
      data: new Uint8Array(bytes),
      stopAtErrors: true,
      enableXfa: false,
      cMapUrl: `${assets}/cmaps/`,
      standardFontDataUrl: `${assets}/standard_fonts/`,
      wasmUrl: `${assets}/wasm/`,
      iccUrl: `${assets}/iccs/`,
      useWorkerFetch: false,
      useSystemFonts: false,
    });
    let cleanup: Promise<void> | undefined;
    const destroy = () => (cleanup ??= task.destroy());
    const abort = () => {
      void destroy().catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const pdf = await task.promise;
      signal.throwIfAborted();
      return await work(pdf, signal);
    } finally {
      signal.removeEventListener("abort", abort);
      await destroy().catch((error) => {
        if (!signal.aborted) throw error;
      });
    }
  });
}

export function bounds(input: MediaInput, pageCount: number): PageBounds {
  const range = input.range;
  if (!range) return { start: 1, end: pageCount + 1 };
  const parsed = rangeSchema.safeParse(range);
  if (
    !parsed.success ||
    parsed.data.kind !== "pages" ||
    !mediaRangeFits(parsed.data, { kind: "pages", pages: pageCount })
  ) {
    throw appError("content.range_invalid", {
      details: {
        range,
        ...("ref" in input.source ? { ref: input.source.ref } : {}),
        reason: "invalid PDF page interval",
        pageCount,
      },
    });
  }
  return parsed.data;
}
