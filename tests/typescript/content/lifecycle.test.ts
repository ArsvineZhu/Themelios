import { expect, test } from "bun:test";
import { lstat, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  instanceManifestFile,
  type Completed,
  type InlineMaterial,
} from "@themelios/core";
import {
  backupStorage,
  Cas,
  Database,
  restoreStorage,
  verifyStorage,
} from "@themelios/storage";
import {
  collectContent,
  createContent,
  verifyContent,
} from "@themelios/content";
import { contentSchemaSql } from "@themelios/content/schema";

test("real bytes, upstream results, and business rows share durable storage semantics", async () => {
  const workspace = join("temp", "work");
  await mkdir(workspace, { recursive: true });
  const directory = await mkdtemp(join(workspace, "content-lifecycle-"));
  const root = join(directory, "current");
  const state = join(root, "state");
  const configuration = join(root, "config");
  const formatId = "test.content";
  const applicationId = "test.content";
  const instanceId = crypto.randomUUID();
  await mkdir(state, { recursive: true });
  await mkdir(join(configuration, "prompts", "example"), { recursive: true });
  await writeFile(
    join(root, instanceManifestFile),
    JSON.stringify({
      id: instanceId,
      name: "current",
      applicationId,
      formatId,
      createdAt: new Date().toISOString(),
    }),
  );
  await writeFile(
    join(configuration, "prompts", "example", "user.md.liquid"),
    "{{ source }}",
  );
  const installationConfigPath = join(directory, "installation.toml");
  await writeFile(installationConfigPath, 'locale = "zh-CN"\r\n');
  const database = Database.init({
    path: join(state, "main.sqlite"),
    formatId,
    schemaSql:
      contentSchemaSql +
      `
    CREATE TABLE imports (ref TEXT NOT NULL REFERENCES artifacts(ref), quantity INTEGER NOT NULL CHECK (quantity > 0));
  `,
  });
  const cas = await Cas.open(join(root, "objects"));
  const { materials, results, representations } = createContent({
    database,
    cas,
  });
  try {
    const text =
      "\uFEFF# 中文😀\r\n\r\n组合e\u0301\r\n\r\n```js\r\nlet a = 1\r\n```\r\n";
    const inputPath = join(directory, "原件.md");
    await writeFile(inputPath, text);
    await expect(
      materials.adopt({ file: inputPath }, (tx, source) => {
        tx.sql.run("INSERT INTO imports VALUES (?, ?)", source.ref, 0);
      }),
    ).rejects.toThrow();
    expect(database.cut()).toBe("0");
    expect(materials.listRetained()).toEqual([]);

    const source = await materials.adopt(
      { file: inputPath },
      (tx, selection) => {
        tx.sql.run("INSERT INTO imports VALUES (?, ?)", selection.ref, 1);
        return selection;
      },
    );
    expect(materials.inspect(source.ref).mediaType).toBe("text/markdown");
    const duplicate = await materials.accept({ file: inputPath });
    expect(duplicate.ref).not.toBe(source.ref);
    const agentShort = materials.agentRef(source.ref);
    expect(materials.resolve(agentShort)).toBe(source.ref);
    expect(materials.resolve(source.ref)).toBe(source.ref);
    expect((await verifyStorage(database, cas)).blobs).toBe(1);
    const blocks = await materials.structure(duplicate.ref);
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "code",
    ]);
    expect(
      await Promise.all(blocks.map((block) => materials.text(block.selection))),
    ).toEqual(["# 中文😀", "组合e\u0301", "```js\r\nlet a = 1\r\n```"]);

    const generated: InlineMaterial = {
      bytes: new TextEncoder().encode("中文"),
      mediaType: "text/plain",
    };
    const producer = { kind: "application", name: "content-test" } as const;
    const upstream: Completed = {
      value: { "f/oo~": "description" },
      producer,
      inputs: [
        {
          source: duplicate,
          delivered: [duplicate, generated],
          role: "primary",
        },
      ],
      files: [
        { name: "summary.txt", material: generated, sourceIndices: [0] },
        { name: "__proto__", material: generated, sourceIndices: [0] },
      ],
    };
    const output = { result: upstream, output: "summary.txt" };
    const previousCut = database.cut();
    const saved = await results.save({
      value: ["final"],
      inputs: [
        {
          source: output,
          delivered: [
            { result: upstream },
            { result: upstream, output: "__proto__" },
          ],
          role: "primary",
        },
      ],
      files: [],
      producer,
    });
    const upstreamSource = materials
      .sources(saved.ref)
      .find((link) => link.relation === "representation-source")!;
    const original = await results.read(upstreamSource.selection.ref);
    expect(original.files).toEqual([
      {
        name: "summary.txt",
        material: original.inputs[0]!.delivered[1]!,
        sourceIndices: [0],
      },
      {
        name: "__proto__",
        material: saved.inputs[0]!.delivered[1]!,
        sourceIndices: [0],
      },
    ]);
    expect(
      await materials.text({
        ref: original.ref,
        range: { kind: "json", pointer: "/value/f~1oo~0" },
      }),
    ).toBe("description");
    expect(materials.sources(saved.ref, { depth: 3 })).toContainEqual({
      relation: "input",
      selection: duplicate,
    });
    expect(await results.read(saved.ref)).toEqual(saved);
    await verifyContent(database, cas);

    const wrongSource = {
      source,
      recipe: "test.recipe",
      outputs: ["summary.txt"],
    };
    await expect(
      representations.set({
        ...wrongSource,
        purpose: "model-input",
        result: original.ref,
      }),
    ).rejects.toMatchObject(
      expect.objectContaining({ code: "content.representation_mismatch" }),
    );
    await expect(
      results.save({ ...upstream, representation: wrongSource }),
    ).rejects.toMatchObject({ code: "content.representation_mismatch" });

    await representations.set({
      source: duplicate,
      purpose: "model-input",
      recipe: "test.recipe",
      result: original.ref,
      outputs: ["summary.txt"],
    });
    expect(
      await representations.read(duplicate, "model-input", "test.recipe"),
    ).toEqual({ result: original, outputs: ["summary.txt"] });
    materials.release(duplicate.ref);
    await collectContent(database, cas, { retainSince: database.cut() });
    expect(() => materials.listRetained({ at: previousCut })).toThrow(
      expect.objectContaining({ code: "storage.history_unavailable" }),
    );
    expect(await materials.text(duplicate)).toBe(text);

    const archive = join(directory, "backup");
    const manifest = await backupStorage({
      destination: archive,
      instanceRoot: root,
      installationConfigPath,
    });
    const target = join(directory, "迁移后 的实例");
    const restoredConfig = join(directory, "install", "installation.toml");
    await restoreStorage({
      backup: archive,
      destination: target,
      applicationId,
      formatId,
      installationConfigPath: restoredConfig,
    });
    expect(await readFile(restoredConfig, "utf8")).toBe('locale = "zh-CN"\r\n');
    expect(
      await readFile(
        join(target, "config", "prompts", "example", "user.md.liquid"),
        "utf8",
      ),
    ).toBe("{{ source }}");
    const restoredDatabase = Database.open({
      path: join(target, "state", "main.sqlite"),
      formatId,
      readonly: true,
    });
    const restoredCas = await Cas.open(join(target, "objects"));
    try {
      expect(restoredDatabase.cut()).toBe(manifest.cut);
      const restoredContent = createContent({
        database: restoredDatabase,
        cas: restoredCas,
      });
      expect(await restoredContent.results.read(saved.ref)).toEqual(saved);
      expect(restoredContent.materials.agentRef(source.ref)).toBe(agentShort);
      expect(restoredContent.materials.resolve(agentShort)).toBe(source.ref);
    } finally {
      await restoredCas.close();
      restoredDatabase.close();
    }

    const badTarget = join(directory, "corrupt-restore");
    const { blob_ref: savedBlob } = database.read((tx) =>
      tx.sql
        .query<{ blob_ref: string }>(
          "SELECT blob_ref FROM artifacts WHERE ref = ?",
        )
        .get(saved.ref)!,
    );
    const object = join(
      archive,
      "objects",
      "sha256",
      savedBlob.slice(7, 9),
      savedBlob.slice(9),
    );
    const savedBytes = await readFile(object);
    savedBytes[0] = savedBytes[0]! ^ 0xff;
    await writeFile(object, savedBytes);
    await expect(
      restoreStorage({
        backup: archive,
        destination: badTarget,
        applicationId,
        formatId,
        installationConfigPath: restoredConfig,
      }),
    ).rejects.toMatchObject({
      code: "storage.blob_corrupt",
      details: expect.objectContaining({ blobRef: savedBlob }),
    });
    await expect(lstat(badTarget)).rejects.toMatchObject({ code: "ENOENT" });

    materials.release(saved.ref);
    const collection = await collectContent(database, cas, {
      retainSince: database.cut(),
    });
    expect(collection.removedArtifacts).toBe(4);
    expect(collection.problems).toEqual([]);
    expect(await materials.text(source)).toBe(text);
    expect(() => materials.inspect(duplicate.ref)).toThrow(
      expect.objectContaining({ code: "content.not_found" }),
    );
  } finally {
    await cas.close();
    database.close();
  }
});

