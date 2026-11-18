# SQLite 提交事实，CAS 保存不可变字节

本章实现位置为 `packages/storage/src/{database,cas,backup,maintenance}.ts`。公共声明见 [storage.ts](../contracts/storage.ts)，完整初始化表结构见 [storage.sql](../schema/storage.sql)。业务材料表由 Content 拥有，Storage 负责事务、字节、提交顺序及离线维护。

## 数据库直接使用 Bun 的 SQLite 驱动

采用 `bun:sqlite` 的预编译语句和同步事务。固定的少量平台表用 SQL 定义，DAO 用驱动原生的类型参数描述行与绑定参数；实际输入和 JSON 持久正文由 Zod 校验。这个方案保留 SQLite 的完整行为，应用也能在同一事务内写自己的表。

`Database.init({path,formatId,schemaSql})` 只接受不存在的目标数据库，在当前目录下建立临时数据库，先创建 Storage 自有的 store_meta/commits，再执行传入 schemaSql、写 store_meta，最后关闭并发布为目标文件。父实例目录的排他锁由 Runtime 持有；独立调用者负责唯一初始化者。目标已存在时报 `storage.already_exists`。`Database.open` 用 `create:false` 打开，读取 format_id，不执行 DDL；格式不匹配报 `storage.format_mismatch`，包含 expected/actual 与文件位置。

DDL 汇总文件按实际所有者切分：`@themelios/content/schema` 导出 `contentSchemaSql`，含 artifacts、artifact_edges、artifact_roots、representations；`@themelios/storage/time` 导出 `timeSchemaSql`，含 time_domains、time_mappings。应用将自己需要的模块 DDL 与业务表 DDL 组合传给 init。模块提供自身当前格式的 SQL，消费者通过公开出口取得。

连接设置如下：

| 项目 | 值与用途 |
| --- | --- |
| driver | `strict:true, safeIntegers:true`，遗漏绑定报错，整数读取为 bigint |
| 写连接 | WAL、foreign_keys=ON、synchronous=FULL、busy_timeout=5000ms |
| 读连接 | 同一文件，readonly=true，foreign_keys=ON；只读实例仅创建它 |
| WAL checkpoint | 默认 SQLite 自动 checkpoint，关闭时完成可执行的 checkpoint；它不改变业务完成状态 |
| 表名/标识符 | 程序定义的静态 SQL；用户值全部绑定参数 |

DatabaseOptions.synchronous 默认为 FULL。工作台把有效 `storage.synchronous` 传入新建连接；显式 NORMAL 采用 SQLite 对该模式的持久性保证，并在配置说明中解释其断电损失窗口。已有连接在重启后取得新值。

