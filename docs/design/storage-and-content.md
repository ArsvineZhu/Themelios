# 存储与内容

## 同步事务与提交切面

`@themelios/storage` 对写操作强制使用同步 SQLite 短事务 `database.write(tx => ...)`：

- `tx.seq` 在进入写事务时分配单调递增正整数提交序号，并写入 `commits(seq, recorded_at)`。
- 禁止在事务回调中返回 Promise 或保留游标，事务结束时借出的 SQL 句柄与未完成游标立即失效，防止异步悬空事务破坏原子性。
- 查询使用 `database.cut()` 获取最新提交序号（字符串表示的 64 位整数），或通过历史 `cut` 读取一致性快照。

## CAS 与内容表模式

- `Cas` 按字节内容 SHA-256 寻址存储于 `<instance>/objects/sha256/<hh>/<rest>`。写入先流式计算摘要并同步暂存，再以独占操作发布；同一字节只存一份。Windows 使用同卷独占移动，其他平台使用硬链接。
- `@themelios/storage` 的核心表包含 `store_meta`、`commits`、`time_domains` 与 `blobs`。`blobs` 记录正式对象的哈希和字节数。应用在事务中使用 `tx.registerBlob(blob)` 登记 `Cas.put()` 返回的对象，在同一事务写入具有 `REFERENCES blobs(ref)` 的拥有行。可为空的外键列取 NULL 时不持有对象。同一对象可由任意数量的业务表与内容行共同持有。
- `@themelios/content/schema` 增加以下内容表：
  - `artifacts`：保存实体主键 `ref`（`art_<uuid>`）、Agent 短码 `agent_code`（唯一索引）、类型 `kind`（`material` / `result`）、`media_type`、`blob_ref`、`size_bytes`、`name`、`extent_json`、`origin_json`、`created_seq`、`created_at`。
  - `artifact_edges`：记录有向来源图（`relation` 为 `'input'` / `'file'` / `'representation-source'`，`ordinal` 保序）。
  - `artifact_roots`：记录显式保留根与释放切面，用于历史可达性分析与垃圾回收。
  - `representations`：按原材料、选区、用途和生效配方索引已保存的派生结果，关联成果引用和有序输出列表。

## 材料采用、选区与成果保存

- **原子组合写入**：`materials.prepare(input)` 异步完成字节校验与 CAS 落盘后返回 `PreparedMaterial`；应用随后可在同一 `database.write(tx => { const sel = prepared.adopt(tx); ... })` 事务中将材料采用与业务表写入共同提交或共同回滚。
- **精确坐标**：文本选区使用原件 UTF-8 字节边界（禁止跨多字节字符）；Markdown 分块返回带原始文本范围的结构数组；PDF 与图像选区基于页码及朝正后的像素坐标矩形。
- **成果图闭合保存**：`results.save(completed)` 归一化整个 `Completed`（包含尚未入库的内联 `InlineMaterial` 与嵌套上游 `Completed` 计算值），在一次事务内原子写入全部生成节点、产生文件、来源边与最终 `SavedResult`。保存后的成果可直接作为下游任务输入，且在模型连接断开或实例搬迁后依旧可读。
- **登记与复用**随成果图在同一事务登记本次使用的新派生表示。预览和执行可读取匹配表示。原始选区、规范化配方参数、辅助模型绑定及模板内容决定复用条件。

## 双层标识：`art_<uuid>` 与 `readable60`

- **系统与存储主标识**：内部表、SDK、HTTP REST 路径与持久数据始终使用全局唯一的 UUIDv4 引用 `art_<uuid>`。
- **Agent 短引用**：每条 `artifacts` 记录在采用或插入时同时分配互不重复的 60 位随机编码 `agent_code`。`@themelios/core` 从固定的 1,024 项 tokenizer 码表编码六个四字母单元，组成 `art_` 加 24 个 ASCII 字母，例如 `art_userFilefileListUseritem`。大小写是编码的一部分，复制、传输与解析均保留原样。
- **双向解析**：`materials.resolve(refOrAgentRef)` 接受任意一种合法引用并解析为规范 `art_<uuid>`；`materials.agentRef(ref)` 返回对应短引用。在无数据库的独立工具场景下，可以使用 `@themelios/core` 的 `createAgentRefBook()` 在会话内存内双向映射。

## 离线维护

`backupStorage` 通过一致的 SQLite 快照确定业务外键实际持有的对象，构建 `themelios.backup` 目录。备份可选取实例 `config/` 下的应用文件，默认选取已知的实例配置、托管配置及提示词。`restoreStorage` 校验归档并恢复到新目标，`verifyStorage` 检查库与对象，`verifyContent` 再检查内容图。

恢复按共享安装配置路径协调最终发布。已有相同配置时可重复采用。需要写入新配置时，锁覆盖配置写入、实例发布，以及发布失败时对本次写入的撤回。

`collectStorage(database, cas, {retainSince, prune, signal})` 可在推进历史下界的同一事务调用业务清理函数，再回收所有拥有行已解除的对象。`collectContent` 先执行应用提供的 `prune`，再按内容根、边和表示记录计算材料可达性。持有 `artifacts(ref)` 的应用行应当随材料保留，已过期的业务行可在该清理函数中移除。原始字节外键的拥有行由 Storage 直接识别。提交后收到取消信号时，回收返回已保留的 `historyFloor`，并用 `sweepComplete: false` 标明尚可重试的字节清理。备份和恢复在正常取消或失败后移除各自的私有暂存目录。
