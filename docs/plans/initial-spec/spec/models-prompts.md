# 模型调用与任务 Prompt 形成独立、可维护的能力

本章定义 `@themelios/models` 的模型连接、生成、Embedding、重排、转写、任务定义和 Prompt 编译，以及 `@themelios/application` 的任务执行组合。公共类型在 [contracts/models.ts](../contracts/models.ts)，材料与完成成果在 [contracts/core.ts](../contracts/core.ts)。模型客户端可以由普通 Bun 程序直接创建；Prompt 编译可以离线运行。

## 模块按实际职责提供完整操作

| 实施文件 | 拥有的行为 |
|---|---|
| `packages/models/src/models.ts` | `createModels`、具名绑定解析、模型能力检查、调用并发和关闭 |
| `packages/models/src/generate.ts` | 同一次生成的请求固定、尝试预算、最终输出与用量 |
| `packages/models/src/stream.ts` | 单消费者事件流、背压、终止结果、取消传播 |
| `packages/models/src/providers/*.ts` | AI SDK provider 构造、Schema 及媒体映射、供应商错误和用量映射 |
| `packages/models/src/embedding.ts` | 批量输入次序、空间身份、维度及查询/文档目的 |
| `packages/models/src/ranking.ts` | 重排输入位置、分数和截取数量 |
| `packages/models/src/transcription.ts` | 转写文字、供应商实际时间粒度与毫秒转换 |
| `packages/models/src/tasks/definition.ts` | `defineTask`、任务描述、Schema 导出、示例校验 |
| `packages/models/src/prompts/{compile,resources,reference}.ts` | 模板加载/覆盖/编译、差异、文档生成 |
| `packages/application/src/tasks.ts` | 材料准备、Prompt 编译、模型调用、`Completed` 装配 |
| `packages/application/src/task-catalog.ts` | 内置和应用提供的任务定义、模型配置及入口映射 |

AI SDK Core 7.x 和正式 provider 包负责现成的生成、结构输出、流、Embedding、重排及转写协议。当前官方文档中的接入名称是 `generateText`、`streamText`、`Output.object`、`embedMany`、`rerank` 和 `transcribe`；安装 patch 后按该版本的随包类型和文档写接入文件。[模型资料](../research/model-sources.md)列出选择依据与已查故障。供应商接入集中在 `providers/`，公开接口使用 Themelios 类型。

## 具名连接与具名模型表达实际配置

`models.connections.<name>` 表示一个端点和认证方式；`models.bindings.<name>` 表示该连接中的一个模型及可用能力；`models.tasks.<task-id>` 选择该任务默认使用的绑定和生成参数。调用的 `model` 只覆盖本次绑定选择。

| 字段 | 语义与校验 |
|---|---|
| `connection.protocol` | 本期内置 `openai-compatible`、`openai`、`google`、`cohere`；每种协议由对应正式 AI SDK provider 实现 |
| `connection.baseURL` | 绝对 HTTP(S) 服务根地址，允许用户明确配置的本地服务；由该 provider 约定解释 API 前缀 |
| `connection.credential` | `env:NAME` 或 `file:/absolute/path`；凭据解析使用运行时 Secrets，实例配置的相对文件已按来源目录固定 |
| `connection.headers` | 普通静态请求头；认证头由 `credential` 所选 provider 生成 |
| `binding.connection` | 指向已存在连接；载入配置时检查引用 |
| `binding.providerModel` | 发给供应商的模型标识原值；名称本身不承担能力推断 |
| `capabilities.operations` | 该绑定已配置的 `generate`、`embed`、`rank`、`transcribe` 集合 |
| `capabilities.inputMimeTypes` | 精确 MIME 或 `text/*`、`image/*` 一类后缀通配；与接入器实际支持取交集 |
| `capabilities.needs` | `text`、`visual`、`speech`、`motion`，表示该绑定可以理解的输入方面 |
| `structuredOutput` / `streaming` | 是否支持本次结构输出、流接口；请求前检查 |
| `transcriptionTimestamps` | 转写绑定支持的 segment/word 粒度，缺省为空数组；仅转写请求使用 |
| `limits` | 已知 `maxInputBytes`、`maxImages`、`maxOutputTokens`；省略表示平台未掌握该项限制 |
| `parameters` | `temperature`、`topP`、`maxOutputTokens`、`seed` 与 provider 自有选项；只发送显式配置的采样参数 |
| `embeddingSpace` | Embedding 必填，含 `id`、`dimensions`、`metric`、`normalization` 与 `purposes` |

