# 工作台命令与协议

先完成[工作台入门](workbench.md)，取得一份材料和一个成果。下面用 `R` 指代材料的 `art_…` 引用，`V` 指代成果引用，`T` 为 `document.summary`。命令均由 `themelios` 执行，使用自选安装根时加 `--installation 路径`。

- `request.json` 包含 `task`、`variables` 和 `materials`。专用 HTTP 任务路由从 URL 取 `task`，请求体只放 `variables`、`materials` 及可选项。
- `selection.json` 示例为 `{"ref":"R","range":{"kind":"text","start":2,"end":5}}`。含 `# Tea` 的 UTF-8 文本在此选区返回 `Tea`。
- `value.json` 来自 `themelios task run --input request.json --json > value.json`。这是尚未保存的 `Completed`，可送入 `result save`。`batch.json` 形如 `{"inputs":[...]}`，每项都使用完整的 `request.json` 形状。

## 材料和成果

| 功能和权限 | CLI 实例 | HTTP 实例 | MCP |
| --- | --- | --- | --- |
| `materials.accept` · write | `material import --file notes.md` | `POST /materials?name=notes.md`，正文为文件字节，`Content-Type: text/markdown`；或 `POST /materials/accept`，正文 `{"bytes":"VGVh","mediaType":"text/plain","name":"tea.txt"}` | `materials_accept` |
| `materials.inspect` · read | `material inspect R --json` | `GET /materials/R` | `materials_inspect` |
| `materials.read` · read | `material read R` 将原件写到 stdout，`material export R copy.md` 写到新文件 | `GET /materials/R/content` | `resources/read` |
| `materials.text` · read | `material text --input selection.json --json` | `POST /materials/text`，正文用 `selection.json` | `materials_text` |
| `materials.structure` · read | `material structure R --json` | `GET /materials/R/structure` | `materials_structure` |
| `materials.sources` · read | `material sources V --depth 2 --json` | `GET /materials/V/sources?depth=2` | `materials_sources` |
| `materials.list` · read | `material list --limit 2 --at 1 --after R --json` | `GET /materials?limit=2&at=1&after=R` | `materials_list` |
| `materials.retain` · write | `material retain R` | `POST /materials/R/retain`，正文 `{}` | |
| `materials.release` · write | `material release R` | `POST /materials/R/release`，正文 `{}` | |
| `results.save` · write | `result save --input value.json --json` | `POST /results`，正文用 `value.json` | |
| `results.read` · read | `result read V --json` | `GET /results/V` | `results_read` |

CLI 还可用 `material import --text Tea --name tea.txt`、`material import --stdin --mime text/plain` 或 `material import --input inline.json`。`inline.json` 使用 `/materials/accept` 的 Base64 正文形状。四种输入选一种。显式 `--name` 和 `--mime` 设置显示名与媒体类型，优先于 JSON 中的 `name` 和 `mediaType`。导出要求目标文件尚未存在。

`structure` 返回 Markdown 标题、段落、引用、代码块和表格等块及其原文坐标。`sources` 追查输入、成果文件和派生表示与原件的关系。`list` 的 `at` 使用提交位置，`after` 取上一页的末尾引用。`release` 解除直接保留，仍被其他成果使用的材料继续受来源关系保护。

## 任务和提示词

| 功能和权限 | CLI 实例 | HTTP 实例 | MCP |
| --- | --- | --- | --- |
| `tasks.list` · read | `task list --json` | `GET /tasks` | `tasks_list` |
| `tasks.describe` · read | `task describe T --json` | `GET /tasks/T` | `tasks_describe` |
| `tasks.preview` · read | `task preview --input request.json --json` | `POST /tasks/T/preview` | `tasks_preview` |
| `tasks.run` · write | `task run --input request.json --save --json` | `POST /tasks/T/run`，加 `"persist":true` 保存 | `tasks_run` |
| `tasks.runMany` · write | `task run-many --input batch.json --json` | `POST /tasks/run-many`，正文用 `batch.json` | `tasks_run_many` |
| `tasks.stream` · write | `task run --input request.json --stream --save --json` | `POST /tasks/T/stream`，加 `"persist":true` 保存 | |
| `prompts.read` · read | `prompt read T --part user > user.liquid` | `GET /tasks/T/prompts` | |
| `prompts.describe` · read | `prompt describe T --json` | `GET /tasks/T/prompts/describe` | |
| `prompts.diff` · read | `prompt diff T --json` | `GET /tasks/T/prompts/diff` | |
| `prompts.setOverride` · admin | `prompt edit T --part user --file user.liquid` | `POST /tasks/T/prompts/override`，正文 `{"role":"user","template":"Summarize in {{ language }}."}` | |
| `prompts.reset` · admin | `prompt reset T --part user` | `POST /tasks/T/prompts/reset`，正文 `{"role":"user"}`；整套重置用 `{}` | |

