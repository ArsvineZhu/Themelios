# Themelios 完整实施规范

本执行包规定 Themelios 独立通用基础平台的目标、公共合同、持久格式、实现方法、工作依赖与完成行为。实现者从用户已初始化的本机工作区继续，完成可被普通应用消费的正式包和可搬迁运行的 Portable。Nous 与 Nexus 分别留在其领域和数值算子仓库。

## 从目标与依赖顺序进入施工

先读 [GOAL.md](GOAL.md)、[APPLY.md](APPLY.md)、[架构](spec/architecture.md) 和 [公共合同](spec/public-contracts.md)，再按 [实施计划](plan/implementation.md) 的依赖选择当前可执行工作。实施单元给出具体文件、消费与产出的接口、数据变更和可观察完成条件；包内的函数拆分、数据结构与局部性能方法由实现者根据实际代码决定。

| 主题 | 正式规格 |
| --- | --- |
| 安装、实例、会话、资源生命周期 | [installation-runtime.md](spec/installation-runtime.md) |
| 配置、默认值、来源、重载与重启 | [configuration.md](spec/configuration.md) |
| 错误、日志、Trace、指标、网络、凭据、国际化 | [observability-network.md](spec/observability-network.md) |
| SQLite、CAS、备份、清理、离线迁移 | [storage.md](spec/storage.md) |
| UTC、单调期限、其他时间域与历史切面 | [time.md](spec/time.md) |
| 材料、选区、来源、成果与表示 | [content-results.md](spec/content-results.md) |
| 模型、任务、Schema、Prompt 开发 | [models-prompts.md](spec/models-prompts.md) |
| 输入、媒体适配、原生发送与表示转换 | [input-pipeline.md](spec/input-pipeline.md) |
| SDK、CLI、HTTP、MCP、gRPC | [application-transports.md](spec/application-transports.md) |
| Agent 工具链、包、Native、Portable | [build-release.md](spec/build-release.md) |

`contracts/` 是可检查的接口声明，`schema/storage.sql` 是具体初始化 DDL。Markdown 解释其语义与执行顺序；声明和 SQL 表达字段及约束。实现时把两者一起落实到对应能力的代码和 Zod 定义中。

`examples/` 提供任务、Prompt、配置、协议与非 Nous 应用参考。[验收计划](plan/verification.md) 以完整使用路径检查产品；[发行计划](plan/distribution.md) 把包构建、外部消费与 Portable 连在一起。`research/` 记录改变了设计的依赖事实和原始链接。

本包编写时实际完成的类型、Protobuf、SQL 和示例检查见 [delivery-checks.md](research/delivery-checks.md)。[决策与资料](research/decisions-and-sources.md) 区分用户已确定方向、外部依据和本次架构选择。FILE-MANIFEST.json 记录各内容文件的大小与哈希。

## 完成的交付范围

实现交付包括源码、实际接通的命令与协议、配置/任务帮助、独立应用、npm tarball、Windows 与 Ubuntu Portable、使用说明，以及已执行路径和剩余阻塞的准确报告。Themelios 独立可用后停止本期工作。

本执行包更新并替代旧 `Themelios-Foundation-Spec` 的施工合同。旧对话和旧 Nous 实现用于规划时理解背景；Coding Agent 依靠本包和当前工作区即可执行。
