import { appError, throwIfAborted, type ProducedFile } from "@themelios/core";
import { PDFDocument } from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

export async function copyPages(
  bytes: Uint8Array,
  range: { start: number; end: number },
  signal: AbortSignal,
) {
  const document = await PDFDocument.load(bytes);
  const selection = await PDFDocument.create();
  const pages = Array.from(
    { length: range.end - range.start },
    (_entry, index) => range.start + index,
  );
  const copied = await selection.copyPages(
    document,
    pages.map((page) => page - 1),
  );
  for (const page of copied) {
    throwIfAborted(signal);
    selection.addPage(page);
  }
  return { pages, bytes: await selection.save() };
}

export async function renderPages(
  pdf: PDFDocumentProxy,
  range: { start: number; end: number },
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
      details: { mediaType: "application/pdf", required: ["visual"] },
    });
  });
  const files: ProducedFile[] = [];
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
      });
    } finally {
      page.cleanup();
    }
  }
  return { pages, files };
}
