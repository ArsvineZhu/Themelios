# @themelios/models

使用配置连接和模型绑定，独立调用生成、Embedding、重排及转写。根据模型实际能力填写操作、媒体类型、结构化和流式支持。

```ts
import { createModels } from "@themelios/models";

const models = createModels({
  connections: { local: { protocol: "openai-compatible", baseURL: "http://localhost:8080/v1" } },
  bindings: { tea: {
    connection: "local", providerModel: "YOUR_MODEL_ID",
    capabilities: { operations: ["generate"], inputMimeTypes: ["text/plain"], needs: ["text"],
      structuredOutput: false, streaming: true },
  } },
});
try {
  const result = await models.generate({model: "tea", output: "text",
    messages: [{role: "user", parts: [{kind: "text", text: "Name one tea."}]}]});
  console.log(result.value);
} finally {
  await models.close();
}
```

自定义任务使用 `defineTask` 和 `models.runTask`。`@themelios/models/prompts` 提供 Liquid 模板和来源目录，`@themelios/models/tasks` 提供任务描述和材料准备。需要长时间复用已准备材料时，可由应用组合 Content。