`createModels({connections, bindings})` 使用自己的轻量 Network 和 Secrets。宿主可注入 `fetch` 与 `resolveCredential`，此时网络资源归宿主管理。Models 构造固定这份配置；运行会话重载创建新的 Models 资源，已开始的调用持有旧资源直到结束。`models.close()` 停止接收新调用、取消本对象在途请求，等待其本地清理，并关闭自己创建的网络资源。

本期 provider 落点如下：OpenAI-compatible 接入 chat 和文本 Embedding；OpenAI 接入原生 Responses/chat、Embedding 与转写；Google 接入其生成和多模态 Embedding；Cohere 接入重排。只有实际配置的绑定构造客户端。新增 provider 在自己的文件内实现这些公开操作的接入，不改变任务、材料或协议入口。

## 一次生成拥有一份请求和一个结束点

`models.generate(request, options)` 返回 `Generated<O>`。它接收已准备的文字和媒体 bytes；材料选择及读取由上层完成。一次请求依次执行：

1. 取得绑定、解析凭据，固定 messages、Schema 和参数；验证当前输入 MIME、结构输出与体积限制。
2. 取得 Models 的并发名额，排队时间计入本次总期限。默认并发为 4，默认总期限为 120000 ms。
3. 构造 provider 请求，传入同一取消信号；AI SDK 的 `maxRetries` 固定为 0。
4. 使用 Models 自己的总尝试次数，默认 `maxAttempts=1`。重试仅处理网络临时错误、HTTP 408、429、502、503、504，以及 provider 明确标记为暂时的服务错误。
5. 成功取得最终输出后执行 Schema 解析。`finishReason` 为长度截断、过滤或非正常终止时，分别返回 `model.output_truncated`、`model.refused` 或 `model.incomplete` 错误，并保留可诊断的供应商结束原因。
6. 返回完成值、实际模型身份、供应商确实提供的用量和 notices；释放并发名额。

重试等待采用 `Retry-After`（秒数或 HTTP 日期）与剩余总期限；没有该头时使用上限 2000 ms 的指数等待，起始 250 ms，并加入小幅随机扰动。到期或取消立即结束等待。认证、配置、输入、Schema 和任务校验错误直接返回。一个调用的全部尝试共享原始总期限，诊断中保留实际尝试次数。

SDK 公开错误使用 [错误与诊断合同](observability-network.md)。供应商错误正文先由接入器提取类型、状态码、request id 和安全摘要；凭据及完整请求体不进入普通错误。输出失败也保留已取得的用量。调用方保存结果失败时，可以再次保存同一个完成值。

一次任务选择一个模型绑定。要改用另一模型，调用方以原始材料显式发起新 `run`，Preparation 根据新能力重新准备表示。临时失败的重试始终使用本次固定的绑定、请求与预算。

## 流以终止结果结束，提前退出会取消请求

`models.stream()` 返回公共 `Flow<Generated<O>>`，`tasks.stream()` 返回 `Flow<Completed<O>>`。流只有一个消费者；第一次 `next()` 才开始准备和发起请求。创建后未消费的流不占模型并发名额。

| 事件或动作 | 精确行为 |
|---|---|
| `progress` | 报告排队、输入准备或模型请求的有限进度；事件字段按公共合同 |
| `text-delta` | 模型已返回的文字片段；结构输出时可用于显示当前 JSON 文本 |
| `result` | 整体成功且最终输出校验完成后发出一次；下一次迭代为 `done` |
| 上游错误事件 | 映射为 `AppError`，该次 `next()` 拒绝；流关闭 |
| `break` / `return()` / `throw()` | 取消上游请求，释放读取器、计时器与并发名额 |
| `cancel(reason)` 或 `options.signal` | 与迭代提前结束共用取消路径；在途 `next()` 及时拒绝 |
| 会话关闭 | 取消会话拥有的流；已经发出的完整 `result` 仍归调用方持有 |

