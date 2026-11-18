# 同一应用操作服务 SDK 与各协议

Application 绑定一个已打开的 Session，组合 Materials、Results、Tasks 和 Configuration。一次用户操作的校验、权限、模型请求与保存顺序在 Application 结束；CLI、HTTP、MCP 和 gRPC 只完成输入取得、认证、编码、流控制和结果交付。

本章的公共类型与操作目录由 [application.ts](../contracts/application.ts) 定义。Task 的具体 variables/output 由 [模型与 Prompt](models-prompts.md) 中的任务定义提供；材料与成果值使用 [core.ts](../contracts/core.ts)。

适配器的公开签名见 [transports.ts](../contracts/transports.ts)：`runCli` 绑定 Installation 和当前 Principal；HTTP/MCP handler 与 gRPC server 绑定 ApplicationApi。`createHttpHandler`、`createMcpEndpoint` 提供标准 fetch/close；`serveMcpStdio` 与 `startGrpcServer` 返回拥有实际协议资源的 close 句柄。RemoteTransportOptions.policy 每请求读取一次策略快照，宿主可用 Configuration.snapshot 的相关字段构造它；认证可使用内置 bearer 或宿主注入的 Authenticate。CLI 与 stdio 的可选 limits getter 同样每次调用读取；省略时使用 8 MiB 默认值。

## 应用绑定完整能力并持有操作目录

`packages/application/src/operations/` 按实际能力放置 materials、results、tasks、prompts、configuration 和 instance 操作。每项操作只有一份 input/output Zod Schema、一份说明、一项访问类别和一个执行函数。它的依赖在应用组合根绑定，调用只携带本次输入、Principal 与 CallOptions。

SDK 直接调用已绑定的对象方法，沿用宿主进程已有授权；owner 始终执行值域、只读模式与事务规则。外部请求经操作输入 Schema 和 Principal 权限检查后调用同一 owner。CLI 与各远程入口使用同一权限函数和错误目录；嵌入宿主接收不受信任请求时也调用该操作边界。

操作 Schema 是正式机器合同。JSON 文档、CLI 的 `--input` 说明、MCP inputSchema/outputSchema 从它生成；Protobuf 用固定字段表示相同信封，经小型显式 codec 转换。动态任务变量和输出保留任务自己的 Zod 校验。

任务被登记到应用时，同时登记其定义、模板和文档来源。增加普通模型任务只改任务定义/Prompt/资源；所有协议自动发现同一 task id，执行仍走 Tasks。

共同操作目录固定以下机械形状。下表是 wire 边界的输入/输出；SDK 方法仍使用对应的 native 类型。`{}` 是空对象，`null` 表示成功但没有正文值；HTTP 对后者返回 204。

| operation id | 输入 | 输出 | 权限 |
| --- | --- | --- | --- |
| instance.info | `{}` | InstanceInfo | read |
| materials.accept | `WireInlineMaterial & {origin?:Origin}`；二进制入口改传流 | Selection | write |
| materials.inspect | `{ref}` | ArtifactInfo | read |
| materials.read | `{ref}` | 二进制 body 与 ArtifactInfo | read |
| materials.text | Selection | `{text:string}` | read |
| materials.structure | `{ref}` | TextBlock[] | read |
| materials.sources | `{ref,depth?}` | SourceLink[] | read |
| materials.list | `{at?,after?,limit?}` | ArtifactInfo[] | read |
| materials.retain / release | `{ref}` | null | write |
| results.save | WireCompleted | SavedResult | write |
| results.read | `{ref}` | SavedResult | read |
| tasks.list | `{}` | `{id,title,purpose}[]` | read |
| tasks.describe | `{task}` | TaskDescription | read |
| tasks.preview | `Omit<WireRunTaskInput,'persist'>` | WirePreview | read |
| tasks.run / stream | WireRunTaskInput | WireTaskResult / Flow<WireTaskResult> | write |
| tasks.runMany | `{inputs:WireRunTaskInput[]}` | `{ok:true,result}\|{ok:false,error}` 数组 | write |
| prompts.read / describe / diff | `{task}` | PromptTemplates / PromptDescription / PromptDiff[] | read |
| prompts.setOverride | `{task,role,template}` | PromptDescription | admin |
| prompts.reset | `{task,role?}` | PromptDescription | admin |
| configuration.describe | `{path?}` | SettingDescription[] | read |
| configuration.explain | `{path}` | SettingExplanation | read |
| configuration.set | `{path,value}` | ConfigurationChange | admin |
| configuration.unset | `{path}` | ConfigurationChange | admin |
| configuration.reload | `{}` | ConfigurationChange | admin |

