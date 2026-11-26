import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applicationSettings,
  createApplicationModule,
  standardOperations,
} from "@themelios/application";
import {
  createContent,
  createImageAdapter,
  verifyContent,
} from "@themelios/content";
import { contentSchemaSql } from "@themelios/content/schema";
import { Database, Cas } from "@themelios/storage";
import { Installation } from "@themelios/runtime";
import {
  createOperationDirectory,
  callOperation,
  defineOperation,
} from "@themelios/runtime/operations";
import { createPdfAdapters } from "@themelios/pdf";
import {
  createPreparation,
  defineTask,
  textOutput,
  z,
} from "@themelios/models";
import {
  probeMediaType,
  representationPurposeSchema,
  type MediaInput,
} from "@themelios/core";
import { createHttpHandler, createMcpEndpoint } from "@themelios/transports";
import { createSecrets } from "@themelios/runtime/secrets";

const dir = await mkdtemp(
  join(process.env.DEMO_TMP_PARENT ?? tmpdir(), "themelios-content-"),
);
const db = Database.init({
  path: join(dir, "main.sqlite"),
  schemaSql:
    contentSchemaSql +
    `
    CREATE TABLE notes (ref TEXT PRIMARY KEY REFERENCES artifacts(ref));
    CREATE TABLE reports (ref TEXT PRIMARY KEY REFERENCES artifacts(ref));
    `,
  formatId: "sample",
});
const cas = await Cas.open(join(dir, "objects"));
const content = createContent({ database: db, cas });
const { materials, results, representations } = content;
const text = (s: string) => new TextEncoder().encode(s);
const note = {
  bytes: text("# Tea\n\n三点见。"),
  name: "notes.md",
  mediaType: "text/markdown",
};
const a = await materials.adopt(note, (tx, selection) => {
  tx.sql.run("INSERT INTO notes VALUES (?)", selection.ref);
  return selection;
});
const b = await materials.accept({
  body: new Blob([new Uint8Array(note.bytes)]).stream(),
  mediaType: note.mediaType,
  origin: {
    kind: "application",
    capturedAt: new Date().toISOString(),
    locator: "tea/18",
  },
});
await writeFile(join(dir, "notes.md"), note.bytes);
await materials.accept({ file: join(dir, "notes.md") });
console.log(
  "distinct identities",
  a.ref !== b.ref,
  materials.resolve(materials.agentRef(a.ref)) === a.ref,
);
console.log(
  materials.inspect(a.ref),
  await materials.structure(a.ref),
  await materials.text({ ...a, range: { kind: "text", start: 7, end: 10 } }),
);
console.log(
  "snapshot",
  materials.listRetained({
    at: materials.inspect(b.ref).createdAtCut,
    limit: 1,
  }),
);
console.log(
  "stream",
  await new Response((await materials.read(a.ref)).body).text(),
);
await materials.export(a.ref, join(dir, "export.md"));
console.log(
  "export",
  Buffer.from(note.bytes).equals(await readFile(join(dir, "export.md"))),
);
materials.release(b.ref);
materials.retain(b.ref);
const json = await materials.accept({
  bytes: text('{"tea":{"price":20}}'),
  mediaType: "application/json",
});
console.log(
  "json pointer",
  await materials.text({
    ...json,
    range: { kind: "json", pointer: "/tea/price" },
  }),
);
const use = { source: a, delivered: [a], role: "primary" as const };
const completed = {
  value: { title: "Tea" },
  producer: { kind: "application" as const, name: "notes" },
  inputs: [use],
  files: [
    {
      name: "text.txt",
      sourceIndices: [0],
      material: { bytes: text("Tea at 3"), mediaType: "text/plain" },
    },
  ],
};
const saved = await results.adopt(completed, (tx, report) => {
  tx.sql.run("INSERT INTO reports VALUES (?)", report.ref);
  return report;
});
console.log(
  "typed",
  (await results.read(saved.ref, { schema: z.object({ title: z.string() }) }))
    .value,
);
const chain = await results.save({
  value: "forwarded",
  producer: completed.producer,
  files: [],
  inputs: [
    {
      role: "context",
      source: { result: saved.ref, output: "text.txt" },
      delivered: [{ result: completed }],
    },
  ],
});
console.log("sources", materials.sources(chain.ref, { depth: 3 }));
for (const purpose of representationPurposeSchema.options) {
  await representations.set({
    source: a,
    purpose,
    recipe: "notes.text",
    result: saved.ref,
    outputs: ["text.txt"],
  });
  console.log(
    "indexed",
    (await representations.read(a, purpose, "notes.text"))?.outputs,
  );
  representations.remove(a, purpose, "notes.text");
}
function miniPdf() {
  const parts = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    ...[5, 6].map(
      (n) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 150 100] /Resources << /Font << /F1 7 0 R >> >> /Contents ${n} 0 R >>`,
    ),
    ...["Page One", "Tea at 3"].map((s) => {
      const ops = `BT /F1 12 Tf 15 45 Td (${s}) Tj ET\n`;
      return `<< /Length ${ops.length} >>\nstream\n${ops}endstream`;
    }),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, obj] of parts.entries()) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const at = pdf.length;
  pdf +=
    `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
      .join("") +
    `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`;
  return text(pdf);
}
function media(bytes: Uint8Array, mediaType: string, range?: any) {
  return {
    source: { bytes, mediaType },
    info: {
      mediaType,
      sizeBytes: bytes.length,
      extent: { kind: "unknown" as const },
    },
    range,
    open: async () => new Blob([new Uint8Array(bytes)]).stream(),
  };
}
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAEklEQVR4nGNkOMEAAUwMDBgsABZYAM4QradeAAAAAElFTkSuQmCC",
  "base64",
);
const bitmap = media(png, "image/png", {
  kind: "image",
  x: 1,
  y: 0,
  width: 2,
  height: 2,
});
const image = createImageAdapter({ maxBytes: 2 ** 20, maxPixels: 1000 });
console.log(
  "signature",
  await probeMediaType(png, "image/png"),
  "orientation",
  await image.requiresNormalization?.(bitmap),
  "probe",
  await image.probe(bitmap),
);
for (const format of ["png", "jpeg", "webp"]) {
  const out = await image.prepare(bitmap, {
    format,
    maxWidth: 1,
    maxHeight: 1,
    quality: 80,
    background: "#ffffff",
  });
  console.log("crop", out.outputs, out.result.value);
}
const pdf = media(miniPdf(), "application/pdf", {
  kind: "pages",
  start: 2,
  end: 3,
});
const pdfAdapters = createPdfAdapters({
  maxBytes: 4 * 2 ** 20,
  maxPixels: 1000000,
});
for (const recipe of pdfAdapters) {
  console.log(
    recipe.description.id,
    await recipe.available(),
    await recipe.probe(pdf),
  );
  const out = await recipe.prepare(
    pdf,
    recipe.description.id === "pdf.render"
      ? { maxWidth: 128, maxHeight: 128 }
      : {},
  );
  console.log("files", out.outputs, out.result.value);
  const f = out.result.files[0]?.material;
  if (f && "bytes" in f && f.mediaType === "text/plain")
    console.log("extracted", new TextDecoder().decode(f.bytes));
}
// A host-owned adapter that converts a small binary record into a words file.
const counter = {
  description: {
    id: "counter.words",
    version: "1",
    inputMimeTypes: ["application/x-counter"],
    outputMimeTypes: ["text/plain"],
    supplies: ["text" as const],
    priority: 1,
    parameters: z.strictObject({}),
    titleKey: "counter.words",
  },
  available: async () => ({ available: true, missing: [] }),
  probe: async () => ({ kind: "unknown" as const }),
  prepare: async (input: MediaInput) => {
    const n = (await new Response(await input.open()).arrayBuffer()).byteLength;
    const bytes = text(String(n));
    return {
      outputs: ["count.txt"],
      result: {
        value: n,
        producer: { kind: "transform" as const, name: "counter.words" },
        inputs: [
          {
            source: input.source,
            delivered: [input.source],
            role: "primary" as const,
          },
        ],
        files: [
          {
            name: "count.txt",
            material: { bytes, mediaType: "text/plain" },
            sourceIndices: [0],
            coverage: {
              sourceRange: null,
              extent: { kind: "text" as const, bytes: bytes.byteLength },
            },
          },
        ],
      },
    };
  },
};
const prep = createPreparation({ adapters: [counter] });
const requirements = {
  inputs: [
    { mediaType: "application/x-counter", accepts: [["text" as const]] },
  ],
  minMaterials: 1,
};
const caps = {
  operations: ["generate" as const],
  inputMimeTypes: ["text/plain"],
  needs: ["text" as const],
  structuredOutput: false,
  streaming: false,
};
const specimen = [
  { source: { bytes: new Uint8Array(3), mediaType: "application/x-counter" } },
];
const counterPlan = await prep.preview(specimen, requirements, caps);
console.log("plan", counterPlan.pending);
console.log(
  "delivered",
  (await prep.prepare(specimen, requirements, caps)).parts,
);
await verifyContent(db, cas);
db.close();
await cas.close();