接入器只读取 AI SDK 的一个完整事件流（当前 v7 为 `result.stream`），在这个消费过程中累计最终文本、用量和结束状态。它映射上游 `error` / `abort`，并在 finally 中取消和释放读取器。普通生成和流式生成共用请求构造和结果校验，分别使用合适的上游消费路径。

公开迭代器的 `return/throw` 包装器先同步触发自身 AbortController，再等待内部读取器结束；直接把裸 async generator 的 return 转发入队，会使正在等待网络的 next 持续阻塞，因此不能用它承载公开取消语义。上游读取失败和取消清理均走同一个 finally。

应用停止拉取但没有显式关闭时，整体期限继续运行，到期取消网络请求；同步 `return()` 必须能处理迭代尚未启动的情况。第二个消费者取得 `call.invalid_state`。异步迭代器单次只处理一个 `next()`，多余并发 `next()` 明确拒绝。首个 `text-delta` 发出后，本次流失败即结束；再次生成取得新的流。

结构化输出的片段可处于不完整状态，只有 `result` 中的值进入下游正式处理。任务 `validateOutput` 在该事件前运行。消费者只想最终结果时调用 `generate` / `run`，避免为取得结果额外创建无人消费的流。

## Embedding 返回可直接使用的向量及实际空间

`models.embed({model, inputs, purpose})` 接受按文档顺序排列的 `ModelPart[][]`。每个内层数组是一条语义输入，一条输入产生一个向量。空批次返回空向量且不发送请求。

文本 provider 把一条输入中的文本 part 按换行连接。包含媒体的输入必须使用声明了对应 MIME 的 Embedding 接入器；Google 接入在 provider 层将每条输入映射到 `providerOptions.google.content` 的同位置元素。媒体 bytes 按供应商要求编码，在 Models 外部保持统一二进制类型。

Google 的 query/document 分别映射为 `RETRIEVAL_QUERY` / `RETRIEVAL_DOCUMENT`，维度来自本次 embeddingSpace。OpenAI 文本 Embedding 两种目的使用同一模型编码，purpose 保留为调用语义。providerOptions 中与已绑定空间维度或 purpose 冲突的配置在发出请求前报 `model.invalid_request`。

优先使用成熟 `embedMany` 的分批机制，保持输入顺序。`maxParallelCalls` 固定为 1；一次公开 embed 调用占用一个 Models 并发名额，多个独立调用共享全局并发上限。一次值的语义边界保持完整。超出供应商单值限制时返回 `model.input_too_large`，由调用应用决定分段语义。

返回前检查向量数量、每条实际维度和有限数值。`normalization=l2` 时由本接入层对每条非零向量执行 L2 归一化；零向量返回 `model.output_invalid`。输出 `space` 的 id、维度和归一化方式与该次生成保持一致。改变模型修订、维度、查询/文档编码方法或预处理语义时使用新的空间 id；不同空间的合并由调用应用决定。

## 重排与转写保持输入含义

`models.rank()` 使用现成 `rerank`。`topN` 默认文档总数，范围为 1 至文档总数；空文档输入返回空数组。结果包含原始零基 `index` 和有限分数，按分数降序，同分按原始位置升序。缺失、重复或越界的索引属于 `model.output_invalid`。平台不假定供应商分数落在 0 至 1。

`models.transcribe()` 接受实际音频 bytes 和 MIME，返回文字及供应商提供的 language、duration 和时间段。`timestamps` 默认 `none`；请求的时间粒度不可用时在请求前报能力不足，供应商仅运行后才报告不支持时映射 notice 并由显式要求该粒度的调用失败。接入器把秒转换为毫秒，以四舍五入到最近整数统一到平台坐标；时间段必须满足 `0 <= startMs <= endMs`。供应商返回词级位置时标明 `granularity:'word'`，段级位置标明 `'segment'`；两者保持原有意义。

