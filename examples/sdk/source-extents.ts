import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PDFDocument } from "pdf-lib";
import { createContent } from "@themelios/content";
import { contentSchemaSql } from "@themelios/content/schema";
import { createPreparation } from "@themelios/models";
import { createPdfAdapters } from "@themelios/pdf";
import { Database, Cas } from "@themelios/storage";

const root = await mkdtemp(
  join(process.env.DEMO_TMP_PARENT ?? tmpdir(), "themelios-selection-"),
);
const db = Database.init({
  path: join(root, "main.sqlite"),
  schemaSql: contentSchemaSql,
  formatId: "coverage",
});
const cas = await Cas.open(join(root, "objects"));
const content = createContent({ database: db, cas });
const pdf = await PDFDocument.create();
for (const n of [1, 2, 3, 4]) pdf.addPage().drawText("Page " + n);
const bytes = await pdf.save();
const adapters = createPdfAdapters();
const prep = createPreparation({
  adapters,
  store: {
    inspect: content.materials.inspect,
    read: content.materials.read,
    text: content.materials.text,
    readResult: content.results.read,
  },
});
try {
  const text = await content.materials.accept({
    bytes: new TextEncoder().encode("ABCDEFGHIJKL"),
    mediaType: "text/plain",
  });
  const doc = await content.materials.accept({
    bytes,
    mediaType: "application/pdf",
  });
  for (const [source, mime] of [
    [{ ...text, range: { kind: "text", start: 3, end: 5 } }, "text/plain"],
    [{ ...doc, range: { kind: "pages", start: 2, end: 3 } }, "application/pdf"],
  ] as const) {
    const result = await prep.forModel(
      [source],
      { minMaterials: 1, inputs: [{ mediaType: mime, needs: ["text"] }] },
      {
        operations: ["generate"],
        inputMimeTypes: ["text/plain"],
        needs: ["text"],
        structuredOutput: false,
        streaming: false,
      },
    );
    console.log(
      JSON.stringify({
        type: mime,
        storedExtent: content.materials.inspect(source.ref).extent,
        newDirectory: result.sources.entries,
        delivered: result.parts,
      }),
    );
    if (mime === "application/pdf") {
      const loaded = await adapters[0]!.probe({
        source,
        info: {
          mediaType: mime,
          sizeBytes: bytes.length,
          extent: { kind: "unknown" },
        },
        open: async () => new Blob([new Uint8Array(bytes)]).stream(),
      });
      console.log("PDF probe", loaded);
    }
  }
} finally {
  await cas.close();
  db.close();
}
