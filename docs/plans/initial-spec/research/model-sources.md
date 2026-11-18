# 模型、Prompt 与输入准备的依赖依据

本记录说明会影响本规格的外部行为。访问日期为 2026-11-18。具体依赖 patch 由实施工作区的锁文件固定；实施者在接入时读取该版本随包文档与类型定义。

## AI SDK Core 承担成熟的模型调用机制

| 已查来源 | 对实施的影响 |
|---|---|
| [AI SDK：结构化输出](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data) | 当前 v7 使用 `generateText` / `streamText` 的 `output: Output.object({ schema })`。部分输出用于显示，最后的完整输出承担结构校验。Themelios 完成结果只在完整解析和任务动态校验后形成。 |
| [AI SDK：文本生成](https://ai-sdk.dev/docs/ai-sdk-core/generating-text) | 流受消费背压约束，当前完整事件入口是 `result.stream`。Themelios 对外提供自己的单消费者流合同，上游 API 名称集中在 provider 接入文件。 |
| [AI SDK：停止流](https://ai-sdk.dev/docs/advanced/stopping-streams) | `abortSignal` 可向供应商请求传播取消。适配器把调用取消、迭代器提前退出和会话关闭接到同一信号。 |
| [AI SDK：通用设置](https://ai-sdk.dev/docs/ai-sdk-core/settings) | SDK 自带重试与超时设置。接入时 `maxRetries: 0`，重试预算由 Models 统一持有，避免两层重试相乘。 |
| [AI SDK：OpenAI-compatible provider](https://ai-sdk.dev/providers/openai-compatible-providers) | 支持指定 `baseURL`、凭据、请求头与 `fetch`；结构化能力需要显式声明。采用具名连接和具名模型绑定，直接连接用户选择的服务。 |
| [AI SDK：Embedding](https://ai-sdk.dev/docs/ai-sdk-core/embeddings) | `embedMany` 返回顺序与输入一致，提供批量并发限制；Google 多模态 content 是 provider 的专有映射。Themelios 统一值及空间信息，接入层负责此映射。 |
| [AI SDK：Google provider](https://ai-sdk.dev/providers/ai-sdk-providers/google) | Embedding 的 taskType 与输出维度属于 Google 接入参数。公开 query/document 目的在这一文件映射到对应参数，保持配置空间与实际请求一致。 |
| [AI SDK：重排](https://ai-sdk.dev/docs/ai-sdk-core/reranking) | 成熟 `rerank` 返回输入位置、分数和文档。公开结果保留输入位置，防止调用方再次按内容匹配。 |
| [AI SDK：转写](https://ai-sdk.dev/docs/ai-sdk-core/transcription) | `transcribe` 返回文字及可选时间信息；各 provider 对 segment/word 支持不同。公开转写只呈现实际返回的粒度，并在接入处把秒转换成平台毫秒坐标。 |

## 社区故障决定了少量高价值检查

- [vercel/ai #15430](https://github.com/vercel/ai/issues/15430) 记录流体已取消后结果 Promise 悬空的复现，页面现标为已关闭并关联修复。接入检查覆盖“收到首段后取消”并观察本地调用及时结束；不从旧 issue 推断已锁版本仍有同一缺陷。
- [vercel/ai #22857](https://github.com/vercel/ai/issues/22857) 记录慢 `onChunk` 回调和 chunk timeout 交互。平台使用整体调用期限，诊断回调保持轻量；单独的供应商静默超时只在需要且已验证时启用。
- [AI SDK 流实现](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/stream-text.ts) 和[结果接口](https://github.com/vercel/ai/blob/main/packages/ai/src/generate-text/stream-text-result.ts) 可用于确认安装版本的取消和消费行为。实施时优先检查 `node_modules/ai/src` 中实际版本，避免网站主分支与本地版本混用。

## Schema 和模板采用成熟实现

| 已查来源 | 对实施的影响 |
|---|---|
| [Zod：JSON Schema](https://zod.dev/json-schema) | `z.toJSONSchema()` 生成 JSON Schema；日期、bigint、变换等存在不可表示类型。任务边界使用 JSON 值，输出中时间和精确大整数使用明确字符串；不可表示 schema 在定义加载时报告。 |
| [LiquidJS：选项](https://liquidjs.com/tutorials/options.html) | 引擎支持根目录、partials、严格变量与过滤器等选项。Prompt 资源采用限定目录、固定文件名和编译缓存；任务输入来自普通 JSON 数据。 |
| [LiquidJS：完整选项](https://liquidjs.com/api/interfaces/LiquidOptions.html) | `lenientIf` 允许明确的缺省分支与 `default` 过滤器。配置固定 `strictVariables`、`strictFilters`、`ownPropertyOnly` 和 `lenientIf`，模板作者通过条件处理可选输入。 |

## 媒体表示保留真实转换语义

| 已查来源 | 对实施的影响 |
|---|---|
| [sharp：图片操作](https://sharp.pixelplumbing.com/api-operation/) | 图像方向、裁切与缩放属于确定性处理。公开图像坐标基于应用方向后的像素面，转换顺序由图片适配器统一。 |
| [PDF.js：PDFPageProxy](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html) | 页面对象同时提供文字提取、视口和渲染。提取会处理空白，故提取文字是有页来源的新表示，原 PDF 字节不作为提取文本文字坐标。 |
| [PDF.js：Node 示例](https://github.com/mozilla/pdf.js/blob/master/examples/node/getinfo.mjs) | 官方提供 `pdfjs-dist/legacy/build/pdf.mjs` 的服务端读取路径。PDF 扩展使用内存 bytes，发布时携带该依赖需要的 worker、字体等资源。 |
| [PDF-LIB：PDFDocument](https://pdf-lib.js.org/docs/api/classes/pdfdocument#copypages) | 有选择性复制页面的现成能力。需要向原生 PDF 模型提交页选区时，由扩展创建真正只含这些页的新 PDF。 |
| [FFmpeg：filter 文档](https://ffmpeg.org/ffmpeg-filters.html) | `trim` / `atrim` 与 `setpts` / `asetpts` 分别处理截取和时间原点；抽帧帧时刻仍需保留到原件时间的映射。音视频扩展可使用这些机制，基础安装的必需依赖限于本期已实现的配方。 |

这些来源决定机制选型与接入检查。材料身份、范围、任务语义、模型路线、成果保存和检索文本化的责任由 Themelios 的正式规格确定。
