import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Installation,
  runtimeSettings,
  withOfflineInstance,
} from "@themelios/runtime";
import {
  backupStorage,
  Cas,
  collectStorage,
  Database,
  resolveCut,
  restoreStorage,
  verifyStorage,
} from "@themelios/storage";

const root = await mkdtemp(join(tmpdir(), "themelios-receipts-"));
const formatId = "tea-ledger";
const app = {
  id: "tea-ledger",
  formatId,
  settings: runtimeSettings,
  async provision({ paths }: { paths: { state: string } }) {
    Database.init({
      path: join(paths.state, "main.sqlite"),
      formatId,
      schemaSql: `
        CREATE TABLE stock_versions (
          seq INTEGER PRIMARY KEY REFERENCES commits(seq),
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          receipt TEXT NOT NULL REFERENCES blobs(ref)
        ) STRICT;
        CREATE INDEX stock_receipts ON stock_versions(receipt);
      `,
    }).close();
  },
  async open() {
    return {};
  },
};
const installation = Installation.at(root, app);
const ledger = installation.instance("ledger");
const backup = join(root, "backup");
await ledger.init();

await withOfflineInstance(ledger, async ({ id, paths }) => {
  const database = Database.open({
    path: join(paths.state, "main.sqlite"),
    formatId,
  });
  const cas = await Cas.open(paths.objects);
  try {
    database.defineTimeDomain({
      id: "market",
      kind: "linear",
      label: "Market rounds",
      tickSeconds: { numerator: "60", denominator: "1" },
    });
    const receipt = await cas.put(new Blob(["Assam 7"]).stream());
    const firstCut = database.write((tx) => {
      tx.sql.run(
        "INSERT INTO stock_versions VALUES (?, ?, ?)",
        tx.seq,
        7,
        tx.registerBlob(receipt),
      );
      return tx.seq.toString();
    });
    database.write((tx) =>
      tx.sql.run(
        "INSERT INTO stock_versions VALUES (?, ?, ?)",
        tx.seq,
        9,
        receipt.ref,
      ),
    );
    const firstQuantity = database.read(
      (tx) =>
        tx.sql
          .query<{ quantity: bigint }>(
            "SELECT quantity FROM stock_versions WHERE seq <= ? ORDER BY seq DESC LIMIT 1",
          )
          .get(resolveCut(tx, firstCut))?.quantity,
    );
    console.log("Quantity at first commit:", Number(firstQuantity));

    const draft = await cas.put(new TextEncoder().encode("discard draft"));
    database.write((tx) => tx.registerBlob(draft));
    const report = await collectStorage(database, cas);
    console.log("Unowned CAS objects removed:", report.removedBlobs);
    await writeFile(
      join(paths.config, "warehouse.toml"),
      'location = "east"\n',
    );
    const verified = await verifyStorage(database, cas);
    const saved = await backupStorage({
      database,
      cas,
      destination: backup,
      applicationId: app.id,
      instanceId: id,
      formatId,
      instanceRoot: paths.root,
      paths: ["config/warehouse.toml"],
    });
    console.log("Verified and backed-up blobs:", verified.blobs, saved.blobs);
  } finally {
    await cas.close();
    database.close();
  }
});

const destination = join(root, "restored");
await restoreStorage({ backup, destination, applicationId: app.id, formatId });
await withOfflineInstance(
  installation.external(destination),
  async ({ paths }) => {
    const database = Database.open({
      path: join(paths.state, "main.sqlite"),
      formatId,
      readonly: true,
    });
    const cas = await Cas.open(paths.objects);
    try {
      const latest = database.read((tx) =>
        tx.sql
          .query<{ quantity: bigint; receipt: string }>(
            "SELECT quantity, receipt FROM stock_versions ORDER BY seq DESC LIMIT 1",
          )
          .get(),
      );
      if (!latest) throw new Error("The restored ledger is empty.");
      const receipt = await new Response(await cas.read(latest.receipt)).text();
      const config = await readFile(
        join(paths.config, "warehouse.toml"),
        "utf8",
      );
      console.log(
        "Restored quantity, receipt and warehouse:",
        Number(latest.quantity),
        receipt,
        config.trim(),
      );
    } finally {
      await cas.close();
      database.close();
    }
  },
);

console.log("Ledger and backup:", root);
