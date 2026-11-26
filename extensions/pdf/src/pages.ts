import {
  appError,
  throwIfAborted,
  type MediaInput,
  type RepresentationFile,
} from "@themelios/core";
import { PDFDocument, PDFName, PDFPageLeaf } from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { bounds, pdfMediaType, type PageBounds } from "./document.js";

export async function copyPages(
  input: MediaInput,
  bytes: Uint8Array,
  signal: AbortSignal,
) {
  const document = await PDFDocument.load(bytes);
  const range = bounds(input, document.getPageCount());
  const selection = await PDFDocument.create();
  const pages = Array.from(
    { length: range.end - range.start },
    (_entry, index) => range.start + index,
  );
  const partial = pages.length < document.getPageCount();
  if (partial) {
    // Links, attached files and form widgets can retain objects outside the selected pages.
    for (const page of pages)
      document.getPage(page - 1).node.delete(PDFName.Annots);
  }
  const copied = await selection.copyPages(
    document,
    pages.map((page) => page - 1),
  );
  for (const page of copied) {
    throwIfAborted(signal);
    selection.addPage(page);
  }
  if (partial) {
    const embedded = selection.context
      .enumerateIndirectObjects()
      .filter(([, object]) => object instanceof PDFPageLeaf);
    if (embedded.length !== pages.length)
      throw appError("input.capability_missing", {
        details: {
          mediaType: pdfMediaType,
          required: "a PDF text or visual route for linked pages",
        },
      });
  }
  return { pages, bytes: await selection.save() };
}

export async function renderPages(
  pdf: PDFDocumentProxy,
  range: PageBounds,
  maximum: {
    maxWidth: number;
    maxHeight: number;
    maxPixels: number;
    maxBytes: number;
  },
  signal: AbortSignal,
) {
  const canvasLibrary = await import("@napi-rs/canvas").catch((cause) => {
    throw appError("input.capability_missing", {
      cause,
      details: { mediaType: pdfMediaType, required: ["visual"] },
    });
  });
  const files: RepresentationFile[] = [];
  const pages: { page: number; name: string; width: number; height: number }[] =
    [];
  let totalBytes = 0;
  for (let number = range.start; number < range.end; number++) {
    throwIfAborted(signal);
    const page = await pdf.getPage(number);
    try {
      const original = page.getViewport({ scale: 1 });
      const scale = Math.min(
        2,
        maximum.maxWidth / original.width,
        maximum.maxHeight / original.height,
        Math.sqrt(maximum.maxPixels / (original.width * original.height)),
      );
      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.floor(viewport.width));
      const height = Math.max(1, Math.floor(viewport.height));
      const canvas = canvasLibrary.createCanvas(width, height);
      // PDF.js expects the DOM canvas type, and the server canvas implements the drawing surface it uses.
      const render = page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        viewport,
      });
      const abort = () => render.cancel();
      signal.addEventListener("abort", abort, { once: true });
      try {
        throwIfAborted(signal);
        await render.promise;
      } finally {
        signal.removeEventListener("abort", abort);
      }
      const bytes = await canvas.encode("png");
      totalBytes += bytes.byteLength;
      if (totalBytes > maximum.maxBytes)
        throw appError("model.input_too_large", {
          details: {
            actualBytes: totalBytes,
            maxBytes: maximum.maxBytes,
          },
        });
      const name = `page-${number}.png`;
      pages.push({ page: number, name, width, height });
      files.push({
        name,
        sourceIndices: [0],
        material: { bytes, mediaType: "image/png", name },
        coverage: {
          sourceRange: { kind: "pages", start: number, end: number + 1 },
          extent: { kind: "image", width, height, frames: 1 },
        },
      });
    } finally {
      page.cleanup();
    }
  }
  return { pages, files };
}
