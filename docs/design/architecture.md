# 架构与包职责

Themelios 使用 TypeScript 7 与 Bun 1.4+ 构建，按清晰的单向依赖边界拆分为 7 个核心公共包与领域扩展包：

```mermaid
flowchart TD
  Core["@themelios/core"] --> Runtime["@themelios/runtime"]
  Core --> Storage["@themelios/storage"]
  Core --> Content["@themelios/content"]
  Storage --> Content
  Core --> Models["@themelios/models"]
  Runtime --> Models
  Core --> Pdf["@themelios/pdf"]
  Core --> Media["@themelios/media"]
  Content --> App["@themelios/application"]
  Models --> App
  Runtime --> App
  Storage --> App
  Core --> App
  Runtime --> Transports["@themelios/transports"]
  Core --> Transports
```

## 包职责表

| 包 | 拥有能力 | 关键入口与说明 |
| --- | --- | --- |
| `@themelios/core` | JSON 边界校验、`ArtifactRef` 与 60 位 `readable60`、选区、媒体契约与 MIME 探测、时间原语、`AppError`、`Completed`/`SavedResult`、`CallOptions`/`Flow` | 所有包共用基础值与媒体合同 |
| `@themelios/runtime` | 安装、会话、实例锁、配置、网络、诊断和通用操作契约 | `@themelios/runtime/operations` 定义宿主操作、权限和执行校验 |
| `@themelios/storage` | `Database`（同步短事务、提交切面 `seq`、`commits`、`time_domains`、`blobs`）、`Cas` 内容寻址存储、备份恢复、回收与校验 | 使用 `bun:sqlite` 与 `write-file-atomic`，从实际业务外键枚举所持有对象 |
| `@themelios/content` | `Materials`、`Results`、`Representations`、文本选区、Markdown 结构分块、图像朝正与编码适配器 `createImageAdapter` | 协调 `artifacts`、`artifact_edges`、`artifact_retention`、`representations` |
| `@themelios/models` | 厂商中立模型网关连接与显式能力绑定、`createPrompts` Liquid 模板编译与缓存、`createPreparation`、任务的预览与执行 | 可脱离存储与实例单独嵌入使用 |
| `@themelios/application` | `createApplicationModule`、`ApplicationApi`、内容与模型任务操作 | 组合会话、内容与模型，供完整应用和工作台使用 |
| `@themelios/transports` | 将显式提供的操作目录开放为 HTTP/SSE、MCP、gRPC 和 CLI | 依赖 Runtime 与 Core。宿主提供业务对象和开放的操作 |
| `@themelios/pdf` | PDF 页范围抽取、文本提取与光栅化渲染适配器（`createPdfAdapters`） | 作为 `RepresentationAdapter[]` 在应用装配时注入 |
| `@themelios/media` | FFmpeg 音视频裁切、音轨提取和帧提取（`createMediaAdapters`） | 通过与 PDF 相同的适配器合同注册 |

## 独立嵌入与完整应用

- **轻量嵌入**：应用只需要模型与多模态任务时，安装 `@themelios/models` 即可。用 `createModels` 建立客户端，通过 `models.tasks` 预览、执行、流式执行或批量运行内联及文件模板任务。可按任务需要接入本地媒体适配器和材料库。
- **自定义业务应用**：业务方直接使用 `@themelios/core`、`@themelios/runtime`、`@themelios/storage`、`@themelios/content`、`@themelios/application` 与 `@themelios/transports`（例如 `examples/inventory`），用 `defineOperation` 描述领域操作并组合 `instanceOperations()`，即可复用同一套实例锁、配置重载、CLI、HTTP 与 MCP 传输。
- **完整文档工作台**：`apps/workbench` 使用 `createApplicationModule`、`@themelios/pdf` 与 `standardOperations`，提供材料管理、任务执行、提示词覆盖与离线维护的完整可执行发行物。监听、认证及传输限制由工作台的设置段定义。
- **带业务表的应用**：应用把业务 DDL 交给 `createApplicationModule`，并在打开回调中使用同一实例的数据库、内容和模型资源。Storage 定义提交与对象表，Content 定义材料、来源、保留和表示关系，应用定义业务表。模型连接、任务执行器及媒体适配器按同一个会话资源代际建立。
