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
const adapters = createPdfAdapters();
const content = createContent({ database: db, cas, adapters });
const pdf = await PDFDocument.create();
for (const n of [1, 2, 3, 4]) pdf.addPage().drawText("Page " + n);
const bytes = await pdf.save();
const prep = createPreparation({
  adapters,
  store: content,
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
    const result = await prep.prepare(
      [{ source }],
      { minMaterials: 1, inputs: [{ mediaType: mime, accepts: [["text"]] }] },
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
  }
} finally {
  await cas.close();
  db.close();
}
