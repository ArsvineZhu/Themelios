import { expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createContent, createImageAdapter } from "@themelios/content";
import { contentSchemaSql } from "@themelios/content/schema";
import {
  parseJson,
  type MediaInput,
  type RepresentationAdapter,
} from "@themelios/core";
import { createPreparation, type ModelCapabilities } from "@themelios/models";
import { createPdfAdapters } from "@themelios/pdf";
import { Cas, Database } from "@themelios/storage";
import { PDFDocument, PDFName, PDFPageLeaf, rgb } from "pdf-lib";
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
  const outside = document.addPage([150, 200]);
  outside.drawText("First page");
  const second = document.addPage([150, 200]);
  second.drawText("Résumé 2", { x: 12, y: 120, color: rgb(0, 0, 0), size: 16 });
  second.node.set(
    PDFName.Annots,
    document.context.obj([
      {
        Type: "Annot",
        Subtype: "Link",
        Rect: [12, 100, 30, 140],
        Dest: [outside.ref, "Fit"],
      },
    ]),
  );
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
  const exported = await PDFDocument.load(bytesFrom(selected));
  expect(
    exported.context
      .enumerateIndirectObjects()
      .filter(([, object]) => object instanceof PDFPageLeaf),
  ).toHaveLength(2);
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

test("Preparation reuses stored representations without re-running the adapter", async () => {
  const work = join("temp", "work");
  await mkdir(work, { recursive: true });
  const dir = await mkdtemp(join(work, "prep-reuse-"));
  const database = Database.init({
    path: join(dir, "main.sqlite"),
    formatId: "test.reuse",
    schemaSql: contentSchemaSql,
  });
  const cas = await Cas.open(join(dir, "objects"));
  try {
    const content = createContent({ database, cas });
    const sourceSelection = await content.materials.accept({
      bytes: new TextEncoder().encode("raw binary fixture"),
      mediaType: "application/x-custom",
      name: "item.bin",
    });

    let prepareCalls = 0;
    const excerpt = new TextEncoder().encode("cached extracted text");
    const baseAdapter = createPdfAdapters()[0]!;
    const adapter: RepresentationAdapter = {
      description: {
        ...baseAdapter.description,
        id: "custom.extract",
        inputMimeTypes: ["application/x-custom"],
        outputMimeTypes: ["text/plain"],
        supplies: ["text"],
        priority: 10,
      },
      available: async () => ({ available: true, missing: [] }),
      probe: async () => ({ kind: "unknown" }),
      async prepare(input) {
        prepareCalls += 1;
        return {
          outputs: ["extracted.txt"],
          result: {
            value: parseJson({ prepared: true }),
            inputs: [
              {
                source: input.source,
                delivered: [input.source],
                role: "primary",
              },
            ],
            files: [
              {
                name: "extracted.txt",
                material: {
                  bytes: excerpt,
                  mediaType: "text/plain",
                  name: "extracted.txt",
                },
                sourceIndices: [0],
                coverage: {
                  sourceRange: null,
                  extent: { kind: "text", bytes: excerpt.byteLength },
                },
              },
            ],
            producer: {
              kind: "transform",
              name: "custom.extract",
              version: "1",
            },
          },
        };
      },
    };

    const preparation = createPreparation({
      store: content,
      adapters: [adapter],
    });
    const textOnlyModel: ModelCapabilities = {
      operations: ["generate"],
      inputMimeTypes: ["text/plain"],
      needs: ["text"],
      structuredOutput: false,
      streaming: false,
    };
    const requirements = {
      minMaterials: 1,
      inputs: [
        { mediaType: "application/x-custom", accepts: [["text" as const]] },
      ],
    };

    const first = await preparation.prepare(
      [{ source: sourceSelection }],
      requirements,
      textOnlyModel,
    );
    expect(prepareCalls).toBe(1);
    expect(first.parts[1]).toEqual({
      kind: "text",
      text: "cached extracted text",
    });

    await content.results.save({
      value: parseJson({ stored: true }),
      inputs: first.uses,
      files: [],
      producer: { kind: "application", name: "summary" },
    });

    const second = await preparation.prepare(
      [{ source: sourceSelection }],
      requirements,
      textOnlyModel,
    );
    expect(prepareCalls).toBe(1);
    expect(second.parts[1]).toEqual({
      kind: "text",
      text: "cached extracted text",
    });
    expect(second.sources.entries[0]).toEqual(first.sources.entries[0]);
  } finally {
    await cas.close();
    database.close();
  }
});

