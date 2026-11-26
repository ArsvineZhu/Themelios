import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Installation,
  runtimeSettings,
  withOfflineInstance,
  type OpenEnvironment,
  type RuntimeSettings,
} from "@themelios/runtime";
import {
  Cas,
  Database,
  backupStorage,
  databaseFileName,
  restoreStorage,
} from "@themelios/storage";

const parent = await mkdtemp(join(tmpdir(), "themelios-search-"));
const destination = join(parent, "restored");
const backup = join(parent, "backup");
const formatId = "example.notes";
const query = process.argv[2] ?? "assam";
const installation = Installation.at(parent, {
  id: formatId,
  formatId,
  settings: runtimeSettings,
  async provision({ paths, clock }) {
    Database.init({
      path: join(paths.state, databaseFileName),
      formatId,
      now: clock.now,
      schemaSql: `
      CREATE TABLE notes (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        original TEXT NOT NULL REFERENCES blobs(ref)
      ) STRICT;
      CREATE INDEX notes_original ON notes(original);
      CREATE VIRTUAL TABLE notes_search USING fts5(title, text, content='', contentless_delete=1);
      `,
    }).close();
  },
  async open(env: OpenEnvironment<RuntimeSettings>) {
    const database = env.own(
      Database.open({
        path: join(env.paths.state, databaseFileName),
        formatId,
        readonly: env.mode === "read-only",
        now: env.clock.now,
      }),
    );
    const cas = env.own(await Cas.open(env.paths.objects));
    return { database, cas };
  },
});
const source = installation.instance("notes");
await source.init();
const session = await source.open();
try {
  const { database, cas } = session.api;
  const encoder = new TextEncoder();
  const notes = [
    { title: "Black tea", text: "Assam tea comes from northeastern India." },
    { title: "Oolong tea", text: "Tieguanyin is a traditional oolong." },
  ];
  const originals = await Promise.all(
    notes.map(async (note) => ({
      ...note,
      blob: await cas.put(encoder.encode(note.text)),
    })),
  );
  database.write((tx) => {
    const insert = tx.sql.query(
      "INSERT INTO notes(title, original) VALUES (?, ?)",
    );
    const index = tx.sql.query(
      "INSERT INTO notes_search(rowid, title, text) VALUES (?, ?, ?)",
    );
    for (const { title, text, blob } of originals) {
      const row = insert.run(title, tx.registerBlob(blob));
      index.run(row.lastInsertRowid, title, text);
    }
  });
} finally {
  await session.close();
}
await withOfflineInstance(source, ({ paths }) =>
  backupStorage({ instanceRoot: paths.root, destination: backup }),
);
await restoreStorage({
  backup,
  destination,
  applicationId: formatId,
  formatId,
});
const restored = await installation
  .external(destination)
  .open({ mode: "read-only" });
try {
  const { database, cas } = restored.api;
  const rows = database.read((tx) =>
    tx.sql
      .query<{ title: string; original: string }>(
        `
      SELECT notes.title, notes.original
      FROM notes_search(?) JOIN notes ON notes.id = notes_search.rowid
      ORDER BY notes_search.rank
    `,
      )
      .all(query),
  );
  for (const { title, original } of rows)
    console.log(title, await new Response(await cas.read(original)).text());
} finally {
  await restored.close();
}