转写文字通过 application 的明确操作成为 `Completed`，其 `inputs` 记录原件与实际音频片段；低层 Models 本身返回 `Transcript`。图片描述、视频描述和自由文本后结构化使用任务定义调用普通生成能力。

## 任务定义同时规定变量、模型要求和输出消费者

`defineTask` 返回普通不可变定义。任务 id 采用应用内稳定的可读名称，如 `document.summary`。任务自身持有输入 Zod、输出 Zod 或 `"text"`、输入媒体要求、模板资源路径、示例以及必要的动态输出校验。注册时完成：

1. 校验 id 唯一、模板资源存在、输入输出可转换为 JSON Schema。
2. 检查输入变量中没有占用 `sources` 保留名，给声明了默认值的输入字段执行 Zod 的默认行为。
3. 检查所有示例可通过输入、输出与动态来源校验。
4. 导出说明文字所需的字段元数据；缺失的面向人字段说明直接定位到 JSON Pointer。

`TaskRequirements.inputs` 按原始 MIME 描述所需方面；`minMaterials`、`maxMaterials` 约束同次材料数量。任务接纳的 MIME 和模型实际输入 MIME 分别属于任务与路线：PDF 任务可经过扩展取得文字，纯文本模型无需声称原生支持 PDF。

任务变量采用 JSON 数据，机械字段的范围、枚举、默认值和空值含义由 Zod 定义。结构化输出采用对象根，各字段必填；没有值的业务字段使用显式 `null`，集合没有元素使用 `[]`。自由表达的正文使用指定的 `markdown` 字符串字段，其外围的标题、分类和来源键仍然属于结构合同。

输出 Schema 导出使用 `z.toJSONSchema()`。描述文字从 Schema 的 `descriptionKey` 元数据和任务本地化资源解析。provider 的格式适配负责 draft、严格对象和供应商支持的关键字；`preview` 同时呈现任务 Schema 与最终发送的 Schema。供应商不接受的长度或数值限制保留在本地 Zod 校验中，并在任务参考文档标出校验位置。变换、日期对象和任意类实例在该 JSON 输出边界报告定义错误；调用方需要时间时使用有格式约束的字符串。

输入文档采用 `z.toJSONSchema(input,{io:'input'})`，保留原始调用允许省略的字段；执行使用 `input.parse()` 得到默认值已填充的变量。输出文档采用输出方向导出。任务资源的 locales 加载到所属应用的 i18next 命名空间，消息键保持其任务前缀；导出的 Schema 中只保留解析后的 description，移除供程序读取的 descriptionKey 等元数据。

`validateOutput(value, directory, variables)` 返回带字段路径的 `OutputIssue[]`，用于本次来源键、跨字段一致性及输入要求的章节数量等动态规则。它读取已经解析的值、变量与真实 SourceDirectory，成功返回空数组。失败映射为 `model.output_invalid`，保留问题路径与消息键。该函数只处理本次值。定义有动态校验时，`outputRuleKeys` 同时提供对应规则的文档说明。`present(value, directory)` 把完成结构转换成 Markdown 等展示文字；正式引用绑定仍由 application/content 负责。

## 本次来源目录由程序生成

`SourceDirectory.entries` 与本次 `InputUse[]` 一一对应，按调用时材料顺序生成 `S1`、`S2` 等 key。每项包含原始媒体类型、可选名称、角色、原件范围说明和实际交付范围说明。`directory.has(key)` 查询存在性，`link(key)` 返回 `source:S1` 形式的局部引用；未知 key 返回 `input.invalid_source_key`。

模板注入的 `sources` 只含上述目录字段。Preparation 按每个来源生成 `[S1]` 一类短标记，再追加该来源实际交付的 text/media parts。Tasks 把整组材料 parts 追加到 user 模板产生的文字之后，每份实际材料发送一次。模板作者可以编辑任务要求、变量处理和目录组织；材料发送与 InputUse 绑定由程序完成。结果使用 `sourceKeys` 引用本次目录，由程序将其解析为输入位置；数据库身份和字节坐标由内容模块处理。

