# 业务操作与协议传输

Themelios 把 SDK 作为宿主应用直接消费的核心接口，同时通过通用 `Operation` 模型让宿主只需定义一次领域操作，即可自动获得统一的 CLI、HTTP/SSE 与 MCP 服务能力。

## 通用 `Operation` 契约

应用通过 SDK 实现业务，再从 `@themelios/runtime/operations` 导入 `defineOperation<App>()` 声明对外操作。操作类型与输入输出 Schema 一起定义执行合同。将同一组声明传给需要启用的协议入口。

| 字段 | 职责 |
| --- | --- |
| `id`、`description`、`permission` | 规范点分名称（如 `tasks.run`、`inventory.import`）、用途说明与权限等级（`"read" \| "write" \| "admin"`） |
| `kind` | `"unary"`（默认）、`"stream"`（SSE 或 CLI 流式输出）或 `"binary-read"`（字节流下载） |
| `input`、`output` | Zod 输入和结果合同。流使用同一结果合同校验最终事件。MCP 公开的合同可导出为 JSON Schema |
| `http` | REST 路由数组，各项可声明路径和查询参数映射及原始上传。空数组关闭入口，缺省路径为 `POST /operations/<id>` |
| `mcp` | 可选 `McpToolSpec`，指定 `expose`、权限提示和专用 `input` Schema。专用 Schema 的解析结果使用操作执行函数的输入类型 |
| `cli` | 自定义命令、选项与参数解析。`null` 关闭自动挂载，缺省时按操作 ID 自动生成子命令 |
| `present(output, app, context)` | 可选纯文本展示 formatter；CLI 未指定 `--json` 时优先调用以输出面向人类终端的结果 |
| `execute(app, input, context)` | 业务入口，由 `callOperation` 检查权限、校验输入、执行并校验结果。调用方根据返回的 `kind` 读取普通结果、事件流或原件字节 |

## 可组合的标准操作包

宿主应用可以组合现成的操作。实例与配置来自 `@themelios/runtime/operations`，工作台使用的内容、任务和组合目录来自 `@themelios/application`。

- `instanceOperations()`：`instance.info`
- `configurationOperations()`：`configuration.describe`、`configuration.explain`、`configuration.set`、`configuration.unset`、`configuration.reload`
- `contentOperations()`：`materials.accept`、`materials.inspect`、`materials.read`、`materials.text`、`materials.structure`、`materials.sources`、`materials.listRetained`、`materials.retain`、`materials.release`、`results.save`、`results.read`
- `taskOperations()`：`tasks.list`、`tasks.describe`、`tasks.preview`、`tasks.run`、`tasks.runMany`、`tasks.stream` 与 `prompts.*`
- `standardOperations()`：组合上述全部标准操作包

## 统一传输层（@themelios/transports）

- **共享 HTTP 安全管线（`runProtectedHttp`）**：HTTP/SSE 业务路由与 `/mcp` Streamable HTTP 共用同一套请求租约追踪（`RequestTracker` + `retainResponse`）、`Host` / `Origin` / CORS 校验、`Bearer` 令牌与常数时间认证、语言协商（`Accept-Language`）与 `traceId` 脱敏错误返回。
- **HTTP 与 SSE**：按操作目录注册 REST 路由，启用 `enableMcp: true` 时在同一端点挂载 `/mcp`。监听空闲时限与业务执行期限各有用途，流式请求允许在两个事件之间保持连接。
- **gRPC**：`themelios.Operations` 用 `Invoke` 执行普通操作，用 `Stream` 返回任务事件或原件字节，用双向 `Upload` 提供操作元数据和原始上传。HTTP 和 gRPC 都按 Operation 声明的 `binaryInput` 验证流式输入。Protobuf 定义随 Transports 包提供。
- **MCP（HTTP 和 stdio）**按操作目录与当前权限公开普通操作。应用可提供资源 URI 模板和一个读取字节的操作。工作台在 `themelios://materials/{ref}` 提供原件。
- **CLI** 的 `runApplicationCli` 接收应用的 `Installation` 和操作目录，生成命令并管理会话。工作台在自身入口装配材料、成果、任务、提示词和配置命令。
- **监听与关停**由 `serveApplication` 管理。应用传入会话、监听地址和认证配置，也可用 `allowOperations` 限定公开目录。监听器结束后由应用关闭会话。已由其他服务管理监听器的应用可直接挂载 `createHttpHandler`。

## MCP 边界的 Agent 短引用桥接

应用通过 `agentRefs` 提供双向解析。MCP 工具仅转换使用 `artifactRefSchema` 声明的字段，普通文本和业务 JSON 按原值传递。SDK、HTTP 和数据库使用 `art_<uuid>`。模型任务使用当前请求内的来源键，例如 `S1`。

联合结果按声明顺序匹配输出 Schema。结果形状重叠且引用含义不同的分支应声明判别字段。