wire.ts 的编码函数由这些 operation 绑定时使用，随后调用 `api.tasks.run`、`api.results.save` 等唯一方法。materials.read/upload 是二进制特例，复用同一权限和 owner，不经过 JSON 编码。retain/release 表达当前实例中的明确保存根操作；物理清理仅由维护命令执行。

## 协议入口的资源寿命由会话收束

所有服务入口在 Application 成功打开后才开始监听。它们持有同一个 Session；MCP 为每请求创建的 server 对象引用这个 Application，避免每个协议请求重新打开数据库和日志出口。

关闭顺序为停止接纳请求、取消/等待本次活动调用、关闭协议连接、关闭应用 Session。SDK 的 handler 工厂和适配器 close 只关闭自己拥有的 listener/连接；由宿主注入的 Session 仍由宿主关闭。

每个网络请求产生独立 AbortSignal，合并客户端断开、显式取消、deadline 和 Session 关闭。调用开始就固定有效配置与身份。配置重载影响后续请求，进行中的操作用原快照完成。

## 身份在入口建立，权限由操作检查

本地 CLI 和 MCP stdio 的 Principal 由打开它们的应用宿主绑定。进程内 SDK 的调用者直接持有应用对象。远程 HTTP/gRPC 使用 bearer token；配置位于 `transports.authTokens`：

```toml
[transports.authTokens.reader]
secret = "env:THEMELIOS_READER_TOKEN"
permissions = ["read"]

[transports.authTokens.operator]
secret = "file:../secrets/operator-token.txt"
permissions = ["read", "write", "admin"]
```

SecretRef 的文件基准和轮换语义按 [配置](configuration.md)。token id 只用于诊断与 Principal 的稳定名称；令牌只在请求认证时解析、比对，日志与返回值保留引用而非 secret。远程嵌入宿主可提供自己的 authenticate 函数，产生同形 Principal。

`read` 允许已有数据读取与无副作用描述；`write` 允许材料/成果创建与付费模型执行；`admin` 允许改配置和维护。权限数组是明确集合，应用构造管理者时显式给出三项。任务 Prompt 和输入材料都保持数据身份。