正文允许引用某个 source key，却不能从自然语言猜出精确字节范围。需要精确引用的应用先给模型程序生成的段落或片段 key，再由应用将选中的 key 绑定到对应 Selection。Themelios 的通用任务例子只需要材料级来源，因此采用材料级 key。

## Prompt 资源与编辑路径完整公开

每个任务资源包含 `system.md.liquid`、`user.md.liquid`、`locales/zh-CN.json`、`locales/en.json` 与示例。`TaskDefinition.templates` 是相对该任务资源根的文件路径。`createPrompts({resourceRoot, overrideRoot?, locale?})` 绑定任务资源根，内置路径为 `<resourceRoot>/<task-id>/`；实例 overrideRoot 为 `config/prompts/`。`read(task)` 返回当前两份实际模板和来源，`describe(task)` 返回实际文件来源及变量说明，`diff(task)` 返回两种角色各自的内置和覆盖文字。

`setOverride(task,{role,template})` 修改一个模板：先用 LiquidJS 解析语法，再写同目录临时文件并原子替换目标，成功后使该模板缓存失效并返回 PromptDescription。`reset(task,role?)` 删除指定角色的覆盖，省略 role 时恢复该任务的两份内置模板，返回实际生效描述。编译取得当前两份模板文本后固定使用；某次编辑成功后开始的新编译读取更新值。

未设置 overrideRoot 的独立 Prompts 对象提供只读资源；修改方法返回 `runtime.read_only`。CLI 的 Agent 路径是 read 导出文本、在文件中修改、edit 从文件提交。直接编辑实例覆盖文件时，下次编译依据文件变化刷新缓存；已有请求的编译文本保持固定。

引擎采用 LiquidJS，固定 `strictVariables:true`、`strictFilters:true`、`ownPropertyOnly:true`、`lenientIf:true`。partials 和布局仅在任务资源根及其覆盖目录解析；包含路径在解析时规范化并检查仍位于这些根中。可选输入用 `if` 或 `default` 明确处理。传给模板的对象来自已解析变量和只读来源目录，格式为 `{...variables, sources:directory.entries}`。

system 模板接收任务定义中的稳定说明和固定示例；user 模板接收本次变量及来源目录元数据。编译器按 SourceEntry 的字段白名单投影目录，材料正文始终由程序追加 parts。编译固定本次两份模板及所有引用的 partial 内容；生成中途编辑文件作用于下次调用。

Prompt 文件本身是受用户控制的提示内容。运行时只提供已公开变量和过滤器，凭据、网络客户端和整个会话对象不进入模板环境。文本换行保存原样，模板缓存以实际文件变更或内容摘要失效；不以 task id 单独缓存覆盖结果。

## 预览展示当前可编译输入和待准备动作

`tasks.preview(task, request)` 解析变量、解析材料元数据、选择绑定、计算表示配方，编译模板并附加已经可用的文字 parts。返回 `Preview` 中的消息角色、文字、媒体类型和大小、来源目录、任务 Schema、发送 Schema及 `pending` 动作。

预览允许读取已保存材料和本次内存 bytes、解析文字及读取文件头。需要 PDF 全文提取、图片转码、模型描述或转写时，记录相应 pending 项；运行时执行同一选择规则，逐项物化。待生成的材料 part 在预览中使用可见标记，`pending` 非空的预览标明该材料尚未准备。已经准备的表示作为材料再次传入时，预览展示最终文字。

`run` 的实际编译结果可按本次诊断策略查看，消息文本与发送附件来自同一准备结果。普通日志记录媒体类型、大小、source keys 和操作位置；完整 Prompt 和响应由明确开启的内容诊断保存。

## 联合处理和独立批次使用两个接口

`tasks.run(task, {variables, materials, model?, parameters?}, options)` 的 `materials` 是同一个联合输入组。`TaskMaterial.role` 省略时为 `primary`，明确的辅助上下文为 `context`。一次 run 返回一个 `Completed<O>`。

执行顺序固定为：

