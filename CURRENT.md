# Themelios 当前状态

## 已具备能力

- **核心类型与标识（`@themelios/core`）**：提供严格 JSON 校验、`ArtifactRef`（`art_<uuid>`）与 60 位 `readable60` 码表映射、UTF-8 字节/页/像素/JSON 选区、`Completed` / `SavedResult`、可取消任务与单消费者流 `Flow`、`AppError`（含 `traceId`）以及多域时间原语。
- **运行、配置与锁（`@themelios/runtime`）**：提供便携与外部目录布局、SQLite 句柄实例锁、四层配置及显式固定值、在途调用资源捕获、可取消执行、凭据与受控网络、Pino JSONL 诊断和消息本地化。
- **存储、内容与媒体**：同步事务、提交切面和时域注册表管理正式写入。内容图、业务外键和共享字节登记支持原子采用、追溯、备份、恢复、回收及校验。媒体支持 UTF-8 选区、Markdown 结构、图像裁切、PDF 选页/文字/渲染与 PCM WAV 时间裁切。`@themelios/media` 使用本机 FFmpeg/ffprobe 裁切压缩音频和视频、提取音轨与帧。
- **模型与提示词（`@themelios/models`）**：显式绑定网关、模型和能力，可给任务指定有序备用绑定；Liquid 模板可以按实例覆盖。任务可查看原件、选区和实际交付，复用按本次配方生成的表示，也可独立使用 `models.runTask`。
- **通用应用操作与传输**由 `@themelios/runtime/operations` 定义操作、权限和校验，`@themelios/transports` 将应用选定的操作提供给 CLI、HTTP/SSE、MCP 和 gRPC。工作台可以在进程启动时加载本机扩展。
- **使用与发行**包括独立模型脚本、CLI 文档工作台、库存应用和 SDK 使用示例。公共包可打包为 `.tgz`，工作台可构建 Windows x64 和 Ubuntu x64 Portable。各项操作有[命令和协议实例](docs/development/operations.md)与可查询的 JSON Schema。

## 生效中的工程决策

- 应用通过 SDK 组合平台能力，并显式注册要通过 CLI、HTTP/SSE、MCP 和 gRPC 开放的操作。
- 实例互斥完全由 `bun:sqlite` 独占文件句柄实现，发行包无 Rust 原生扩展构建步骤。
- 时间系统区分领域内置（`utc` 墙钟毫秒精度与 `linear`/`opaque` 整数域、`unknown`/`duration`/`uncertain_instant` 区间三值匹配），不在存储层维护动态跨世界速率折算表。
- `art_<24个小写字母>` 仅用于 MCP 与 Agent 交互边界省 token；系统内部、持久化、SDK 与 HTTP REST 继续保留 `art_<uuid>`。

## 后续工作

- 按消费应用的检索需求决定向量索引的接入方式。业务全文检索可直接使用 SQLite FTS5，见 [笔记检索示例](examples/sdk/search.ts)。
- 面向具体业务持续扩充可复用的任务定义、提示词评估与上层知识图谱消费适配。
