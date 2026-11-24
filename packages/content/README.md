# @themelios/content

在 SQLite 和 CAS 上保存材料、完成值和来源图。把 `@themelios/content/schema` 的 `contentSchemaSql` 传给 `Database.init`，然后用数据库和 CAS 打开 Content。

```ts
import { createContent } from "@themelios/content";

const content = createContent({database, cas});
const {ref} = await content.materials.accept({file: "notes.md"});
console.log(await content.materials.text({ref}));
await content.materials.export(ref, "notes-original.md");
```

用 `materials.prepare()` 和一次 `prepared.adopt(tx)` 将原件与自有业务行共同提交。`results.save` 保存完整来源图，`results.read` 重读已保存值，`representations` 可登记与复用材料的派生表示。`createImageAdapter` 提供图像尺寸探测、裁切和转码。调用方管理数据库与 CAS 的生命周期。
