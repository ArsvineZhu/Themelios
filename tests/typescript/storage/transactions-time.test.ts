import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Cas, Database } from "@themelios/storage";
import { createTimeDomains, timeSchemaSql } from "@themelios/storage/time";

test("a rollback keeps the previous cut and invalidates escaped SQL handles", async () => {
  const workspace = join("temp", "work");
  await mkdir(workspace, { recursive: true });
  const directory = await mkdtemp(join(workspace, "transactions-"));
  const path = join(directory, "main.sqlite");
  const database = Database.init({
    path,
    formatId: "test.storage/1",
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
    formatId: "test.storage/1",
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

test("mapping replacement retains historical interpretation and inverse intervals", async () => {
  const workspace = join("temp", "work");
  await mkdir(workspace, { recursive: true });
  const directory = await mkdtemp(join(workspace, "time-domains-"));
  const database = Database.init({
    path: join(directory, "main.sqlite"),
    formatId: "test.time/1",
    schemaSql: timeSchemaSql,
  });
  try {
    const time = createTimeDomains(database);
    const domain = "world.school";
    const utc = (ms: number) =>
      new Date(Date.parse("2026-01-01T00:00:00.000Z") + ms).toISOString();
    time.define({ id: domain, label: "School", ticksPerSecond: 1000 });
    time.setMapping({
      domain,
      from: utc(-1000),
      originUtc: utc(0),
      originTicks: "0",
      rate: { numerator: "4", denominator: "2" },
    });
    const original = database.cut();
    expect(time.toDomain(domain, utc(-1))).toEqual({ domain, ticks: "-2" });
    expect(time.toDomain(domain, utc(1000))).toEqual({ domain, ticks: "2000" });
    expect(time.toUtc({ domain, ticks: "1" })).toEqual([]);

    const paused = time.setMapping({
      domain,
      from: utc(200),
      until: utc(400),
      originUtc: utc(200),
      originTicks: "400",
      rate: { numerator: "0", denominator: "3" },
    });
    expect(time.toDomain(domain, utc(300), { at: original }).ticks).toBe("600");
    expect(time.toDomain(domain, utc(300)).ticks).toBe("400");
    expect(time.toDomain(domain, utc(400)).ticks).toBe("800");
    expect(time.toUtc({ domain, ticks: "400" })).toEqual([
      { start: utc(200), end: utc(400) },
    ]);
    expect(time.mappings(domain, { at: original })).toHaveLength(1);

    time.removeMapping(paused.ref);
    expect(() => time.toDomain(domain, utc(300))).toThrow(
      expect.objectContaining({ code: "time.unmapped" }),
    );
    time.setMapping({
      domain,
      from: utc(200),
      until: utc(400),
      originUtc: utc(300),
      originTicks: "0",
      rate: { numerator: "1", denominator: "3" },
    });
    expect(time.toDomain(domain, utc(299)).ticks).toBe("-1");
    expect(time.toUtc({ domain, ticks: "-1" })).toEqual([
      { start: utc(297), end: utc(300) },
    ]);
  } finally {
    database.close();
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
