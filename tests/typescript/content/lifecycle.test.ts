import { expect, test } from "bun:test";
import { lstat, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Completed, type InlineMaterial } from "@themelios/core";
import {
  backupStorage,
  Cas,
  collectStorage,
  Database,
  restoreStorage,
  verifyStorage,
} from "@themelios/storage";
import { createContent, verifyContent } from "@themelios/content";
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
    join(root, "instance.json"),
    JSON.stringify({ id: instanceId, applicationId, formatId }),
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
    const prepared = await materials.prepare({ file: inputPath });
    expect(prepared.info.mediaType).toBe("text/markdown");
    expect(() =>
      database.write((tx) => {
        const source = prepared.adopt(tx);
        tx.sql.run("INSERT INTO imports VALUES (?, ?)", source.ref, 0);
      }),
    ).toThrow();
    expect(database.cut()).toBe("0");
    expect(materials.list()).toEqual([]);

    const source = database.write((tx) => {
      const selection = prepared.adopt(tx);
      tx.sql.run("INSERT INTO imports VALUES (?, ?)", selection.ref, 1);
      return selection;
    });
    await prepared.close();
    const duplicate = await materials.accept({ file: inputPath });
    expect(duplicate.ref).not.toBe(source.ref);
    const agentShort = materials.agentRef(source.ref);
    expect(agentShort).toMatch(/^art_[a-z]{24}$/);
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
    expect(original.files["summary.txt"]!.material).toEqual(
      original.inputs[0]!.delivered[1]!,
    );
    expect(original.files["__proto__"]?.material).toEqual(
      saved.inputs[0]?.delivered[1],
    );
    expect(original.files["summary.txt"]!.sourceIndices).toEqual([0]);
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

    representations.set({
      source: duplicate,
      purpose: "model-input",
      recipe: "test.recipe",
      result: original.ref,
      outputs: ["summary.txt"],
    });
    expect(
      representations.find(duplicate, "model-input", "test.recipe")?.result,
    ).toBe(original.ref);
    materials.release(duplicate.ref);
    await collectStorage(database, cas, { retainSince: database.cut() });
    expect(() => materials.list({ at: previousCut })).toThrow(
      expect.objectContaining({ code: "storage.history_unavailable" }),
    );
    expect(await materials.text(duplicate)).toBe(text);

    const archive = join(directory, "backup");
    const manifest = await backupStorage({
      database,
      cas,
      destination: archive,
      instanceRoot: root,
      applicationId,
      instanceId,
      formatId,
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
    const collection = await collectStorage(database, cas, {
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
