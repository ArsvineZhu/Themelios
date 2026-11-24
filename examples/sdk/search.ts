import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Cas,
  Database,
  backupStorage,
  restoreStorage,
} from "@themelios/storage";

const parent = await mkdtemp(join(tmpdir(), "themelios-search-"));
const instanceRoot = join(parent, "notes");
const destination = join(parent, "restored");
const backup = join(parent, "backup");
const formatId = "example.notes";
const identity = { id: crypto.randomUUID(), applicationId: formatId, formatId };
const databasePath = (root: string) => join(root, "state", "main.sqlite");
const query = process.argv[2] ?? "assam";

await mkdir(join(instanceRoot, "state"), { recursive: true });
await writeFile(join(instanceRoot, "instance.json"), JSON.stringify(identity));
const database = Database.init({
  path: databasePath(instanceRoot),
  formatId,
  schemaSql: `
    CREATE TABLE notes (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      original TEXT NOT NULL REFERENCES blobs(ref)
    ) STRICT;
    CREATE INDEX notes_original ON notes(original);
    CREATE VIRTUAL TABLE notes_search USING fts5(
      title, text, content='', contentless_delete=1
    );
  `,
});
const cas = await Cas.open(join(instanceRoot, "objects"));
try {
  const notes = [
    { title: "Black tea", text: "Assam tea comes from northeastern India." },
    { title: "Oolong tea", text: "Tieguanyin is a traditional oolong." },
  ];
  const originals = await Promise.all(
    notes.map(async (note) => ({
      ...note,
      blob: await cas.put(new TextEncoder().encode(note.text)),
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
  await backupStorage({
    ...identity,
    instanceId: identity.id,
    database,
    cas,
    instanceRoot,
    destination: backup,
  });
} finally {
  await cas.close();
  database.close();
}

await restoreStorage({ backup, destination, ...identity });
const restored = Database.open({
  path: databasePath(destination),
  formatId,
  readonly: true,
});
const objects = await Cas.open(join(destination, "objects"));
try {
  const rows = restored.read((tx) =>
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
  for (const row of rows) {
    const original = await new Response(
      await objects.read(row.original),
    ).text();
    console.log(row.title, original);
  }
} finally {
  await objects.close();
  restored.close();
}
