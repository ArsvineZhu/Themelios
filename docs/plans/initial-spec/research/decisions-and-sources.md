# 需求、研究事实和本次设计共同形成执行合同

本包形成于 2026-11-18。设计从用户原始讨论、Space handoff、现行项目宪纲与当前任务授权收敛；旧 Spec 作为待改进的历史方案读取。用户的本机 Themelios 工作区尚未同步到本编写环境，因此实际目录、已实现能力和依赖锁定情况由实现者按 APPLY 核对。本包给出的接口、SQL 和目标文件是本次施工设计。

## 当前有效方向决定工程范围

| 依据 | 对本包的实际约束 |
| --- | --- |
| 用户原话《Wave 002 - 最近一天.md》与最新任务 | 基础设施完整规划，给出能执行的流程；Agent 专用工具链沿用；分文件分段写入；当前授权是完整 Spec 与 Goal |
| Space 的 Session Handoff | Themelios/Nexus/Nous 三仓职责、先独立完成基础平台、充分验证后暂停、旧 Spec 留下的具体合同缺口 |
| [项目宪纲](https://github.com/Heptalogos-Devs/Architecture-Vault/blob/main/项目宪纲.md) | 长期产品目标和 Nous 认知语义归属；本期只构建通用能力 |
| [AntiRLHF Constitution](https://github.com/AntiRLHF-Research/AntiRLHF/blob/main/CONSTITUTION.zh-CN.md) 与项目规划材料 | 从实际成本、完整操作与真实证据作判断；充分设计，避免无消费者抽象与审批仪式 |
| 用户指定 Superpowers 的计划思路 | 将目标分解成有前置接口、文件落点、实施动作和完成行为的单元；本任务按用户授权直接写完 |
| 用户已初始化的本机工作区 | 已有 Bun/Cargo workspace、锁文件、检查脚本与 Agent 辅助工具继续作为基础；在实际目录完善职责 |

基线采用用户已经确定的 Bun 1.4.4、TypeScript 7.0.2、Zod 4.6.7、Rust 1.100.0、napi-rs 3.x。具体依赖由实施工作区锁文件固定，产品运行时为 Bun。公开文档用于核对真实接入机制，不能把文档主分支自动当成本机安装版本。

## 关键结构由本次设计直接决定

| 具体决定 | 决定性理由 | 执行位置 |
| --- | --- | --- |
| 七包分工，Application 组合 Content 与 Models | 模型调用可独立成立，内容读取保持确定性，避免互相回调 | architecture、contracts |
| 普通 Completed 直接交给下一步，明确保存才取得正式引用 | 当前完成值本来就有输入、输出和生产事实；无需再发明临时结果服务 | core、content-results、input-pipeline |
| `$value` 用结果 manifest 的 `/value` 选区 | 同一结果正文已经保存该值，JSON Pointer 可以准确选择它 | public-contracts、content-results |
| SQLite 直接采用 bun:sqlite 的 prepared SQL | 平台表数量固定，业务需要组合一个同步事务；保留驱动能力可减少额外映射层 | storage、schema/storage.sql |
| CAS 先发布，短事务一次采用材料和业务事实 | 字节 IO 与 SQL 生命周期不同；提交是唯一正式保存完成点 | storage、content-results、inventory |
| 根区间、来源边和 history_floor 决定回收 | 历史读取与依赖关系都是真实消费者，不能只按当前独立列表删文件 | storage、content-results、time |
| 配置候选准备后保存文件，再同步交换一整套资源 | 文件成功与实际有效资源有明确次序，在途调用可继续使用旧资源 | configuration、installation-runtime |
| 原件目录与模型材料正文分别处理 | Prompt 作者有完整元数据；程序确保正文真正发送一次并准确记录 delivered | models-prompts、input-pipeline |
| 统一准备合同，核心文字/图像加实际 PDF 扩展 | 先验证真实扩展接入，音视频由所启用的模型/配方承担实际转换 | input-pipeline |
| 原生锁用 Rust 标准库，生命周期随 Session | 单机实例需要真正排他句柄，同时提供有用途的跨语言集成 | installation-runtime |
| gRPC 使用 node:http2 与 Connect-Node | 需要真实 HTTP/2 trailers，和 HTTP/JSON 入口分别使用合适监听器 | application-transports |
| Portable 自带 Bun、ESM、全部生产依赖与资源 | 可移动的完整软件是目标；目录发行能清楚保留 Native 和媒体资源 | build-release |

这些是架构决定，已落实为正文、合同、示例和实施动作。研究来源说明机制依据；本包承担产品语义和所有权决定。

## 存储和坐标采用现成标准与驱动能力

| 原始资料 | 直接影响 |
| --- | --- |
| [Bun SQLite](https://bun.sh/docs/runtime/sqlite) | 同步驱动、prepared statement、strict/safeIntegers 与真实事务接口；异步工作在事务前完成 |
| [SQLite WAL](https://sqlite.org/wal.html) | 本机 WAL 与多连接快照；运行/维护在同一主机处理，备份不直接复制活动主文件 |
| [SQLite VACUUM INTO](https://sqlite.org/lang_vacuum.html) | 从一致数据库快照复制关联 CAS，完整发布备份目标 |
| [SQLite synchronous](https://sqlite.org/pragma.html#pragma_synchronous) | 默认 FULL；明确选择 NORMAL 时展示其持久性影响 |
| [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901) | JSON 选区使用标准 Pointer，区分空 pointer、对象键与数组下标 |
| [unist Point 3.0](https://github.com/syntax-tree/unist/tree/3.0.0#point) | 语法树 offset 是 UTF-16 字符位置；存储坐标转换为原件 UTF-8 字节 |
| [remark-parse](https://github.com/remarkjs/remark/tree/main/packages/remark-parse)、[remark-gfm](https://github.com/remarkjs/remark-gfm) | Markdown 结构读取复用解析器，永久保存身份仍是原件及选区 |
| [Temporal.Instant](https://tc39.es/proposal-temporal/docs/instant.html)、[High Resolution Time](https://www.w3.org/TR/hr-time-3/) | UTC 表示与单调期限分别使用成熟时间能力；领域坐标通过整数映射 |

## 模型、运行和发行的详细资料按能力保存

- [model-sources.md](model-sources.md)：AI SDK、Zod、LiquidJS、sharp、PDF.js、PDF-LIB、FFmpeg，以及影响流取消/超时判断的实际问题记录。
- [runtime-sources.md](runtime-sources.md)：文件锁、TOML、原子配置写入、Bun FetchSession、Pino、OTel、i18next，以及心跳锁在暂停场景的维护者讨论。
- [transport-release-sources.md](transport-release-sources.md)：Connect、MCP SDK、Bun 包/构建/发行行为，以及 Native 装载问题记录。

社区材料采用维护者仓库中的真实 issue、复现和回应，作用是确定需要检查的失效路径。已经关闭的旧问题不会直接写成当前版本仍有缺陷。实施接入以已锁版本的类型、源代码与实际运行结果为准。

## 旧方案在本次发生了明确收敛

旧助手方案中的 Drizzle、心跳文件锁、单文件编译优先、认知五轴下沉、协议临时结果 token 与自动发现宿主等提法均不再作为本期施工要求。当前方案分别落实为直接 SQLite、OS 句柄锁、完整 Portable 目录、通用时间域、完整 wire 完成值，以及明确协议连接。

保留的有效方向已经具体化：安装包含软件和数据，配置含字段描述及生效语义，来源保持原件与实际交付关系，Prompt 有完整开发参考，正式 API 绑定长期上下文，包与协议提供普通应用可直接使用的完整操作。