Listener 默认关闭，显式开启时默认绑定 127.0.0.1。HTTP/gRPC 入口启用认证；Host/Origin 按 `transports.http.allowedHosts`、`allowedOrigins` 检查，缺 Origin 的非浏览器请求正常使用 bearer。默认允许 localhost/127.0.0.1/::1 主机，跨站 Origin 需显式配置。MCP HTTP 挂在同一 HTTP 服务的 `/mcp`，复用这些入口设置。[MCP web-standard serving](https://ts.sdk.modelcontextprotocol.io/v2/serving/web-standard)

## 运行流只有进度、正文增量和最终结果

SDK 的 `Flow<T>` 惰性开始、单消费者，迭代的事件为 `progress`、`text-delta` 和 `result`。成功出现一个 result 后结束；失败抛 AppError；调用方提前 break 会关闭迭代器并取消工作。所有适配器使用 `for await` 并在连接关闭时调用 return/cancel，最终等待已开始的资源清理。

进度可以合并为最新一项；正文增量保持顺序并受下游背压约束。最终结果总是完整的规范值，调用方无需从 delta 重建业务输出。模型在产生部分正文后失败，返回相同失败语义；已经传出的文本供界面显示，不生成完成成果。

每个 HTTP SSE 事件格式为 `event: <type>` 与一行 JSON `data`。`text-delta` 的 JSON 使用 `{ "text": "..." }`，progress 使用 Progress，result 使用该操作的正式输出。开始发送 SSE 后的失败使用 `event: error`，data 为 ErrorInfo，随后关闭。开始响应前的失败正常映射 HTTP 状态。客户端通过 POST 流读取器消费，协议不提供重连重放；重复请求是新的操作。

gRPC 使用 server-streaming response 和相同事件 oneof；失败由 gRPC status/trailers 结束。MCP 工具调用使用单次最终结果，SDK 的进度通知只呈现 Progress，取消请求传入共同调用。CLI `--stream --json` 输出每行一个 FlowEvent；普通 `--json` 输出一个完整 JSON 值。

## CLI 为人和 Agent 提供确定的输出

采用 Commander。全局参数为 `--installation <path>`、`--instance <name>`、`--json`、`--debug`、`--locale <id>`、`--timeout-ms <n>`。实例默认 default，安装路径来自启动器或明确参数。没有交互式选择时，命令立即执行或返回明确缺参信息。

对象命令按完整操作分组：`instance init/info`，`material import/inspect/read/text/structure/sources/list/retain/release/export`，`result save/read`，`task list/describe/preview/run/run-many`，`prompt read/describe/diff/edit/reset`，`config describe/explain/set/unset/reload`，`storage`，`serve`、`mcp`。实际参数与共同操作目录一致。

离线维护命令固定为 `themelios storage backup <destination>`、`themelios storage restore <backup>`、`themelios storage collect [--retain-since CUT]`、`themelios storage verify` 与 `themelios storage migrate`。它们取得 Runtime 的同一实例锁，由 Storage 的维护入口执行；正常服务占用实例时返回占用错误。备份、恢复与迁移的目标规则见 [存储规范](storage.md)。

复杂请求使用 `--input <json-file|->`。`-` 表示 stdin；显式 JSON 开关使用共同 wire 编码。简单材料导入另提供互斥的 `--file <path>`、`--text <text>`、`--stdin`，以及可选 MIME/name。CLI 将这些便捷输入转换成同一请求后校验。`task run --save` 将请求中的 persist 设为 true；默认值为 false。

Prompt 的 Agent 工作流为 `prompt read <task> --part user` 输出模板，调用者编辑文件后执行 `prompt edit <task> --part user --file edited.liquid`，内部调用 prompts.setOverride。`prompt diff <task>` 显示内置与覆盖，`prompt reset <task> [--part system|user]` 恢复所选模板。Task 身份由 ApplicationPrompts 解析，CLI 只接收 task id；语法错误直接指出模板文件与位置。

stdout 只输出用户结果、JSON 或 NDJSON；日志、进度和诊断走 stderr。非 TTY 与 `--json` 模式关闭颜色、动画与成功堆栈。`--debug` 在 stderr 展开原因链与 traceId，机器 JSON 错误仍用公开 ErrorInfo。

`--output <path>` 的目标必须不存在。CLI 在开始付费模型调用前检查目标；实际交付先完整写入同目录临时文件，再以原子且排他的步骤发布，发布时已存在目标同样失败。提交成功但最终文件交付失败时，返回具体路径与已保存 result ref；客户端可以将该 ref 导出到新路径。文件交付失败不会重新执行模型。

CLI 直接打开指定实例，命令结束后关闭自己的会话。实例被占用时返回 `runtime.instance_busy`，展示已知 owner 信息和配置中已开启的协议端点。需要操作正在运行的同一实例时，客户端显式连接该实例已开启的 HTTP、MCP 或 gRPC 入口；在线配置更新使用现有 configuration 操作。需要本地 CLI 或离线维护时，先结束占用该实例的会话。

## 线上值保留完整成果语义

WireMaterial 包含三种来源：Selection、带 MIME 的 base64 内联字节、`{result,output?}`。result 为未保存的 WireCompleted 或已保存的 `{ref}`。前者递归保留真实完成值和来源，后者由接收端 Results.read 解析。这样转写完成值、一次描述和后续结构化都能直接相接。精确定义见 [wire.ts](../contracts/wire.ts)。

`tasks.run` 和 `tasks.stream` 的输入带 `persist?: boolean`，默认 false。false 返回 WireCompleted，保留 value、inputs、files、producer 与可选 mappings；其中 bytes 统一为 base64。true 在 Tasks 成功后调用 Results.save，返回 SavedResult；其中输入采用 Selection，files 是名称到 `SavedFile {material:Selection,sourceIndices:number[]}` 的映射。sourceIndices 保留该文件对应本结果 inputs 的零基下标，保存与各协议编码都保持这些关系。保存失败直接返回原保存错误，调用方从错误看到失败位置，程序不会再次请求模型。

`transports.maxJsonBytes` 默认 `8388608`，约束整个请求/结果的 UTF-8 JSON 编码长度，包含 base64、键名和正文。入口先检查实际请求体长度；准备完成后，若 persist=false，再计算已确定输入/文件/producer 的回传体积，给生成结果留下剩余预算。生成过程中限制累积输出，最终编码再次检查实际值。超出预算返回 `transport.result_too_large`，说明使用 Selection 并启用 persist。程序只根据已知大小预检，真实生成输出仍可能触发这个错误。

大文件的常规路径是显式材料上传 → Selection → `tasks.run({persist:true})` → SavedResult → 按需下载具名文件。小型文字调用可以直接内联并取得完整结果。协议边界不建立临时成果 token、附件后台或持久请求队列。

JSON 中省略字段保持省略；null 只用于 Schema 明确允许的值；Uint8Array 使用 base64；CommitPoint 等整数身份继续使用十进制字符串。日期为 core 规定的 UTC 文本。反序列化后由共同 Schema 检查有限数值、范围与必填字段。ResultOutput 的 `$value` 保存为该结果 ref 的 JSON Pointer `/value` Selection；具名文件从 `saved.files[name].material` 取得选区，文件的 sourceIndices 仍保留在 SavedResult 中。普通 JSON 选区使用 core 的 `range.kind='json'` 与 RFC 6901 pointer。

## HTTP 提供 JSON 操作和独立二进制通道

采用 Hono，挂载于 Bun.serve。JSON 路由的 input/output 使用共同操作目录。所有响应标明实际 Content-Type，JSON 成功体直接是操作结果；错误体为 `{ "error": ErrorInfo }`，不会把失败放在 HTTP 200 的 success 标志中。

| HTTP 路由 | 应用操作 | 返回 |
| --- | --- | --- |
| `GET /v1/instance` | instance.info | 实例公开信息 |
| `POST /v1/materials` | materials.accept | Selection，201；请求体为原始 bytes |
| `POST /v1/materials/accept` | materials.accept | Selection，201；JSON 内联材料 |
| `GET /v1/materials/:ref` | materials.inspect | ArtifactInfo |
| `GET /v1/materials/:ref/content` | materials.read | 完整原件 byte stream |
| `POST /v1/materials/text` | materials.text | `{text}`，输入为 Selection |
| `GET /v1/materials/:ref/structure` | materials.structure | TextBlock 数组 |
| `GET /v1/materials/:ref/sources` | materials.sources | SourceLink 数组；depth 为明确查询参数 |
| `GET /v1/materials` | materials.list | 按 after/limit/at 读取的 ArtifactInfo 数组 |
| `POST /v1/materials/:ref/retain` | materials.retain | 将正式材料保留为根；204 |
| `POST /v1/materials/:ref/release` | materials.release | 释放该根；有其他正式引用时仍可达；204 |
| `GET /v1/results/:ref` | results.read | SavedResult |
| `POST /v1/results` | results.save | 接纳调用者提供的 WireCompleted，返回 SavedResult，201 |
| `GET /v1/tasks` | tasks.list | Task 描述列表 |
| `GET /v1/tasks/:id` | tasks.describe | 任务定义、输入输出 Schema 与模板来源 |
| `POST /v1/tasks/:id/preview` | tasks.preview | 编译预览与待执行转换 |
| `POST /v1/tasks/:id/run` | tasks.run | WireCompleted 或 SavedResult |
| `POST /v1/tasks/:id/stream` | tasks.stream | SSE |
| `POST /v1/tasks/run-many` | tasks.runMany | body 为 `{inputs:WireRunTaskInput[]}`，逐项可以选择不同 task；保持输入顺序 |
| `GET /v1/tasks/:id/prompts` | prompts.read | system/user 模板与实际文件来源 |
| `GET /v1/tasks/:id/prompts/describe` | prompts.describe | 模板变量/输出 Schema 与能力要求 |
| `GET /v1/tasks/:id/prompts/diff` | prompts.diff | 内置与覆盖文本 |
| `POST /v1/tasks/:id/prompts/override` | prompts.setOverride | `{role,template}`，返回 PromptDescription |
| `POST /v1/tasks/:id/prompts/reset` | prompts.reset | 可选 role，返回 PromptDescription |
| `GET /v1/configuration` | configuration.describe | 设置字段说明 |
| `POST /v1/configuration/explain` | configuration.explain | 指定 path 的来源/有效值/待生效状态 |
| `POST /v1/configuration/set` | configuration.set | ConfigurationChange |
| `POST /v1/configuration/unset` | configuration.unset | ConfigurationChange |
| `POST /v1/configuration/reload` | configuration.reload | ConfigurationChange |

路径 ref/id 由路由层解码一次，随后进入共同 Schema。任务路由把 `:id` 绑定为任务身份，body 只放该次请求字段。HTTP headers 中 `X-Themelios-Timeout-Ms` 可缩短服务端默认总预算；负数、非有限数或重复冲突值返回 invalid_request。`Accept-Language` 只影响用户可读文本，机器 code 和业务值不变。

原始上传的 Content-Type 是材料 MIME，`name` 是 URL 编码查询参数；body 直接传入 Materials.accept 的 ReadableStream。长度上限使用 `content.maxImportBytes`，超限或断开立刻停止读取、删除本次临时字节，正式返回只发生在接纳提交后。JSON 内联材料同时受 `content.maxInlineBytes` 和 maxJsonBytes 限制。客户端本机路径在客户端打开，线上只发送实际内容。

原件下载直接使用 Materials.read 的 body，结束或取消都关闭原 reader。Content-Length 只在确知长度时发送；Content-Disposition 的展示文件名取材料 name 并由标准编码处理。SDK/CLI 的 `materials.export(ref,destination)` 将完整原件写入同卷临时文件，再原子、排他地发布到必须不存在的目标；目标已存在返回 `storage.already_exists`。远程客户端从 content 路由流式写文件，CLI 下载遵循同一文件交付规则。文本选区使用 materials.text；图像、PDF 与时段的裁切由输入准备生成确定性表示，保存该输出后即可按 ref 下载。

HTTP 操作使用明确 CORS 允许来源和方法；bearer 随请求头发送。默认静态令牌配置满足单用户/机器客户端，嵌入宿主可绑定自己的身份系统。服务记录同一次根调用的 traceId，错误公开字段由错误 owner 决定。

## MCP 工具按 Agent 的完整工作组织

使用官方稳定 v2 的 `@modelcontextprotocol/server`。`McpServer.registerTool` 注册共同 Schema 与执行函数，stdio 用 `@modelcontextprotocol/server/stdio` 的 `serveStdio(factory)`，HTTP 用 `createMcpHandler(factory).fetch`，挂到 Hono 的 `/mcp`。连接协商、请求编号、通知与取消由 SDK 处理。[SDK packages](https://ts.sdk.modelcontextprotocol.io/v2/get-started/packages)、[stdio](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio)

默认工具集合为 materials_accept、materials_inspect、materials_text、materials_structure、materials_sources、materials_list、results_read、tasks_list、tasks_describe、tasks_preview、tasks_run、tasks_run_many，以及 configuration_describe/explain。结果保存通过 tasks_run 的 persist 与 results_save；高级调用者可以在 allowlist 中加入 results_save、materials_retain/release 和 configuration_set/unset/reload。缺少权限的工具不出现在该 Principal 的发现结果中，执行入口仍检查权限。

MCP 单个工具的 `inputSchema` 使用完整 `z.object`。`outputSchema` 同样使用一个对象 Schema：`z.object({result: operation.output.optional(), error: errorInfoSchema.optional()}).strict()`，根 JSON Schema 保持 `type:'object'`。适配器构造返回信封时检查 result/error 恰有一个字段；这项检查只负责协议信封，结果业务字段仍复用 operation.output。

成功返回 `structuredContent:{result}`，content 用一段与结果一致的可读摘要；失败返回 `isError:true`、`structuredContent:{error}` 和可读错误。恰一字段检查在成功和失败两条路径都执行，因为 SDK 对 isError 结果跳过 outputSchema 校验。schema、工具描述与可读摘要由操作/任务实际定义生成。readOnlyHint、destructiveHint 与 idempotentHint 按操作行为设置；模型执行会消耗外部资源，应标为有副作用。[SDK Schema 接口](https://ts.sdk.modelcontextprotocol.io/v2/advanced/schema-libraries)、[工具错误](https://ts.sdk.modelcontextprotocol.io/v2/servers/errors)

材料 bytes 在 MCP 内只走受 maxJsonBytes 限制的内联形式。工具使用 materials_text 获取所需文本选区，结构读取返回可继续引用的 Selection；大量二进制由 HTTP/gRPC 的材料上传/下载完成。已保存材料可作为 `themelios://materials/<ref>` resource link 返回，resources/read 只返回大小限制内的媒体或文本；超限时返回引用与可用读取方式。每份资源都通过同一 Principal 与 Materials owner 读取。

MCP 的 stdout 始终由 SDK 独占。stdio EOF 取消本连接中的活动调用；close handle 等待协议结束，宿主再关闭 Session。HTTP 认证结果通过 SDK fetch 第二参数传给 request context，handler 从 context 绑定 Principal；Host/Origin 检查位于 SDK handler 之前。使用 SDK 当前的标准 transport，不另维护 SSE 旧协议副本。

为其他 Agent 框架提供工具定义时，导出同一 allowlist 中的名称、描述、JSON Schema 与执行函数。Themelios 负责一次完整工具操作；外部 Agent 根据结果决定是否继续调用。

## gRPC 使用显式 Protobuf 与真正的 HTTP/2

`@connectrpc/connect-node` 的 `connectNodeAdapter` 绑定 Bun `node:http2.createServer` 或配置 TLS 时的 `createSecureServer`。Bun.serve 只承担 HTTP/JSON/MCP；官方 Bun 文档列明该接口当前未提供 gRPC 所需的 response trailers。[Bun server](https://bun.sh/docs/runtime/http/server)、[Connect plugins](https://connectrpc.com/docs/node/server-plugins/)

服务定义在 `proto/themelios/v1/application.proto`，protobuf-es 生成类型；`packages/transports/src/grpc/codec.ts` 显式转换 Selection、Range、材料、输入使用记录、成果和事件。可直接落地的定义见 [application.proto](../examples/proto/themelios/v1/application.proto)。protobuf 的 `bytes` 在 SDK 转换为 Uint8Array；HTTP JSON 的同一字段使用 base64。任务 variables、value 和 providerOptions 使用 `google.protobuf.Value`；固定 envelope 使用正式字段。

protobuf oneof 的未选择状态、UNSPECIFIED enum 和缺失的必需 message 都由输入 codec 映射到共同 Schema 的缺失字段错误。uint64/int64 由 protobuf-es 读为 bigint，仅当转换到 JS number 仍为安全整数时通过；CommitPoint 直接使用 decimal string。可选 message 的缺失保留为 undefined，Value 的 NullValue 保留为真正 null。重复字段和 map 对应数组/对象；输出时空数组与省略 mappings 的差异按 core 可选语义归一。此 codec 只做线上表示转换，业务字段校验由 operation/Task Schema 拥有。

单次 RPC 覆盖 InstanceInfo、材料接纳/元信息/文本/结构/来源/列表、结果保存/读取、任务列表/说明/预览/执行/独立批次和配置。`ReadMaterial` 是服务端 bytes 分块流；`UploadMaterial` 是客户端分块流；`StreamTask` 是服务端 FlowEvent 流。具体方法名与字段见 proto 文件。

上传的第一条消息是 metadata，后续消息仅含 bytes chunk，空文件也以 metadata 开始；默认 chunk 为 64 KiB，单块上限 1 MiB。结束请求流表示字节发送完毕；服务端完成 Materials.accept 后返回 Selection。缺 metadata、重复 metadata 或中途异常取消 body，正式接纳只在完整成功后完成。最大总量由 `content.maxImportBytes` 检查。

下载第一条消息携带 ArtifactInfo，后续每条为 bytes chunk；正常结束使用 gRPC OK trailers。deadline 或取消传入共同 CallOptions，原 body reader 在 finally 关闭。单次 JSON 等价消息受 maxJsonBytes 限制；大材料使用分块 RPC。

错误目录把 AppError 映射成 ConnectError 的标准 code，public ErrorInfo 作为本 proto 的 Failure detail 随 `grpc-status-details-bin` 交付。业务失败的 message 使用当前 locale，code 保持稳定。未知实现异常映射 internal，服务器日志保留真实 cause。已发送部分事件后的失败以非 OK trailers 结束，客户端不会收到假的最终 result。

`transports.grpc.listen` 默认省略，显式开启时采用 127.0.0.1。`transports.grpc.tls` 可配置 `{key,cert}` 两个 CredentialRef，随监听器重启生效；也可由已有反向代理终止 TLS。启用外部端点时在部署配置中选择一个实际 TLS 终止位置。调用超时由客户端 gRPC deadline 与服务端默认总期限取较短值。

## 错误编码保留同一含义

错误目录见 [诊断与网络](observability-network.md)。协议按完整 code 查目录中的明确映射，错误消息用于人读。CLI 退出码按下表填入同一目录项；表中细分 code 的行优先于一般类别。

| 情况 | HTTP | CLI | gRPC |
| --- | --- | --- | --- |
| 请求/选区/任务变量无效 | 400 | 2 | INVALID_ARGUMENT |
| 入口缺认证或 token 无效 | 401 | 3 | UNAUTHENTICATED |
| 权限不足或只读实例写入 | 403 | 3 | PERMISSION_DENIED |
| 材料/任务/设置不存在 | 404 | 4 | NOT_FOUND |
| `storage.already_exists`、`runtime.instance_exists` | 409 | 5 | ALREADY_EXISTS |
| 当前实例占用、格式或状态冲突 | 409 | 5 | 依完整 code 目录，通常 FAILED_PRECONDITION |
| `storage.history_unavailable` | 410 | 4 | OUT_OF_RANGE |
| 请求或结果超过限制 | 413 | 2 | RESOURCE_EXHAUSTED |
| `time.overflow` | 422 | 2 | OUT_OF_RANGE |
| 其余材料、时间或模型能力/输出约束失败 | 422 | 2 | 依完整 code 目录 |
| `model.rate_limited` | 429 | 7 | RESOURCE_EXHAUSTED |
| 调用取消 | 499；连接已断开时结束处理 | 130 | CANCELLED |
| 总期限耗尽 | 504 | 6 | DEADLINE_EXCEEDED |
| 上游网络/模型不可用 | 502/503，依错误目录 | 7 | UNAVAILABLE |
| `runtime.native_unavailable`、`secret.unavailable` | 503 | 1 | 依完整 code 目录 |
| `storage.blob_missing`、`storage.blob_corrupt` | 500 | 1 | DATA_LOSS |
| 本地实现、IO 或文件交付失败 | 500 | 1 | INTERNAL |

CLI 的语法错误同时给最短用法；模型 provider 的认证失败属于上游错误，不转成调用者对 Themelios 的 401。MCP 的业务错误使用 isError 与相同 ErrorInfo；JSON-RPC 语法和协议错误由 SDK 处理。

## 代码落点与完成条件

| 文件 | 责任 |
| --- | --- |
| `packages/application/src/operations/{materials,results,tasks,prompts,configuration,instance}.ts` | 共同 Schema、权限与绑定执行函数 |
| `packages/application/src/application.ts` | 单一组合根，构造 API 和 operation allowlist |
| `packages/transports/src/wire.ts` | 正式值的 JSON/binary 编码，整条 JSON 大小限制 |
| `packages/transports/src/cli/{commands,output}.ts` | 参数取得、命令调用、stdout/stderr、文件交付 |
| `packages/transports/src/http/{server,routes}.ts` | Hono、上传下载、JSON/SSE、认证入口 |
| `packages/transports/src/mcp/{server,tools}.ts` | 官方 MCP handler 与按任务组织的工具/resources |
| `packages/transports/src/grpc/{server,codec}.ts` | HTTP/2 监听、生成服务注册、明确 codec |
| `proto/themelios/v1/application.proto` | 固定 wire 字段和 RPC |
| `apps/workbench/src/main.ts` | 进程级信号、安装定位与具体 Application 启动 |

完成后，一个已接纳材料通过 SDK、CLI、HTTP、MCP 和 gRPC 取得相同业务结果；读取、模型执行、保存与配置的权限在各入口一致。真实客户端能够取消流、读取结束状态、保存后断开 provider 重读成果；大文件经过流式传输，小型调用直接取得完整 JSON。所有错误和日志保持各自通道，任务资料来自同一实际定义。