启动记录实际 `sqlite_version()` 供故障定位。实例存放在本机支持文件锁的文件系统；WAL 的共享内存机制要求同一主机。[Bun SQLite](https://bun.sh/docs/runtime/sqlite)、[SQLite WAL](https://sqlite.org/wal.html) 是实现依据。

## 一个写事务产生一个提交位置

`write(work)` 按下面的唯一顺序执行：

1. 检查数据库仍打开且可写，调用方已经完成异步准备。
2. 在写连接执行 `BEGIN IMMEDIATE`，读取并递增 store_meta.commit_seq，取得 seq。
3. 用本次 UTC 时钟值向 commits 插入 `{seq,recorded_at}`；构造只在当前回调期间有效的 WriteTransaction。
4. 执行同步 work。所有材料记录、来源边、根引用和业务行在这个 tx 内写入。
5. work 正常返回后检查返回值不是 Promise/thenable，再 COMMIT；任何异常执行 ROLLBACK，seq 和业务行一起回滚。
6. 使 tx 失效，再将 work 的返回值交给调用者。

回调中的 sql 是对成熟驱动连接和 Statement 的借用视图。query/prepare 得到的 Statement 在调用 get/all/run/iterate 时检查 tx 仍有效；回调结束后使用它报 `storage.transaction_closed`。这样误用 async 回调时，首个 await 前的写入回滚，后续恢复的代码也无法继续通过过期 tx 写入。底层 SQL 编译缓存仍由 Bun 维护。

read(work) 在只读连接执行显式读事务，第一次读取 store_meta 时确定快照及 cut，回调返回完整值后结束事务。读取游标在回调内部消费成普通数组/对象。一个回调内部组合 DAO 时直接传 tx；重新进入 Database.read/write 报 `storage.transaction_nested`，事务边界仍在最外层实际操作。

`cut()` 返回当前已提交 seq 的十进制字符串。seq 表示这个数据库内的提交顺序；recorded_at 表示记录动作的 UTC 时间。系统时钟向后调整时，seq 继续递增，历史先后由 seq 决定。

事务提交是正式保存的完成点。公共操作在进入同步事务前检查 AbortSignal；COMMIT 成功后返回已保存结果。数据库回滚时，任何引用都没有正式提交。

## CAS 发布采用同卷临时文件与精确字节哈希

对象路径固定为 `objects/sha256/<前两位>/<其余62位>`，临时文件放 `objects/tmp/`。MIME、来源和文件名不进入 CAS 身份；两个来源的相同文件共享字节，但在 artifacts 中保留各自的材料记录。

`Cas.put` 实施步骤：

1. 流式读取 Uint8Array 或 ReadableStream，增量计算 SHA-256，累计 sizeBytes，并执行本次最大字节限制和取消检查。文件来源在 Content.prepare 中先打开句柄，再使用该句柄完整读取。
2. 将数据写到随机名称的同卷临时文件。哈希结束后 flush/fsync 并关闭文件。
3. 创建哈希分片目录；目标已存在且长度匹配时复用它。否则原子 rename 临时文件到最终路径。并发同内容发布遇目标已经存在时按同一长度规则复用；其他错误报 `storage.write_failed`。
4. 在支持目录同步的平台同步父目录，然后返回 BlobInfo。失败/取消清理当前临时文件；程序崩溃遗留的 tmp 由离线维护清理。

一个成功的 put 表示精确字节已发布。正式保存继续执行 SQLite 事务，把 blob_ref 记录进 artifacts。发布后事务失败只留下未引用字节，后续读取只通过正式数据库引用取得它。

`read(ref,{start,end})` 只接受合法 SHA-256 引用及有效半开字节范围；流取消会关闭文件句柄。stat/read 遇缺失对象分别报 `storage.blob_missing`，读取异常带 blobRef 和实际路径。哈希复核属于显式 `storage verify` 或备份复核；普通读取使用原文件，避免每次读都扫描整个对象。

CAS 的跨平台故障行为以本期 Windows/Ubuntu 的文件系统调用验证为准：发布只使用同卷路径；原子替换完成后才可被引用；失败不写 artifacts。Native 的实例锁保证维护与运行会话互斥，字节写入不需要再维护一套锁租约。

## 维护通过离线入口取得同一把实例锁

CLI 提供 `themelios storage backup <destination>`、`restore <backup>`、`collect [--retain-since CUT]`、`verify` 和 `migrate`。backup/collect/verify 先定位现存实例、取得 Runtime 的同一系统文件锁，再打开仅供维护使用的数据库/CAS。正常服务占用实例时返回 `runtime.instance_busy`；操作者停止服务后执行维护。restore 的目标尚不存在，按 Instance.init 的同父目录 staging 规则发布；在目标中提前创建锁文件会破坏这一条件，因此恢复只检查目标不存在。迁移读取现存源实例时取得源实例锁，目标沿用相同新建发布规则。

维护入口位于 `packages/application/src/maintenance.ts`，直接装配 Storage 所需资源，避免启动 Models、远程监听器和普通任务。离线维护的路径、格式校验和日志使用同一 Runtime 基础能力。直接使用独立 CAS 的应用只取得 put/read/stat；删除对象由其所属存储集合统一负责。

## 备份从数据库快照决定需要复制的对象

`backup(destination)` 要求目标不存在。它在目标父目录建立随机 `.partial` 目录，执行以下顺序：

1. 在已取得实例锁的维护连接执行 `VACUUM INTO ?`，得到 `state/main.sqlite`。VACUUM INTO 产出一致快照；复制原数据库主文件会遗漏 WAL 中的数据，因此备份使用 SQLite 的正式能力。[SQLite VACUUM](https://sqlite.org/lang_vacuum.html)
2. 从这份快照读取 format_id、cut、全部 artifacts 的不同 blob_ref，以及应用配置/Prompt 覆盖资源列表。
3. 逐个复制 CAS 对象，流式计算哈希与长度并与数据库记录比较；不匹配时报 `storage.blob_corrupt`，保留原实例。
4. 复制 instance.json、实例 TOML、受管理 Prompt 覆盖；另把安装层 TOML 原文保存为备份根的 installation-config.toml。凭据文件及环境变量由操作者在恢复环境配置，备份保留引用；相对路径在恢复后的对应配置目录重新解析。
5. 对快照运行 `PRAGMA quick_check` 和 `foreign_key_check`，写 `backup.json`：`format:'themelios.backup/1'`、applicationId、instanceId、formatId、cut、createdAt、artifacts/blobs/bytes；installationConfig 为 `{present:boolean,sha256?:string}`，声明安装层文件的实际存在与哈希。
6. 关闭所有句柄后将 `.partial` 原子重命名为 destination。中断留下带 `.partial` 的未完成目录，下一次命令使用新的目标或明确清理它。

restore 在不存在的目标实例旁创建 staging，验证清单、格式、SQLite 和每个被引用对象，再复制并发布整个实例目录。恢复保留实例身份与材料引用；克隆为另一个正式身份属于未来明确的导入操作。目标有现存资料时返回 `storage.already_exists`，由操作者先选择新的目标路径。

恢复同时处理备份声明的安装层：目标已有相同字节时直接使用；目标没有而备份有时，在发布实例前排他写入对应 installation.toml。目标安装已有不同设置，或备份没有而目标额外具有安装设置时，返回 `config.invalid`，指出安装层差异及目标配置位置，操作者选择新的安装根或先明确整理配置。本操作保持既有人工文件原样。失败清理仅限本次创建的 staging 及本次新建且未被修改的安装配置；复制的 Prompt/实例配置随实例一起发布。

## 根引用和历史保留共同决定回收

artifacts 的内容不可变；`artifact_roots` 记录材料被应用保留的区间。accept/save 的顶层结果自动成为当前根；内部生成的依赖由结果来源边保持可达。`materials.release(ref)` 结束当前保留区间，`retain(ref)` 建立新的区间。当前列表按有效根显示，已有正式引用仍可继续读取直到明确的物理清理。

`history_floor` 初始为 0。collect 默认保留当前 floor 以来所有历史；指定 `--retain-since CUT` 才提高 floor，且 oldFloor≤CUT≤当前提交位置。请求早于 floor 的历史列表报 `storage.history_unavailable`，错误带最早可用 cut。即使材料的独立根已释放，仍被保留成果引用的原件继续保存。

具体收集算法在排他维护期间执行：

1. 建立临时 keep_artifacts 表。以 `released_seq IS NULL OR released_seq > newFloor` 的所有根为种子。
2. 从已保留 owner 沿 artifact_edges 加入 target；从已保留 source 沿当前或 newFloor 以来仍有效的 representations 加入 result。重复 `INSERT OR IGNORE` 直到无新增，或用等价递归 CTE 一次完成。
3. 在一个 SQLite 写事务内删除已过保留期的根/表示区间、未保留对象涉及的来源边、未保留 artifacts，并更新 history_floor。提交期间 FK 检查保持启用，删除顺序为表示/边/根→artifact。
4. 从提交后的 artifacts 取得全部不同 blob_ref；扫描 CAS 删除未被引用的对象与崩溃遗留 tmp。删除失败记录具体路径并返回计数及问题，已经清理的数据库事实保持有效，下一次 collect 可以继续清理残留字节。

这个顺序使中断后最多留下无引用文件。提交数据库前始终保留原件。SQLite 与独立文件之间没有虚构的跨资源事务。

## 迁移程序只处理真正需要保留的数据

正常 init/open 支持当前 formatId。开发中修改内部格式时直接更新初始化 DDL 和消费者；测试实例重新初始化。用户要求保留某份旧数据时，提供独立 `tools/migrations/<from>-to-<to>.ts`，命令输入 `--source`、`--destination`，输出新实例；源文件只读。

迁移程序按具体旧格式解析材料/业务行，发布目标 CAS，写当前格式，检查引用完整性，再原子发布目标目录。明确给出实际字段映射和无法迁移的数据；只有在已知源格式确实存在时编写该迁移器。应用启动路径始终只包含当前格式检查。

## 五条存储操作验证实际责任

| 操作 | 必须观察到的结果 |
| --- | --- |
| 事务中写业务行后抛错 | 业务行、材料记录、来源边和 commit_seq 一起回滚 |
| async 回调在 await 后尝试使用 tx | 调用报 `storage.async_transaction`；过期句柄报 `storage.transaction_closed`；没有后续写入 |
| CAS 发布后模拟 SQL 约束失败 | 没有正式材料；离线 collect 清理孤立字节 |
| 两个不同原件拥有相同字节 | 两个 ArtifactRef、一份 BlobRef；释放一个根不影响另一个 |
| 备份、搬到新目录、恢复并读取 | 数据/引用/Prompt 覆盖一致；打开旧格式时给出准确错误 |

测试集中在 `packages/storage/test/transactions.test.ts`、`cas.test.ts`、`backup.test.ts`，Content 的引用回收场景在 `packages/content/test/lifecycle.test.ts`。使用临时真实 SQLite 和文件目录；磁盘权限/占用、Windows 原子发布和实例锁在对应操作系统运行。
