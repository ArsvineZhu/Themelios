# @themelios/storage

使用 Bun SQLite 的同步事务、提交切面和时间域注册表，以及支持原件去重、流读取和导出的内容寻址存储。

初始化 `Database` 时把业务表 SQL 作为 `schemaSql` 传入。拥有字节的业务列声明 `blob_ref TEXT NOT NULL REFERENCES blobs(ref)`，然后在一次提交中登记和使用对象：

```ts
import { Cas, Database } from "@themelios/storage";

const db = Database.init({
  path: "./ledger.sqlite", formatId: "ledger",
  schemaSql: "CREATE TABLE receipts(id TEXT PRIMARY KEY, blob_ref TEXT NOT NULL REFERENCES blobs(ref))",
});
const cas = await Cas.open("./objects");
try {
  const receipt = await cas.put(new TextEncoder().encode("Tea 7"));
  db.write(tx => tx.sql.run("INSERT INTO receipts VALUES (?, ?)", "r1", tx.registerBlob(receipt)));
} finally {
  db.close();
  await cas.close();
}
```

`backupStorage`、`restoreStorage`、`verifyStorage` 和 `collectStorage` 在离线实例上运行。备份与回收依据数据库中的对象拥有行。
