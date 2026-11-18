import { expect, test } from "bun:test";
import type { MediaInput } from "@themelios/application/inputs";
import { createImageAdapter } from "@themelios/application/inputs";
import { createPdfAdapters } from "@themelios/pdf";
import { PDFDocument, rgb } from "pdf-lib";
import sharp from "sharp";

function material(
  bytes: Uint8Array,
  mediaType: string,
  range?: MediaInput["range"],
): MediaInput {
  const source = { bytes, mediaType };
  return {
    source,
    info: {
      mediaType,
      sizeBytes: bytes.byteLength,
      extent: { kind: "unknown" },
    },
    ...(range === undefined ? {} : { range }),
    async open() {
      return new Blob([new Uint8Array(bytes)]).stream();
    },
  };
}

function bytesFrom(
  output: Awaited<ReturnType<ReturnType<typeof createImageAdapter>["prepare"]>>,
  ordinal = 0,
) {
  const file = output.result.files[ordinal]!.material;
  if (!("bytes" in file)) throw new Error("Expected actual prepared bytes");
  return file.bytes;
}

test("JPEG is oriented before selecting pixels and resizing for a PNG representation", async () => {
  const width = 60;
  const height = 30;
  const rgbPixels = Buffer.alloc(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const red = pixel % width < width / 2;
    rgbPixels[pixel * 3] = red ? 255 : 0;
    rgbPixels[pixel * 3 + 2] = red ? 0 : 255;
  }
  const bytes = await sharp(rgbPixels, { raw: { width, height, channels: 3 } })
    .withMetadata({ orientation: 6 })
    .jpeg({ chromaSubsampling: "4:4:4" })
    .toBuffer();
  const input = material(bytes, "image/jpeg", {
    kind: "image",
    x: 0,
    y: 30,
    width: 30,
    height: 30,
  });
  const recipe = createImageAdapter();
  expect(await recipe.probe(input)).toEqual({
    kind: "image",
    width: 30,
    height: 60,
    frames: 1,
  });
  const output = await recipe.prepare(input, { format: "png", maxWidth: 12 });
  expect(output.result.inputs[0]?.source).toBe(input.source);
  expect(output.result.value).toEqual({ width: 12, height: 12, format: "png" });
  const { data, info } = await sharp(bytesFrom(output))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const center = (6 * 12 + 6) * info.channels;
  expect(data[center]).toBeLessThan(40);
  expect(data[center + 2]).toBeGreaterThan(200);
});

test("PDF text, selected PDF bytes, and PNG rendering agree on original page numbers", async () => {
  const document = await PDFDocument.create();
  document.addPage([150, 200]).drawText("First page");
  document
    .addPage([150, 200])
    .drawText("Résumé 2", { x: 12, y: 120, color: rgb(0, 0, 0), size: 16 });
  document.addPage([150, 200]);
  const pdf = await document.save();
  const [text, pages, render] = createPdfAdapters();
  const source = material(pdf, "application/pdf", {
    kind: "pages",
    start: 2,
    end: 4,
  });
  const extracted = await text!.prepare(source, {});
  const extractedBytes = bytesFrom(extracted);
  const decoded = new TextDecoder().decode(extractedBytes);
  expect(decoded).toBe("Résumé 2\n\n");
  expect(extracted.result.value).toEqual({
    pages: [
      { page: 2, start: 0, end: 10 },
      { page: 3, start: 12, end: 12 },
    ],
    emptyPages: [3],
  });

  const selected = await pages!.prepare(source, {});
  expect(selected.result.value).toEqual({ pages: [2, 3] });
  expect((await PDFDocument.load(bytesFrom(selected))).getPageCount()).toBe(2);
  const selectedText = await text!.prepare(
    material(bytesFrom(selected), "application/pdf"),
    {},
  );
  expect(bytesFrom(selectedText)).toEqual(extractedBytes);

  const rendered = await render!.prepare(
    material(pdf, "application/pdf", { kind: "pages", start: 2, end: 3 }),
    { maxWidth: 120 },
  );
  expect(rendered.outputs).toEqual(["page-2.png"]);
  const { width, height, format } = await sharp(bytesFrom(rendered)).metadata();
  expect({ width, height, format }).toEqual({
    width: 120,
    height: 160,
    format: "png",
  });
  const pixels = await sharp(bytesFrom(rendered))
    .removeAlpha()
    .raw()
    .toBuffer();
  expect(pixels.some((value) => value < 128)).toBe(true);
});
