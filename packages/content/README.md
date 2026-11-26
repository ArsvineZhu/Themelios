# @themelios/content

在 SQLite 和 CAS 上保存材料、完成值和来源图。下面的应用把笔记原件和从同一份字节提取的文本一起保存。

```ts
import { createContent } from "@themelios/content";
import { contentSchemaSql } from "@themelios/content/schema";
import { Cas, Database } from "@themelios/storage";

const database = Database.init({
  path: "./notes.sqlite",
  formatId: "notes",
  schemaSql: contentSchemaSql + `
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      source_ref TEXT NOT NULL REFERENCES artifacts(ref),
      text TEXT NOT NULL
    );`,
});
const cas = await Cas.open("./objects");
try {
  const { materials } = createContent({ database, cas });
  const source = await materials.adoptAnalyzed(
    { bytes: new TextEncoder().encode("Tea notes"), mediaType: "text/plain" },
    {
      async analyze(capture) {
        return new Response(await capture.read()).text();
      },
      attach(tx, selection, text) {
        tx.sql.run("INSERT INTO notes VALUES (?, ?, ?)", "today", selection.ref, text);
        return selection;
      },
    },
  );
  console.log(await materials.text(source));
} finally {
  await cas.close();
  database.close();
}
```

`materials.adopt(input, attach)` 和 `results.adopt(completed, attach)` 在同一事务登记内容和业务行，并返回 `attach` 的同步返回值。需要从同一份原件提取业务数据时，用 `materials.adoptAnalyzed(input, { analyze, attach })`。分析读取本次捕获的原件，在写事务前完成。业务外键持有已采用的内容，`attach` 抛出错误会回滚本次事务。独立导入使用 `materials.accept`，独立保存使用 `results.save`，两者的结果都进入 `materials.listRetained()` 可查的保留目录。

`results.read(ref)` 读取成果、附件和来源选择。用 `await representations.set(entry)` 登记已有成果的派生输出，再用 `await representations.read(source, purpose, recipe)` 一次取得可用成果和输出名。`createImageAdapter` 提供图像尺寸探测、裁切和转码。
