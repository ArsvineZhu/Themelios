# 存储与内容

## 同步事务与提交切面

`@themelios/storage` 对写操作强制使用同步 SQLite 短事务 `database.write(tx => ...)`：

- 每次写事务在 `commits` 中登记单调递增的提交序号与登记时间，供 `tx.seq`、`tx.recordedAt` 和材料登记时间读取。历史下界单独表示仍可查询的最早切面。
- 禁止在事务回调中返回 Promise 或保留游标，事务结束时借出的 SQL 句柄与未完成游标立即失效，防止异步悬空事务破坏原子性。
- `database.read` 提供 SQLite 的读快照及其中的最新提交序号 `tx.cut`。`database.cut()` 返回该序号的十进制字符串。查询历史时，在同一读事务中用 `resolveCut` 校验所选切面，再按业务表的有效区间读取对应记录。

## CAS 与内容表模式

完整 DDL 由 [Storage 模式](../../packages/storage/src/schema.ts)和 [Content 模式](../../packages/content/src/schema.ts)定义。`Database.init` 在同一次初始化中安装 Storage 模式和应用传入的模式。使用 Application 时，应用传入的模式由 Content 模式与业务 DDL 组成。

- `Cas` 按字节内容 SHA-256 寻址存储于 `<instance>/objects/sha256/<hh>/<rest>`。写入先流式计算摘要并同步暂存，再以独占操作发布；同一字节只存一份。Windows 使用同卷独占移动，其他平台使用硬链接。
- `@themelios/storage` 的核心表包含 `store_meta`、`commits`、`time_domains` 与 `blobs`。`blobs` 记录正式对象的哈希和字节数。应用在事务中使用 `tx.registerBlob(blob)` 登记 `Cas.put()` 返回的对象，在同一事务写入具有 `REFERENCES blobs(ref)` 的拥有行。可为空的外键列取 NULL 时不持有对象。同一对象可由任意数量的业务表与内容行共同持有。
- `@themelios/content/schema` 增加以下内容表：
  - `artifacts` 记录材料身份、原件元数据、对象地址及登记提交。
  - `artifact_edges` 从已保存成果投影有序的输入、文件和上游成果依赖。每条边以外键确定目标身份，并保存可选的原件选区。
  - `artifact_retention` 记录显式保留的开始和释放切面。`materials.listRetained({at})` 枚举该切面的保留目录，业务采用的材料由相应应用查询。
  - `representations` 按原件选区、用途和配方索引当前可复用的派生结果。已保存稿件从自己的来源图读取当时交付的内容。

## 材料采用、选区与成果保存

- `materials.accept` 和 `results.save` 提交并保留独立材料和成果。`materials.adopt` 与 `results.adopt` 在登记内容的同一事务中由同步回调写入业务拥有行，并返回回调结果。`materials.adoptAnalyzed` 可先读取本次捕获原件的字节做分析，再将分析结果交给同一提交中的写入回调。
- **精确坐标**：文本选区使用原件 UTF-8 字节边界（禁止跨多字节字符）；Markdown 分块返回带原始文本范围的结构数组；PDF 与图像选区基于页码及朝正后的像素坐标矩形。
- **原件元数据**：导入时探测已捕获的原件。`createContent` 接收媒体适配器以测定额外的页数和时长，已知尺度随材料保存。在可用的解码器无法测定时，尺度为未知。
- **成果图闭合保存**：`results.save(completed)` 归一化整个 `Completed`（包含尚未入库的内联 `InlineMaterial` 与嵌套上游 `Completed` 计算值），在一次事务内原子写入全部生成节点、产生文件、来源边与最终 `SavedResult`。保存后的成果可直接作为下游任务输入，且在模型连接断开或实例搬迁后依旧可读。
- 随成果自动登记和显式调用 `representations.set` 使用同一约束，输出必须来自成果中对应的原件选区。`representations.read` 按原件选区、用途和配方读取可复用的成果和输出名。规范化配方参数、辅助模型绑定及模板内容决定配方身份。更新或移除索引只影响下次复用，历史成果仍按自己的来源关系读取原始交付。

## 双层标识：`art_<uuid>` 与 `readable60`

- **系统与存储主标识**：内部表、SDK、HTTP REST 路径与持久数据始终使用全局唯一的 UUIDv4 引用 `art_<uuid>`。
- **Agent 短引用**：每条 `artifacts` 记录在采用或插入时同时分配互不重复的 60 位随机编码 `agent_code`。`@themelios/core` 从固定的 1,024 项 tokenizer 码表编码六个四字母单元，组成 `art_` 加 24 个 ASCII 字母，例如 `art_userFilefileListUseritem`。大小写是编码的一部分，复制、传输与解析均保留原样。
- **双向解析**：`materials.resolve(refOrAgentRef)` 接受任意一种合法引用并解析为规范 `art_<uuid>`；`materials.agentRef(ref)` 返回对应短引用。在无数据库的独立工具场景下，可以使用 `@themelios/core` 的 `createAgentRefBook()` 在会话内存内双向映射。

## 离线维护

`backupStorage({ instanceRoot, destination })` 从离线实例读取身份、数据库与 CAS，通过一致的 SQLite 快照确定业务外键持有的对象，并构建 `themelios.backup` 目录。备份可选取实例 `config/` 下的应用文件，默认选取已知的实例配置、托管配置及提示词。`restoreStorage` 校验归档并恢复到新目标，`verifyStorage` 检查库与对象，`verifyContent` 再检查内容图。

恢复按共享安装配置路径协调最终发布。已有相同配置时可重复采用。需要写入新配置时，锁覆盖配置写入、实例发布，以及发布失败时对本次写入的撤回。

`collectStorage(database, cas, {retainSince, prune, signal})` 可在推进历史下界的同一事务调用业务清理函数，再回收没有拥有行的对象。`collectContent` 在 `prune` 之后，从业务表 `REFERENCES artifacts(ref)` 的持有关系及与可查询历史相交的显式保留区间出发，沿内容来源边和当前表示计算可达性。材料释放后立即退出当前保留目录，在历史下界到达释放切面时退出历史目录。应用在 `prune` 中移除过期业务行，同一材料的其余拥有行继续保留材料。原始字节外键的拥有行由 Storage 直接识别。回收返回已提交的 `historyFloor`，并在取消或遇到文件系统错误时返回 `sweepComplete: false`。文件系统错误按路径列在 `problems` 中。备份和恢复在正常取消或失败后移除各自的私有暂存目录。
