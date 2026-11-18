# Themelios 平台概览

Themelios 提供独立应用可直接使用的运行、存储、内容处理、模型和协议能力。一个应用可打开完整实例，通过 SDK、CLI 或协议操作，也可单独嵌入 Models、Prompt、CAS 或 SQLite。

| 包 | 拥有的能力 |
| --- | --- |
| `@themelios/core` | JSON、引用、选区、错误、完成值、取消、单消费者流和通用时间值 |
| `@themelios/runtime` | 安装、实例排他锁、会话、配置、凭据、网络、日志、追踪和本地化 |
| `@themelios/storage` | SQLite 同步事务、提交切面、CAS、时间映射及备份维护原语 |
| `@themelios/content` | 材料、精确文本选区、成果保存、来源和表示 |
| `@themelios/models` | 模型连接、生成、向量、重排、转写、任务定义和 Prompt |
| `@themelios/application` | 应用装配、统一输入准备、任务执行、显式保存和操作目录 |
| `@themelios/transports` | CLI、HTTP、MCP 和 gRPC 的实际监听与编码 |

## 一个实例中的保存和读取

`Installation.at(root, application)` 绑定程序与配置位置。`instance.init()` 初始化当前格式，`instance.open()` 取得系统文件锁并在会话内持有有效配置、数据库、CAS 和网络资源。重载后新调用取新配置，在途调用继续使用已捕获的配置和资源。

材料导入先写不可变 CAS，再在 SQLite 短事务中采用。应用自有表可与 `prepared.adopt(tx)` 共享同一提交。结果保存归一化整个完成值的依赖，将正文、已保存文件和来源一起采用。`Completed` 可直接当作下次输入；`SavedResult` 在会话重开后仍可读取。相同字节能共享 CAS，材料引用各自保留来源。

## 应用与扩展

任务通过一个输入准备过程取得实际提交给模型的内容。文本保留原始 UTF-8 字节坐标；图像裁切在朝正后的坐标面上执行。PDF 扩展用公开的表示接口注册选页、提取文字和渲染。对音视频可使用模型声明支持的原生媒体输入、显式转写或应用注册的表示配方。

工作台注册 `document.summary`、`media.describe` 及其模板。任务所有的输入和输出 Schema、示例与说明从 `TaskDefinition` 生成。HTTP、MCP、gRPC 和 CLI 使用同一个操作目录解析请求，由同一应用方法完成运行、保存和读取。
