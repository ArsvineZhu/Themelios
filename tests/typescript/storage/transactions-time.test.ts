import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { UTC_TIME_DOMAIN } from "@themelios/core";
import { Cas, Database } from "@themelios/storage";

test("a rollback keeps the previous cut and invalidates escaped SQL handles", async () => {
  const workspace = join("temp", "work");
  await mkdir(workspace, { recursive: true });
  const directory = await mkdtemp(join(workspace, "transactions-"));
  const path = join(directory, "main.sqlite");
  const database = Database.init({
    path,
    formatId: "test.storage",
    schemaSql: "CREATE TABLE ledger (id INTEGER PRIMARY KEY)",
  });
  try {
    let resumed: unknown;
    let complete!: () => void;
    const finished = new Promise<void>((resolve) => {
      complete = resolve;
    });
    expect(() =>
      database.write(async (tx) => {
        const statement = tx.sql.query("INSERT INTO ledger VALUES (?)");
        statement.run(1);
        await Promise.resolve();
        try {
          statement.run(2);
        } catch (error) {
          resumed = error;
        } finally {
          complete();
        }
      }),
    ).toThrow(expect.objectContaining({ code: "storage.async_transaction" }));
    await finished;
    expect(resumed).toMatchObject({ code: "storage.transaction_closed" });
    expect(database.cut()).toBe("0");
    expect(
      database.read((tx) => tx.sql.query("SELECT id FROM ledger").all()),
    ).toEqual([]);
    expect(() => database.read(() => database.cut())).toThrow(
      expect.objectContaining({ code: "storage.transaction_nested" }),
    );

    const iterator = database.write((tx) => {
      tx.sql.query("INSERT INTO ledger VALUES ($id)").run({ id: 3 });
      return tx.sql.query("SELECT id FROM ledger").iterate();
    });
    expect(() => iterator.next()).toThrow(
      expect.objectContaining({ code: "storage.transaction_closed" }),
    );
  } finally {
    database.close();
  }

  const reopened = Database.open({
    path,
    formatId: "test.storage",
    readonly: true,
  });
  try {
    expect(reopened.cut()).toBe("1");
    expect(
      reopened.read((tx) => tx.sql.query("SELECT id FROM ledger").all()),
    ).toEqual([{ id: 3n }]);
    expect(() => reopened.write(() => undefined)).toThrow(
      expect.objectContaining({ code: "runtime.read_only" }),
    );
  } finally {
    reopened.close();
  }
});

test("time domains register idempotently, persist across reopens, and reject conflicts", async () => {
  const workspace = join("temp", "work");
  await mkdir(workspace, { recursive: true });
  const directory = await mkdtemp(join(workspace, "time-domains-"));
  const path = join(directory, "main.sqlite");
  const database = Database.init({
    path,
    formatId: "test.time",
    schemaSql: "",
  });
  try {
    expect(database.listTimeDomains()).toEqual([UTC_TIME_DOMAIN]);
    expect(database.getTimeDomain("utc")).toEqual(UTC_TIME_DOMAIN);

    const story = database.defineTimeDomain({
      id: "story.timeline",
      kind: "linear",
      label: "Story Timeline",
      tickSeconds: { numerator: "1", denominator: "1000" },
    });
    const registeredAt = database.cut();
    expect(database.defineTimeDomain(story)).toEqual(story);
    expect(database.cut()).toBe(registeredAt);
    const opaque = database.defineTimeDomain({
      id: "dream.ordinal",
      kind: "opaque",
      label: "Dream Order",
    });
    expect(database.listTimeDomains()).toEqual([
      UTC_TIME_DOMAIN,
      opaque,
      story,
    ]);
    expect(() =>
      database.defineTimeDomain({
        id: "story.timeline",
        kind: "linear",
        label: "Changed Label",
      }),
    ).toThrow(expect.objectContaining({ code: "time.domain_conflict" }));
    expect(() =>
      database.defineTimeDomain({ id: "utc", kind: "utc", label: "Custom" }),
    ).toThrow(expect.objectContaining({ code: "time.domain_conflict" }));
  } finally {
    database.close();
  }

  const reopened = Database.open({
    path,
    formatId: "test.time",
    readonly: true,
  });
  try {
    expect(reopened.getTimeDomain("story.timeline")).toEqual({
      id: "story.timeline",
      kind: "linear",
      label: "Story Timeline",
      tickSeconds: { numerator: "1", denominator: "1000" },
    });
    expect(reopened.getTimeDomain("dream.ordinal")).toEqual({
      id: "dream.ordinal",
      kind: "opaque",
      label: "Dream Order",
    });
  } finally {
    reopened.close();
  }
});

test("an interrupted CAS stream cleans up unpublished bytes and retains existing objects", async () => {
  const workspace = join("temp", "work");
  await mkdir(workspace, { recursive: true });
  const directory = await mkdtemp(join(workspace, "cas-abort-"));
  const cas = await Cas.open(directory);
  try {
    const bytes = new Uint8Array([0, 91, 122, 0, 255]);
    const [left, right] = await Promise.all([cas.put(bytes), cas.put(bytes)]);
    expect(left).toEqual(right);
    const range = await cas.read(left.ref, { start: 1, end: 4 });
    expect(new Uint8Array(await new Response(range).arrayBuffer())).toEqual(
      bytes.subarray(1, 4),
    );

    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    let cancelled = false;
    const input = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(new Uint8Array([37]));
        },
        pull() {
          start();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const saving = cas.put(input, { signal: controller.signal });
    await started;
    controller.abort();
    await expect(saving).rejects.toMatchObject({ code: "call.cancelled" });
    expect(cancelled).toBe(true);
    expect(await readdir(join(directory, "tmp"))).toEqual([]);
    expect(await cas.stat(left.ref)).toEqual(left);
  } finally {
    await cas.close();
  }
});
