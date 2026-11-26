# Themelios 平台概览

Themelios 提供独立应用可直接使用的运行、存储、内容处理、模型和协议能力。一个应用可打开完整实例，通过 SDK、CLI 或协议操作，也可只引入 `@themelios/models` 单独运行结构化任务。更多细则见[设计文档](design/README.md)。

| 包 | 拥有的能力 |
| --- | --- |
| `@themelios/core` | JSON、引用（`art_<uuid>` 与 `readable60`）、选区、错误、完成值、取消、单消费者流和通用多域时间值 |
| `@themelios/runtime` | 安装、基于 SQLite 独占句柄的实例排他锁、会话、分层配置、凭据、网络、诊断追踪、本地化、通用操作契约 |
| `@themelios/storage` | SQLite 同步事务、提交切面、`time_domains`、字节登记、CAS、备份、恢复与回收 |
| `@themelios/content` | 材料、精确文本选区、成果保存、来源图、表示索引与图像适配器 |
| `@themelios/models` | 网关连接、生成、向量、重排、转写、独立任务执行（`models.runTask`）、Prompt 与表示复用 |
| `@themelios/application` | 应用装配，内容、任务和提示词的标准操作，JSON 与 SDK 值的边界转换 |
| `@themelios/transports` | 共享认证策略与基于操作目录的 CLI、HTTP/SSE、MCP 和 gRPC |
| `@themelios/pdf` | PDF 探测、选页、文本提取、选页渲染 |
| `@themelios/media` | 通过本机 FFmpeg/ffprobe 探测时长、裁切压缩音视频、提取音轨与单帧 |

## 一个实例中的保存和读取

`Installation.at(root, application)` 绑定程序与配置位置。`instance.init()` 初始化当前格式，`instance.open()` 持有 `run/instance.lock` 系统锁并在会话内管理有效配置、数据库、CAS 与网络资源。重载后新调用读取新配置与资源，在途调用继续使用已捕获的一代资源。

材料导入先捕获不可变 CAS 原件，再在 SQLite 短事务中登记。应用可通过 `attach` 在材料导入或成果保存的同一事务写入业务外键，并直接取得业务结果。成果保存归一化整个完成值的依赖，将正文、已保存文件和来源一起写入。`Completed` 可直接当作下次输入，`SavedResult` 在会话重开后仍可读取。相同字节共享 CAS 对象，材料引用各自保留来源。

## 应用与扩展

任务通过统一准备流程取得实际提交给模型的内容。文本保留原始 UTF-8 字节坐标；图像裁切在朝正后的坐标面上执行；当相同选区与配方已登记有效表示时直接复用。PDF 扩展用公开的适配器接口提供选页、提取文字与渲染能力。

工作台注册 `document.summary`、`media.describe` 及其模板。任务输入输出 Schema、示例与说明直接由 `TaskDefinition` 导出。HTTP/SSE、MCP 与 CLI 使用同一份 `Operation` 目录派发请求，MCP 边界自动完成 `art_<24字母>` 短引用与内部 `art_<uuid>` 之间的双向映射。
