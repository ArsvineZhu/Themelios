# 平台设计文档

`docs/design/` 描述 Themelios 当前生效的架构职责与公共契约，所有主题均随实现保持同步：

- [架构与包职责](architecture.md)：各工作区包的依赖层次、职责划分与独立嵌入方式。
- [运行与配置](runtime-and-config.md)：安装与实例目录、SQLite 排他实例锁、分层配置、重载资源绑定与诊断追踪。
- [存储与内容](storage-and-content.md)：同步 SQLite 事务与提交切面、CAS、材料采用与成果保存、`readable60` 标识、表示缓存及离线维护。
- [时间模型](time.md)：多域时间定义（`utc`、`linear`、`opaque`）、点比较与区间查询三值匹配。
- [模型与提示词](models-and-prompts.md)：网关连接与能力绑定、独立任务调用、Liquid 模板缓存及多模态输入准备复用。
- [业务操作与协议传输](operations-and-transports.md)：`Operation` 描述模型、可组合标准操作包、统一 HTTP/SSE/MCP/CLI 传输引擎与边界短引用桥接。
- [构建与发行](distribution.md)：工作区构建、`.tgz` 公共包闭包打包与可搬迁 Portable 发行包。
