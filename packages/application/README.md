# @themelios/application

把实例、内容、模型、任务和提示词装配成同一套应用接口。这里用没有模型配置的实例导入并读取一段文本：

```ts
import { applicationSettings, createApplicationModule } from "@themelios/application";
import { Installation } from "@themelios/runtime";

const application = createApplicationModule({
  id: "notes",
  formatId: "notes",
  settings: applicationSettings,
  resourceRoot: ".",
  tasks: [],
});
const instance = Installation.at("./notes", application).instance("default");
await instance.init();
const session = await instance.open();
try {
  const {ref} = await session.api.materials.accept({bytes: new TextEncoder().encode("Tea"), mediaType: "text/plain"});
  console.log(await session.api.materials.text({ref}));
} finally {
  await session.close();
}
```

注册 `tasks` 与启用的媒体适配器后，`session.api.tasks` 可查询、预览和运行任务。`standardOperations()` 提供已装配好的操作，供 CLI、HTTP/SSE 和 MCP 公开。

业务表和成果需要一起提交时，使用 SDK 指南中的[带业务表的实例](../../docs/development/sdk.md#带业务表的实例)。