test("A selected representation keeps its original source through planning and saving", async () => {
  const work = join("temp", "work");
  await mkdir(work, { recursive: true });
  const dir = await mkdtemp(join(work, "prep-reuse-"));
  const database = Database.init({
    path: join(dir, "main.sqlite"),
    formatId: "test.linked_representation",
    schemaSql: contentSchemaSql,
  });
  const cas = await Cas.open(join(dir, "objects"));
  const adapters = createPdfAdapters();
  const content = createContent({ database, cas, adapters });
  try {
    const document = await PDFDocument.create();
    document.addPage().drawText("First");
    document.addPage().drawText("Second");
    const original = await content.materials.accept({
      bytes: await document.save(),
      mediaType: "application/pdf",
      name: "paper.pdf",
    });
    const replacement = await content.materials.accept({
      bytes: new TextEncoder().encode("Recorded excerpt"),
      mediaType: "text/plain",
      name: "excerpt.txt",
    });
    const sourceRange = { kind: "pages", start: 2, end: 3 } as const;
    const source = { ...original, range: sourceRange };
    const excerpt = await content.results.save({
      value: "Research note",
      inputs: [{ source, delivered: [source], role: "primary" }],
      files: [
        {
          name: "excerpt.txt",
          material: replacement,
          sourceIndices: [0],
          coverage: { sourceRange, extent: { kind: "text", bytes: 16 } },
        },
      ],
      producer: { kind: "application", name: "research.note" },
    });
    const preparation = createPreparation({
      adapters,
      store: content,
    });
    const requirements = {
      minMaterials: 1,
      inputs: [
        { mediaType: "application/pdf", accepts: [["text"], ["visual"]] },
      ],
    } as const;
    const model: ModelCapabilities = {
      operations: ["generate"],
      inputMimeTypes: ["text/plain", "image/png"],
      needs: ["text", "visual"],
      structuredOutput: false,
      streaming: false,
    };
    const imageOptions = {
      preparation: {
        representations: [
          { mediaType: "application/pdf", recipe: "pdf.render" },
        ],
      },
    };
    const imagePlan = await preparation.preview(
      [{ source }],
      requirements,
      model,
      imageOptions,
    );
    expect(imagePlan.pending).toEqual([
      { sourceKey: "S1", action: "pdf.render", requiresModel: false },
    ]);
    expect(
      (
        await preparation.prepare(
          [{ source }],
          requirements,
          model,
          imageOptions,
        )
      ).sources.entries[0]!.delivered[0]!,
    ).toMatchObject({
      mediaType: "image/png",
      sourceRange,
    });

    const representation = { result: excerpt.ref, output: "excerpt.txt" };
    await expect(
      preparation.prepare(
        [
          {
            source: { ...original, range: { kind: "pages", start: 1, end: 2 } },
            representation,
          },
        ],
        requirements,
        model,
      ),
    ).rejects.toMatchObject({ code: "content.representation_mismatch" });

    const materials = [{ source, representation }];
    const linked = await preparation.preview(materials, requirements, model);
    expect(linked.readyParts[1]).toEqual({
      kind: "text",
      text: "Recorded excerpt",
    });
    const delivered = await preparation.prepare(materials, requirements, model);
    const used = delivered.uses[0]!;
    expect(used).toMatchObject({
      key: "S1",
      original: { mediaType: "application/pdf", name: "paper.pdf" },
      source,
      delivered: [representation],
      coverage: {
        originalExtent: { kind: "pages", pages: 2 },
        requestedRange: sourceRange,
        delivered: [
          {
            mediaType: "text/plain",
            sourceRange,
            extent: { kind: "text", bytes: 16 },
          },
        ],
      },
    });
    expect(linked.sources.entries).toEqual(delivered.sources.entries);
    const saved = await content.results.save({
      value: "See S1",
      inputs: delivered.uses,
      files: [],
      producer: { kind: "application", name: "research.review" },
    });
    expect((await content.results.read(saved.ref)).inputs).toEqual([
      { ...used, source, delivered: [replacement] },
    ]);
  } finally {
    await cas.close();
    database.close();
  }
});
