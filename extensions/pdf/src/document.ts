import { readMediaBytes, type MediaInput } from "@themelios/application/inputs";
import {
  AppError,
  appError,
  openCall,
  type CallOptions,
} from "@themelios/core";
import {
  getDocument,
  version,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { z } from "zod";

const assets = dirname(
  fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")),
).replaceAll("\\", "/");

export { version as pdfjsVersion };

export interface PdfAdapterOptions {
  maxBytes?: number;
  maxPixels?: number;
}

export async function withPdf<T>(
  input: MediaInput,
  maxBytes: number | undefined,
  options: CallOptions | undefined,
  work: (
    pdf: PDFDocumentProxy,
    bytes: Uint8Array,
    signal: AbortSignal,
  ) => Promise<T>,
): Promise<T> {
  const call = openCall("pdf.read", options);
  try {
    if (input.info.mediaType !== "application/pdf") {
      throw appError("content.media_mismatch", {
        details: {
          declared: input.info.mediaType,
          detected: "application/pdf",
        },
      });
    }
    const bytes = await readMediaBytes(
      input,
      { signal: call.signal },
      maxBytes,
    );
    const task = getDocument({
      data: bytes.slice(),
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
    call.signal.addEventListener("abort", abort, { once: true });
    try {
      call.throwIfAborted();
      const pdf = await task.promise;
      const result = await work(pdf, bytes, call.signal);
      call.throwIfAborted();
      return result;
    } finally {
      call.signal.removeEventListener("abort", abort);
      await destroy().catch((error) => {
        if (!call.signal.aborted) throw error;
      });
    }
  } catch (error) {
    call.throwIfAborted();
    if (error instanceof AppError) throw error;
    throw appError("content.decode_failed", {
      cause: error,
      details: {
        mediaType: input.info.mediaType,
        reason: String(error),
        ...("ref" in input.source ? { ref: input.source.ref } : {}),
      },
    });
  } finally {
    call.close();
  }
}

export function bounds(
  input: MediaInput,
  pageCount: number,
): { start: number; end: number } {
  const range = input.range;
  if (!range) return { start: 1, end: pageCount + 1 };
  if (
    range.kind !== "pages" ||
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 1 ||
    range.start >= range.end ||
    range.end > pageCount + 1
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
  return range;
}

export function parameters<T>(schema: z.ZodType<T>, raw: unknown): T {
  const checked = schema.safeParse(raw);
  if (checked.success) return checked.data;
  throw appError("input.invalid", {
    details: {
      issues: checked.error.issues.map((issue) => ({
        path: issue.path.map(String),
        reason: issue.message,
      })),
    },
  });
}
