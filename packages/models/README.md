# @themelios/models

使用配置连接和模型绑定，独立调用生成、Embedding、重排及转写。根据模型实际能力填写操作、媒体类型、结构化和流式支持。

```ts
import { createModels, textOutput } from "@themelios/models";

const models = createModels({
  connections: { local: { protocol: "openai-compatible", baseURL: "http://localhost:8080/v1" } },
  bindings: { tea: {
    connection: "local", providerModel: "YOUR_MODEL_ID",
    capabilities: { operations: ["generate"], inputMimeTypes: ["text/plain"], needs: ["text"],
      structuredOutput: false, streaming: true },
  } },
});
try {
  const result = await models.generate({model: "tea", output: textOutput,
    messages: [{role: "user", parts: [{kind: "text", text: "Name one tea."}]}]});
  console.log(result.value);
} finally {
  await models.close();
}
```

`createModels(configuration, options?)` 与实例的 `models` 配置使用同一结构。在 `configuration.tasks` 声明任务路由，在 `configuration` 设置默认期限、尝试次数和并发。用 `defineTask` 定义任务，再调用 `models.tasks.preview`、`run`、`stream` 或 `runMany`。`presentTask` 用成果中记录的来源渲染输出。`options` 可注入模板与适配器，`options.preparation.store` 可直接接收 Content，用于读取已存材料和复用表示。

输出模式由 `ModelOutput` 声明。`textOutput` 接收原始文本，`{ kind: "json", schema }` 请求结构化对象。任务材料用 `{ source, role?, representation? }` 提交，本地文件使用 `source: { file }`，内联文本可以用 Core 的 `inlineText(text)` 创建。

`createPreparation({ adapters, store })` 为独立处理材料提供 `preview` 和 `prepare`。前者列出已就绪的内容和待执行的配方，后者完成转换并返回实际交付与来源。