用 `task describe media.describe` 查询另一项内建任务。以 `{"task":"media.describe","variables":{"instructions":"Describe the visible text"},"materials":[{"source":{"ref":"R"}}]}` 请求描述，返回自由文本。`document.summary` 返回标题、段落和来源键，详见两项[任务参考](../README.md)。

预览列出提示词、准备计划及可复用内容。材料已备齐时，预览也会检查完整消息是否符合模型输入预算。执行后查看实际交付给模型的来源。`task run --output fresh.json` 向目标新文件交付；去掉 `--json` 则可在终端阅读摘要。批处理结果按请求顺序，各项独立返回 `ok`。将合法请求和 `missing.task` 请求一起送入 `run-many`，得到一个成功项和一个错误项。流式运行的 CLI 返回逐行 JSON，HTTP 返回 SSE，处理 `progress`、`text-delta`、`result` 和 `error` 事件。

## 实例与设置

| 功能和权限 | CLI 实例 | HTTP 实例 | MCP |
| --- | --- | --- | --- |
| `instance.info` · read | `instance info --json` | `GET /instance` | |
| `configuration.describe` · read | `config describe /locale --json` | `GET /configuration?path=/locale` | `configuration_describe` |
| `configuration.explain` · read | `config explain /locale --json` | `POST /configuration/explain`，正文 `{"path":"/locale"}` | `configuration_explain` |
| `configuration.set` · admin | `config set /locale '"en"'` | `POST /configuration/set`，正文 `{"path":"/locale","value":"en"}` | |
| `configuration.unset` · admin | `config unset /locale` | `POST /configuration/unset`，正文 `{"path":"/locale"}` | |
| `configuration.reload` · admin | `config reload` | `POST /configuration/reload`，正文 `{}` | |

`describe` 查看字段的可选值、生效时机和作用域，`explain` 查看默认值、安装、实例和托管层的贡献及当前有效值。`set` 在托管层固定值，`unset` 恢复继承。修改 TOML 后运行 `reload`，返回需要重启的字段。字符串参数请保留作为 JSON 的双引号。也可以用 `config set --input config-change.json` 读取与 HTTP 相同的对象。

初始化另一个实例用 `themelios --instance study instance init`。`serve` 和 `mcp` 分别打开监听和 stdio 服务，进程持有实例锁。同一实例在服务期间宜走协议读取；停止服务后便可用直接 CLI 或离线维护：

```sh
themelios storage verify
themelios storage backup ./backup
themelios --instance restored storage restore ./backup
themelios --instance restored result read V --json
themelios --instance restored storage verify
themelios storage collect
themelios storage collect --retain-since 1
```

选择新备份目录和新恢复实例。`collect --retain-since` 推进历史下界；查询更早提交前先保留相应备份。`--help` 可随命令查看精确参数。全局 `--json` 选择机器输出，`--locale en` 选择显示语言，`--timeout-ms 30000` 设置调用时限，`--debug` 展开本地错误。

## 发出实际 HTTP 或 SSE 请求