const task = defineTask({
  id: "notes.echo",
  title: "Echo",
  purpose: "Repeat a note",
  requirements: {
    inputs: [{ mediaType: "text/plain", accepts: [["text"]] }],
    minMaterials: 1,
  },
  input: z.object({}),
  output: textOutput,
  templates: { inline: true, user: "Repeat the note" },
});
const app = createApplicationModule({
  settings: applicationSettings,
  id: "notes",
  formatId: "notes",
  resourceRoot: dir,
  tasks: [task],
  adapters: () => [counter, ...pdfAdapters],
});
const instance = Installation.at(join(dir, "app"), app).instance("default");
await instance.init();
const session = await instance.open();
const echo = defineOperation<typeof session.api>()({
  id: "notes.echo",
  permission: "read",
  description: "Uppercase a note",
  input: z.object({ s: z.string() }),
  output: z.string(),
  execute: (_app, { s }) => s.toUpperCase(),
});
const ops = [...standardOperations(), echo];
const ctx = {
  principal: { id: "reader", permissions: ["read" as const] },
  locale: "en",
  options: {},
};
const echoed = callOperation(
  session.api,
  createOperationDirectory(ops),
  echo.id,
  { s: "tea" },
  ctx,
);
if (echoed.kind === "unary") console.log("dispatch", await echoed.result);
const options = {
  operations: ops,
  allowOperations: [echo.id],
  policy: () => ({
    maxJsonBytes: 65536,
    allowedHosts: ["localhost"],
    allowedOrigins: [],
    authTokens: {},
  }),
  secrets: createSecrets({ baseDir: dir }),
  authenticate: async () => ctx.principal,
};
const http = createHttpHandler(session.api, options);
const response = await http.fetch(
  new Request(`http://localhost/operations/${echo.id}`, {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json" },
    body: '{"s":"tea"}',
  }),
);
console.log("custom HTTP", response.status, await response.text());
await http.close();
const mcp = createMcpEndpoint(session.api, options);
console.log(
  "custom MCP",
  (
    await mcp.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          host: "localhost",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      }),
    )
  ).status,
);
await mcp.close();
console.log("registered", session.api.tasks.list());
await session.close();
