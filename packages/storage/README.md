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

`backupStorage({ instanceRoot, destination })` 在持有离线锁时备份整个实例，从实例清单读取身份，从数据库的拥有行确定要备份的对象。用 `restoreStorage({ backup, destination, applicationId, formatId })` 验证备份并发布到新目录。`verifyStorage` 和 `collectStorage` 同样在离线实例上运行，分别检查和回收数据库及 CAS 中的对象。

`database.write` 的回调同步执行，可用 `tx.seq` 和 `tx.recordedAt` 写入本次业务变更的切面和时间。回调抛出异常会回滚整个提交。用 `database.read` 在一个快照中查询，用 `resolveCut(tx, at)` 校验查询的历史切面。事务借出的 SQL 句柄与游标在回调结束时失效。