按[工作台指南](workbench.md#连接正在运行的工作台)配置监听和令牌并运行 `themelios serve`。以启动时 stderr 中的地址为准。下面的 `http-request.json` 由原 `request.json` 去掉顶层 `task` 获得：

```sh
BASE=http://127.0.0.1:9010
AUTH="Authorization: Bearer $THEMELIOS_OPERATOR_TOKEN"
curl -fsS -H "$AUTH" "$BASE/instance"
curl -fsS -H "$AUTH" -H 'Content-Type: text/markdown' --data-binary @notes.md "$BASE/materials?name=notes.md"
curl -fNS -H "$AUTH" -H 'Content-Type: application/json' -H 'x-themelios-timeout-ms: 30000' --data-binary @http-request.json "$BASE/tasks/document.summary/stream"
```

HTTP 令牌按权限集合授权。只配置 `read` 的令牌可以读取实例并预览任务，写入材料或修改配置时返回 `403`。缺少有效令牌返回 `401`，上传超过限制返回 `413`。远程错误中的 `traceId` 可用于查找实例日志。`Accept-Language: en` 选择英文响应。Windows PowerShell 可用 `curl.exe`，地址与令牌变量分别按 `$base = 'http://127.0.0.1:9010'` 和 `$auth = "Authorization: Bearer $env:THEMELIOS_OPERATOR_TOKEN"` 设置。

## 接入 MCP 客户端

HTTP 客户端连接 `http://127.0.0.1:9010/mcp` 并携带同一 Bearer 令牌。stdio 客户端可以启动 `themelios --installation 路径 mcp`。两者均通过 MCP 初始化，再用 `tools/list` 获取当前身份的工具和 Schema。

| 方法 | 示例 `params` | 返回 |
| --- | --- | --- |
| `tools/list` | `{}` | 当前客户端可调用的工具 |
| `tools/call` | `{"name":"materials_accept","arguments":{"bytes":"VGVh","mediaType":"text/plain"}}` | `structuredContent.result.ref` 提供材料的短引用 |
| `tools/call` | `{"name":"materials_text","arguments":{"ref":"上一步的短引用"}}` | `structuredContent.result.text` 为 `Tea` |
| `resources/read` | `{"uri":"themelios://materials/上一步的短引用"}` | 原始材料内容及媒体类型 |

逐项调用前文 MCP 工具时，使用同一操作的 JSON 字段。传入 Agent 短引用时照抄该连接返回的 `art_` 加 24 个字母值。`tasks_preview`、`tasks_run` 的工具输入包含 `task`。stdio 进程使用本机身份，HTTP 使用令牌权限。

工作区内可以直接查询完整操作合同。先构建 `workbench`，再运行：

```sh
bun run operations:describe
bun run operations:describe -- tasks.preview
bun run operations:describe -- materials.accept
```

单项输出包括标准输入和输出的 JSON Schema、权限、HTTP 路由及路径和查询参数映射。HTTP 原始上传直接发送字节，`tools/list` 给出 MCP 使用的短引用 Schema。

## 从 gRPC 客户端调用

在实例设置中启用监听，配置与 HTTP 共用的 `transports.authTokens`，然后运行 `themelios serve`。监听地址出现在启动输出的 `endpoints.grpc`。

```toml
[transports.grpc.listen]
host = "127.0.0.1"
port = 9011
```

在仓库根用 `grpcurl` 调用实例信息。`operations.proto` 也随 Transports 包提供，可用本语言的 gRPC 工具生成客户端。

```sh
grpcurl -plaintext -import-path packages/transports/proto -proto operations.proto \
  -H "authorization: Bearer $THEMELIOS_OPERATOR_TOKEN" \
  -d '{"operation":"instance.info","input":{}}' 127.0.0.1:9011 themelios.Operations/Invoke
```

| RPC | 输入实例 | 返回 |
| --- | --- | --- |
| `Invoke` | `{"operation":"materials.text","input":{"ref":"R","range":{"kind":"text","start":2,"end":5}}}` | `result.text` 为 `Tea` |
| `Stream` | `{"operation":"tasks.stream","input":{"task":"document.summary","variables":{},"materials":[{"source":{"ref":"R"}}]}}` | `progress`、`textDelta` 与 `result` 帧 |
| `Stream` | `{"operation":"materials.read","input":{"ref":"R"}}` | `download` 元数据帧和原件 `chunk` 字节 |
| `Upload` | 先发 `{"request":{"operation":"materials.accept","input":{"name":"tea.txt","mediaType":"text/plain"}}}`，再发一个或多个 `{"chunk":"VGVh"}`，最后关闭客户端发送端 | `result.ref` 为正式材料引用。这里的 Base64 是 protobuf JSON 对 `bytes` 的表示，二进制客户端直接发送字节。 |

跨机器监听时可在 `[transports.grpc.tls]` 用 `key`、`cert` 引用 `file:` 或 `env:` 中的 PEM 内容。启用 TLS 后，客户端连接相应的 HTTPS 端点。gRPC 状态详情携带 `Failure`，包含应用错误码和可用的 `traceId`。[Protobuf 定义](../../packages/transports/proto/operations.proto)
