import { throwIfAborted } from "@themelios/core";
import type {
  PDFDocumentProxy,
  PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PageBounds } from "./document.js";

type TextItems = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>["items"];
const pageSeparator = "\n\n";
const separatorBytes = Buffer.byteLength(pageSeparator);

function joinItems(items: Readonly<TextItems>): string {
  let text = "";
  for (const item of items) {
    if (!("str" in item)) continue;
    if (item.str && text && !/\s$/.test(text) && !/^\s/.test(item.str))
      text += " ";
    text += item.str;
    if (item.hasEOL) text += "\n";
  }
  return text;
}

export async function extractText(
  pdf: PDFDocumentProxy,
  range: PageBounds,
  signal: AbortSignal,
) {
  const pages: { page: number; start: number; end: number }[] = [];
  const emptyPages: number[] = [];
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let offset = 0;
  for (let number = range.start; number < range.end; number++) {
    throwIfAborted(signal);
    const page = await pdf.getPage(number);
    try {
      const text = joinItems((await page.getTextContent()).items);
      if (number !== range.start) offset += separatorBytes;
      const start = offset;
      offset += encoder.encode(text).byteLength;
      chunks.push(text);
      if (!text.trim()) emptyPages.push(number);
      pages.push({ page: number, start, end: offset });
    } finally {
      page.cleanup();
    }
  }
  return {
    bytes: encoder.encode(chunks.join(pageSeparator)),
    pages,
    emptyPages,
  };
}
