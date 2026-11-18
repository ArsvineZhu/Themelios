# 存储与内容

## 同步事务与提交切面

`@themelios/storage` 对写操作强制使用同步 SQLite 短事务 `database.write(tx => ...)`：

- `tx.seq` 在进入写事务时分配单调递增正整数提交序号，并写入 `commits(seq, recorded_at)`。
- 禁止在事务回调中返回 Promise 或保留游标，事务结束时借出的 SQL 句柄与未完成游标立即失效，防止异步悬空事务破坏原子性。
- 查询使用 `database.cut()` 获取最新提交序号（字符串表示的 64 位整数），或通过历史 `cut` 读取一致性快照。

## CAS 与内容表模式

- `Cas` 按字节内容 SHA-256 寻址存储于 `<instance>/objects/sha256/<hh>/<rest>`，写入先流式计算摘要与临时落地，再以不可变链接发布；同一字节天然去重。
- `@themelios/storage` 的核心表包含 `store_meta`、`commits` 与 `time_domains`；`@themelios/content/schema` 增加以下内容表：
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
- **Agent 短引用**：每条 `artifacts` 记录在采用或插入时同时分配互不重复的 60 位随机编码 `agent_code`，使用 `@themelios/core` 内置的 1,024 词 4 字母英文码表编码为 24 字符短串（`art_<24个小写字母>`，例如 `art_thatwiththishavefromyour`）。
- **双向解析**：`materials.resolve(refOrAgentRef)` 接受任意一种合法引用并解析为规范 `art_<uuid>`；`materials.agentRef(ref)` 返回对应短引用。在无数据库的独立工具场景下，可以使用 `@themelios/core` 的 `createAgentRefBook()` 在会话内存内双向映射。

## 离线维护

`backupStorage` 使用 SQLite 在线一致性快照与硬链接/拷贝构建独立自洽的 `themelios.backup` 归档目录（含对象文件与配置快照）；`restoreStorage` 按目标格式与对象校验恢复到全新实例；`verifyStorage` / `verifyContent` 检查对象完整性与关系约束；`collectStorage({ retainSince })` 推进历史下界 `history_floor` 并安全回收未再被引用的历史材料及 CAS 对象。