test("sharing and draft history retain captured sources until their final owner is removed", async () => {
  const workspace = join("temp", "work");
  await mkdir(workspace, { recursive: true });
  const directory = await mkdtemp(join(workspace, "content-owners-"));
  const database = Database.init({
    path: join(directory, "main.sqlite"),
    formatId: "test.content-owners",
    schemaSql:
      contentSchemaSql +
      `
      CREATE TABLE case_materials (id TEXT PRIMARY KEY, source TEXT REFERENCES artifacts);
      CREATE TABLE "draft""history" ("draft-ref" TEXT NOT NULL REFERENCES ARTIFACTS(REF));
    `,
  });
  const cas = await Cas.open(join(directory, "objects"));
  const { materials, results } = createContent({ database, cas });
  try {
    const original = "SQLite 使用中文索引 and ranking\n";
    const file = join(directory, "notes.txt");
    await writeFile(file, original);
    let openCapture!: () => Promise<ReadableStream<Uint8Array>>;
    const {
      selection: source,
      text,
      cut,
    } = await materials.adoptAnalyzed(
      { file },
      {
        async analyze(capture) {
          openCapture = capture.read;
          await writeFile(file, "A later edit to the local file\n");
          return new Response(await capture.read()).text();
        },
        attach(tx, selection, text) {
          tx.sql.run(
            "INSERT INTO case_materials VALUES ('first', ?), ('second', ?)",
            selection.ref,
            selection.ref,
          );
          return { selection, text, cut: tx.seq.toString() };
        },
      },
    );
    expect(text).toBe(original);
    expect(cut).toBe(database.cut());
    await expect(openCapture()).rejects.toMatchObject({
      code: "call.cancelled",
    });

    const afterOneCase = await collectContent(database, cas, {
      prune: (tx) => {
        tx.sql.run("DELETE FROM case_materials WHERE id = 'first'");
      },
    });
    expect(afterOneCase.removedArtifacts).toBe(0);
    expect(await materials.text(source)).toBe(original);

    const completed = {
      value: "Research draft",
      inputs: [{ source, delivered: [source], role: "primary" as const }],
      files: [],
      producer: { kind: "application" as const, name: "case.report" },
    };
    const beforeDraft = database.cut();
    await expect(
      results.adopt(
        completed,
        // @ts-expect-error Verify rejection when an untyped caller supplies a Promise.
        async (tx, result) => {
          tx.sql.run('INSERT INTO "draft""history" VALUES (?)', result.ref);
        },
      ),
    ).rejects.toMatchObject({ code: "storage.async_transaction" });
    expect(database.cut()).toBe(beforeDraft);
    const draftRef = await results.adopt(completed, (tx, result) => {
      tx.sql.run('INSERT INTO "draft""history" VALUES (?)', result.ref);
      return result.ref;
    });
    const afterBothCases = await collectContent(database, cas, {
      prune: (tx) => {
        tx.sql.run("DELETE FROM case_materials WHERE id = 'second'");
      },
    });
    expect(afterBothCases.removedArtifacts).toBe(0);
    expect((await results.read(draftRef)).inputs[0]?.source).toEqual(source);
    expect(await materials.text(source)).toBe(original);

    const afterHistoryRemoved = await collectContent(database, cas, {
      prune: (tx) => {
        tx.sql.run('DELETE FROM "draft""history"');
      },
    });
    expect(afterHistoryRemoved).toMatchObject({
      removedArtifacts: 2,
      removedBlobs: 2,
      sweepComplete: true,
    });
    await expect(materials.text(source)).rejects.toMatchObject({
      code: "content.not_found",
    });
  } finally {
    await cas.close();
    database.close();
  }
});
