# Themelios 当前状态

## 已具备能力

- **核心类型与标识（`@themelios/core`）**：提供严格 JSON 校验、`ArtifactRef`（`art_<uuid>`）与 60 位 `readable60` 码表映射、UTF-8 字节/页/像素/JSON 选区、`Completed` / `SavedResult`、可取消任务与单消费者流 `Flow`、`AppError`（含 `traceId`）以及多域时间原语。
- **运行、配置与锁（`@themelios/runtime`）**：提供便携与外部目录布局、基于 `bun:sqlite` 排他句柄的 `instance.lock` 实例锁、四层配置叠加与生效解释、配置驱动的资源重载 `bindResource`、凭据与受控 `Network`、Pino JSONL 诊断以及中英文消息本地化。
- **存储、内容与媒体（`@themelios/storage`、`@themelios/content`、`@themelios/pdf`）**：提供同步写事务与提交切面 `seq`、`time_domains` 注册表、CAS 去重、材料准备与业务共提交采用、成果依赖图闭合保存与追溯、文本坐标提取、Markdown 分块、图像朝正与变换（`sharp`）、PDF 页选与光栅渲染以及离线备份/恢复/回收/校验。
- **模型与提示词（`@themelios/models`）**：提供厂商中立连接与显式能力绑定、Liquid 模板 AST 缓存与实例覆盖、多模态输入规划与已保存表示自动复用，支持独立 `models.runTask` 无存储嵌入运行。
- **通用应用操作与传输**由 `@themelios/runtime/operations` 定义操作、权限和校验，`@themelios/transports` 将应用选定的操作提供给 CLI、HTTP/SSE 和 MCP。工作台和库存应用都使用这套入口。
- **示例与发行**包括独立的模型脚本、CLI 文档工作台和库存应用。模型示例只声明 `@themelios/models`，支持内联和文件 Prompt。公共包可打包为 `.tgz`，工作台可构建 Windows x64 和 Ubuntu x64 Portable。

## 生效中的工程决策

- 应用通过 SDK 组合平台能力，并显式注册要通过 CLI、HTTP/SSE 和 MCP 开放的操作。
- 实例互斥完全由 `bun:sqlite` 独占文件句柄实现，发行包无 Rust 原生扩展构建步骤。
- 时间系统区分领域内置（`utc` 墙钟毫秒精度与 `linear`/`opaque` 整数域、`unknown`/`duration`/`uncertain_instant` 区间三值匹配），不在存储层维护动态跨世界速率折算表。
- `art_<24个小写字母>` 仅用于 MCP 与 Agent 交互边界省 token；系统内部、持久化、SDK 与 HTTP REST 继续保留 `art_<uuid>`。

## 后续工作

- 按上层认知与多媒体产品需求，接入音视频切段/帧抽取外部适配器（如 ffmpeg 适配层）。
- 视后续应用数据检索需要，补充向量存储与全文检索装配模块。
- 面向具体业务持续扩充可复用的任务定义、提示词评估与上层知识图谱消费适配。