1. 解析变量，取得任务配置和本次模型资源快照，开始总期限。
2. 校验材料组和所需能力，交给 Preparation 取得真实表示、目录与 InputUse。
3. 编译已固定的模板，按来源顺序附上程序生成的标记及全部材料 parts。
4. 调用 Models，在本次剩余期限内取得最终结果。
5. 执行动态输出校验，形成 `Completed`；`producer.kind='model'`、`producer.name=task.id`，details 保留实际 binding、providerModel、返回模型、用量和输出 Schema。
6. 释放本次工作文件与读取器。返回的内存字节及完成值已归调用方持有；正式 Selection 可继续引用已有材料。

`tasks.runMany(task, requests, options)` 的每项是独立变量和材料组。它在同一个总取消信号下使用有界并发，返回与输入等长、同序的 `TaskItemResult[]`。某项模型失败在对应位置返回结构化错误；其余项继续。整体取消停止发起剩余请求，对未完成项记录 `call.cancelled`，保留已完成项；超时用 `call.timeout`。空批次返回 `[]`。这条接口不把一个联合输入私自拆成多个任务。

同一个完成值可直接传给下一个任务：使用 `ResultOutput` 的 `$value` 或指定文件输出，角色通常为 `context`。下游仍可同时接收原始材料。调用方决定何时 `results.save()`；应用运行路径不插入强制保存和读回。

## 任务参考文档从真实定义生成

`bun run docs:tasks` 从应用实际任务目录生成 `docs/tasks/<task-id>.md` 及 input/output JSON Schema。每份文档包含：

- 任务目的、最终值的使用方式，以及何种模型能力和原始媒体适用。
- 每个输入字段的类型、范围、默认值、省略/空值意义和示例。
- `sources` 的来源、每个字段的意义、source key 规则和材料范围。
- 完整输出结构、动态校验条件和由程序绑定的正式事实。
- 内置与覆盖模板位置、可用过滤器、编译预览与实际执行命令。
- 一组能够解析通过的真实示例输入、输出及展示文字。

类型和范围来自 Zod，说明文字来自其字段元数据与任务资源。生成器只导出这些定义；人工补充独立的任务用途与示例时放在同一任务资源目录。文档维护者可以据此编辑 Prompt，无需遍历模型接入代码。

`ApplicationTasks.describe(id)` 的线上结果使用 `TaskDescription`：id、已翻译的 title/purpose、inputSchema、sourcesSchema、带 kind 的输出 Schema、requirements、当前模板来源、示例与 outputRules。SourceDirectory 在线上只序列化 entries，`has/link` 是本地对象的方法。CLI、HTTP、MCP 和 gRPC 从这个描述生成展示与帮助信息。

## 完成条件贯穿独立使用和实际任务

实施者在接通对应操作时验证下列实际行为，命令归入主计划的现有检查入口：

| 实际操作 | 应观察到的结果 |
|---|---|
| 仅安装 Models 包、配置一个真实服务，生成文字和结构对象 | 无实例/SQLite 前置；返回值、实际模型和用量可读 |
| 模板拼错变量后 preview | 在发送网络前定位任务、模板文件和变量；修正后预览可用 |
| 两份材料联合摘要、两组独立摘要 | 联合调用一个完成值；独立批次保序，失败只占自己的位置 |
| 收到首段后主动取消及提前 break | 模型请求取消，调用结束，并发名额可供下次请求使用 |
| 结构输出被截断或 source key 不存在 | 无成功完成值；错误指出结束原因或字段路径 |
| 实际文本 Embedding 与已配置的视觉 Embedding | 输出顺序和维度匹配，媒体进入真实对应 provider 路径 |
| 描述完成后，以该完成值作上下文再次结构化 | 两次模型请求可独立选择配置，第二次失败仍保留第一次完成值 |
| 编辑覆盖模板后再次运行 | 新调用使用新模板，在途调用保持原请求 |

供应商访问需要使用实施环境已有凭据。真实调用的服务和费用依当前执行授权；缺少凭据时完成本地接入与可运行命令，并在交付中准确指出尚未执行的真实服务路径。
