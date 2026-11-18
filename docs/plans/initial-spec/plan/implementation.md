# 实施顺序沿完整能力的真实依赖推进

目标是在用户已配置的 Themelios 工作区实现独立通用平台，并交付正式包与 Portable。架构采用 Core、Runtime、Storage、Content、Models、Application、Transports 的单向依赖；公开合同和数据格式分别见 `contracts/`、`schema/storage.sql`。各单元的完成行为用于指导实现，不建立逐项审批或强制提交关卡。

## 依赖关系决定可并行的工作

| 实施单元 | 必须先有 | 可同时推进 | 交给后续单元的成果 |
| --- | --- | --- | --- |
| 工作区与公共值 | 当前本机工作区 | 原生发行可行性检查 | 包出口、Core 类型/Schema、AppError、Flow、时间值 |
| 运行与配置 | 公共值 | SQLite/CAS、独立模型 | Installation、Session、配置、Network、诊断 |
| SQLite 与 CAS | 公共值 | 运行与配置、模型连接 | 同步事务、提交 cut、不可变字节 |
| 通用时间域 | SQLite 与公共时间值 | Content | 时间映射、版本切面 |
| 材料与成果 | SQLite/CAS | Prompt/任务定义 | accept/read/save、来源、表示、原子采用 |
| 独立模型与 Prompt | 公共值；轻量 Network | Content | Models、Prompts、Tasks 定义和无实例调用 |
| 统一输入与任务执行 | Content、Models/Prompts | 协议 codec | 确定性准备、PDF扩展、run/runMany/stream |
| 应用与 CLI | 运行、内容、任务 | HTTP/MCP/gRPC | 完整文档工作台与操作目录 |
| 协议适配 | 操作目录、Flow | 独立库存应用 | 同一能力的真实网络客户端调用 |
| 维护与独立应用 | Runtime、Storage、Content | 协议、包发行 | 备份恢复、回收、库存应用 |
| 正式包与 Portable | 可运行 Application、Native | 目标平台构建可独立并行 | 外部安装与可搬迁的软件 |

前端 UI 与 Nous 业务不会成为任何单元的前置条件。CLI 工作台首先接通完整操作；其他入口消费它背后的相同能力。

## 工作区和公共值形成可用的包边界

**落点：** 根 package.json/bunfig.toml/tsconfig、现有检查脚本；`packages/core/src/{json,selection,completion,errors,flow,time}.ts`；各包 package.json 的 exports 与依赖。消费当前工具链，产出 [core.ts](../contracts/core.ts) 的全部合同。

实施动作：

1. 读取当前 package.json、bun.lock、Cargo.toml/Cargo.lock、tsconfig 和 check:repo，确定实际入口。对齐七包职责，保留已有正确设置，把 `@themelios/*` 工作区依赖指向正式 exports。
2. 在 Core 用 Zod 定义 Json、Range、Selection、Producer、Completed、SavedResult 和 ErrorInfo。将递归 ResultOutput 的运行期检查集中在内容/任务的入口；普通内部代码消费已经解析的类型。
3. 实现 AppError 与原因链，公共 ErrorInfo 只含 owner 明确公开的字段。补 UTC 规范化、bigint 文本格式、UTF-8 选区原语。
4. 实现单消费者 Flow 的惰性启动、一次终止 result、cancel/return 清理；实际 provider 调用和 Session lease 在对应 owner 接入。
5. 让 `@themelios/core` 的正式构建输出可被一个仓库外脚本 import；使用实际包归属检查跨包导入。确认合法包内 `../../` 继续可用。

**可观察结果：** 包类型和运行导出一致；JSON/选区错误给出具体字段；流消费 break 会进入清理。工作区现有 `bun run check:repo` 可以继续工作，当前包迭代用 `bun test packages/core/test`。

## 运行与配置提供真实可关闭的会话

**落点：** `packages/runtime/src/{installation,instance,session,execution,native}.ts`、`configuration/`、`network/`、`diagnostics/`；`native/runtime/`；runtime 词典。接口与启动顺序见 [installation-runtime.md](../spec/installation-runtime.md)、[configuration.md](../spec/configuration.md)、[observability-network.md](../spec/observability-network.md)。

实施动作：

1. 实现 Installation 路径解析和 ApplicationModule 的 provision/open 调用。init 在 staging 内创建完整当前实例并发布，open 检查应用/格式身份。
2. 通过 napi-rs 把 Rust File::try_lock/Drop 暴露为内部锁句柄；run/instance.lock 文件保持原位。CLI 加载本 worktree 本次构建的模块；在 Windows/Ubuntu 上验证第二次打开被拒绝、进程退出后可重新打开。
3. 从 runtimeSettings 和各应用 SettingsDefinition 组合单一 Schema；实现分层 TOML、来源说明、desired/effective、配置更新队列。按配置章的 prepare→原子文件保存→同步交换顺序接通 Network/Models 的实际资源。
4. 在根 Execution.run/flow 中捕获配置与资源集合，在真正 finally 中释放。复用根调用的信号与期限，SQLite 已提交的成功不会被晚取消覆盖。
5. 接通 env/file Secrets、一次请求 Network、Pino/文件轮换、OTel 和 i18next；早期启动错误直接走 BootstrapDiagnostics。只启用实际配置的导出和协议资源。
6. 实现停止接纳→取消/等待→逆依赖关闭，保留尚未真实停止的资源持有关系，关闭超时报告具体活动。

**可观察结果：** 同一配置修改可解释当前来源和生效状态；旧流完成期间继续使用旧模型/代理，新调用使用新设置；破损 TOML、占用实例、无效凭据和磁盘不可写能定位具体文件/字段。运行 `bun test packages/runtime/test`，Native 检查沿现有 Cargo 命令。

## SQLite 与 CAS 让一次保存具有确定完成点

**落点：** `packages/storage/src/{database,cas}.ts`、内部基础 DDL；`packages/storage/test/{transactions,cas}.test.ts`。消费 Core 与运行者给定路径，产出 [storage.ts](../contracts/storage.ts)。

实施动作：

1. 实现 Database.init/open；基础表 store_meta/commits 归 Storage；init 组合应用传入的公开模块 DDL；open 只检查当前格式。设置 strict/safeIntegers、WAL、FK、同步级别和 busy timeout。
2. 先接通 write 的 BEGIN IMMEDIATE、seq/recorded_at、同步回调、thenable 拒绝、COMMIT/ROLLBACK；再实现有快照 cut 的 read。借用的 tx/Statement 结束后失效。
3. 实现 Cas.put 的增量哈希、同卷临时文件、限额/取消、同步与原子发布；read 提供可取消流。源元数据留给 Content。
4. 用真实 SQLite 事务写两张业务表后主动触发约束错误，确认它们与 seq 一起回滚。验证 await 后的过期 tx 不能写入；发布后未采用的 CAS 仍可被维护命令识别。

**可观察结果：** 同内容得到同 BlobRef；正式引用只在后续事务成功后存在。`bun test packages/storage/test/transactions.test.ts packages/storage/test/cas.test.ts` 完成本单元的有价值检查，后续库存应用继续检验真实组合。

## 通用时间域从同一提交切面读取映射

**落点：** `packages/core/src/time.ts`、`packages/storage/src/time-domains.ts`、timeSchemaSql；`packages/storage/test/time-domains.test.ts`。消费 Database，产出 [time.ts](../contracts/time.ts) 的 TimeDomains。

实施动作：

1. 定义 domain/ticks/rate 的 Zod 格式及整数范围；实现 floorDiv/ceilDiv/gcd、同域 compareTime 和 UTC 毫秒规范化。
2. 按 [time.md](../spec/time.md) 实现 define、setMapping 的区间覆盖/左右拆分、removeMapping 和切面读取。所有修改使用当前 write.seq。
3. 实现正向转换与返回多个可能区间的逆向转换；暂停返回整段可能 UTC，空候选返回 []。
4. 用2倍速、暂停、原点之前、覆盖已有窗口及两个历史 cut 验证具体等式。其他模块只消费公开值与方法。

**可观察结果：** 新映射生效后旧 cut 仍返回旧关系，单调任务期限不受其影响。时间域可独立于任何认知对象使用。

## 材料与成果形成直接可用的内容模块

**落点：** `packages/content/src/{schema,materials,results,representations,text-structure}.ts`；Content DDL、公开 schema/locales；`packages/content/test/{materials,results,lifecycle,text-structure}.test.ts`。消费 Database/CAS，产出 [content.ts](../contracts/content.ts)。

实施动作：

1. 从 DDL 落实 artifacts、edges、roots、representations 和索引，导出 contentSchemaSql。实现 accept/prepare 的文件捕获、MIME/UTF-8/图像 extent、CAS 发布及 adopt。
2. 实现 inspect/read/text/list/export；read 流关闭真实文件句柄，text 严格执行 UTF-8 和 JSON Pointer 选区。结构读取接入 remark 并一次转换 UTF-16 offset。
3. 按 [content-results.md](../spec/content-results.md) 的保存算法处理 Completed 依赖：本次 WeakMap、递归顺序、结果/文件归一、CopyMap 字节检查、manifest 发布和一次 adopt。保存后的 `$value` 用 `/value` 选区。
4. 实现 results.read、sources、retain/release 和显式表示采用。读取结果依赖持久正文，模型和任务注册表可以完全缺席。
5. 连接一个两步完成值示例：先生成应用结果 A，再把 `{result:A}` 交给 B，最后只 save(B)。用 sources/read 回到 A 与原件，检查真实引用内容。

**可观察结果：** 未保存结果能直接被消费者使用；一次保存保留完整来源链；一个字节对象可以承载多个真实来源；删除独立 root 不破坏仍可达成果。Content 普通入口始终只有一个 accept/save 调用。

## 独立模型与 Prompt 先在普通脚本中工作

**落点：** `packages/models/src/models.ts`、`providers/`、`tasks/definition.ts`、`prompts/{compile,resources,reference}.ts`，模型配置与locale；`examples/embedded-summary.ts` 和任务资源。消费轻量 Network/Secrets，产出 [models.ts](../contracts/models.ts) 的 Models、Prompts 和 TaskDefinition。

实施动作：

1. 以 AI SDK 当前稳定 API 实现 openai、openai-compatible、google、cohere 适配器。显式传 baseURL/credential/fetch，公开操作保持 generate/stream/embed/rank/transcribe；maxRetries 由 provider 关闭，Models 管理唯一重试预算。
2. 固定 ModelBinding 能力与参数校验；生成把 Zod 输出交给结构化输出能力，最终结果再次验证。providerOptions 只进入命名提供者；不支持的结构和能力在实际请求前明确失败。
3. 实现单消费流，按当前 AI SDK 的流事件读取完成输出；提前退出取消 provider，流中途失败结束本次结果。embed 保持顺序/维度/空间，rank 保留原文档下标，transcribe 保留实际时间单位。
4. 用 LiquidJS 实现严格变量/过滤器、模板资源定位与完整 Prompt 管理。read/describe/diff/setOverride/reset 接通内置与实例覆盖；一次任务固定实际模板文本。
5. 定义 TaskDescription、输入/输出及 SourceDirectory Schema，生成可编辑参考。任务模板看到变量和目录元数据，材料 parts 由 Tasks 在后续统一追加。
6. 运行无 Instance/SQLite 的真实模型小脚本，得到结构值和用量；运行纯 Prompt 编译时不创建模型连接。真实请求用用户配置的 binding，测试用本地响应源只覆盖重试/取消等机械分支。

**可观察结果：** 开发者只读生成参考即可编辑 Prompt、了解 Schema 和能力需求。模型连接错误能定位 binding/connection/阶段，已完成值在无数据库环境中直接返回。

## 输入准备把文本、图像和 PDF 接到同一任务

**落点：** `packages/application/src/{inputs,preparation,tasks}.ts`、`extensions/pdf/src/`；图像确定性转换器；`packages/application/test/preparation.test.ts`。消费 Models、Prompts、Materials，产出 [input.ts](../contracts/input.ts) 的 Preparation/Textualize，以及低层 Tasks。

实施动作：

1. 实现 file/http 的 SourceAdapter，输出 Content.AcceptInput；http 使用共享 Network。调用内 source、extent 和短 key 固定，联合输入保持原顺序。
2. 实现 plan/prepare：从任务 needs 与选定 binding 的能力确定原生或转换路线；支持 JSON/text 选区、图像 orientation→crop→resize、PDF 页范围；生成 SourceDirectory、InputUse 和实际 ModelPart。
3. 采用 sharp 处理图像，PDF.js 实现文本提取与页图像；空白/扫描页按具体策略进入视觉路线或报告缺失能力。每次确定性转换返回普通 Completed，delivered 用 ResultOutput 引用它的文件。
4. 实现已配置的显式模型准备配方与独立 textualize：描述/转写任务也经过正式 TaskDefinition，最终把产物交回同一准备管线。preview 返回 pending，不执行付费准备。
5. 接通 run、stream、runMany。run 始终处理一个联合材料组；runMany 每项独立解析/准备/执行，结果按输入位置返回。取消停止未开始项，已完成项保留。
6. 用户模板渲染完毕后，程序按来源顺序追加一次短 key 与正文/媒体 parts。InputUse.delivered 与该实际 payload 同步形成，模型输出中的来源短键由 validateOutput 验证。

**可观察结果：** 一份原件可以原生送入、通过确定配方送入，或先描述再结构化；最后得到同一 Completed 形状。PDF 扩展通过正式注册接入，新增媒体转换只需新增相应适配器/任务。

## 工作台把完整能力交给用户与 Agent

**落点：** `packages/application/src/{application,operations}/`、`apps/workbench/src/main.ts`、工作台 ApplicationModule、内置任务和资源；`packages/transports/src/cli/`。消费已完成的 Runtime、Content、Models 与输入准备，产出 [application.ts](../contracts/application.ts) 和统一操作目录。

实施动作：

1. 由工作台模块组合设置、当前格式 DDL、资源与能力。provision 初始化实例；open 在同一个 Session 中绑定 Database、CAS、Content、Models、Prompts、Preparation 和 Tasks，关闭责任留在实际创建者。
2. 创建材料、成果、任务、Prompt、配置和实例信息的 Operation。每项绑定 input/output Zod、权限、说明与唯一执行函数；SDK 直接消费相同 owner，外部调用在 Operation 校验身份和请求。
3. 任务入口区分 persist=false 的 Completed 和 persist=true 的 SavedResult。先完成生成与动态来源校验，再按请求保存；保存失败返回该错误，调用不重新生成。
4. 接通 Commander 命令、`--input file|-`、机器 JSON、NDJSON 流和 stderr 诊断。普通文件导入、Prompt 导出/编辑与来源查看必须有可直接操作的短命令。
5. 从正式 Schema/metadata 生成任务变量、输出、材料需求、配置来源与操作帮助。模板的覆盖保存执行实际编译检查，TaskDescription 指向当前有效模板。
6. CLI 直接打开并关闭自己的 Session；实例被常驻宿主占用时显示具体 owner 和已配置端点。其他客户端通过明确开启的 HTTP/MCP/gRPC 操作同一常驻实例，配置在线更新走相同 configuration 操作。

**可观察结果：** 一个用户可以初始化实例、导入文本/图像/PDF、编辑并预览 Prompt、运行摘要、保存结果、查看来源、关闭并重新读取。同样的调用也能由非交互 Agent 完成；stdout 只含约定数据。

## 协议直接适配已经成立的应用操作

**落点：** `packages/transports/src/{wire,http,mcp,grpc}/`、`proto/themelios/v1/application.proto`、共同权限与错误映射。消费 Application Operation 与 Flow，产出 [transports.ts](../contracts/transports.ts)、[wire.ts](../contracts/wire.ts) 和真实监听器。

实施动作：

1. 实现 wire 编解码：base64 bytes、十进制提交位置、递归 Completed/ResultOutput、SavedResult 的精确选择器。限制整个编码后的 JSON 大小，超限错误指向 Selection/persist 的可用路径。
2. 在 Hono/Bun.serve 挂载 JSON 与二进制路由。上传直接进入有界 Content.accept；下载与 SSE 使用真实流，客户端断开关闭底层 reader/iterator。
3. 用当前 MCP 官方 SDK 注册工具和资源，生成的输入说明来自 Operation 与 TaskDescription。接通 stdio 和同一 HTTP `/mcp`；EOF/cancel 结束该连接的工作，stdout 留给协议。
4. 将本包 proto 落入仓库并生成 protobuf-es 类型；显式 codec 保留可选字段与 null。Connect-Node 运行在 Bun 的 node:http2 监听器，真正处理上传/下载分块和 server streaming。
5. 入口建立 Principal、固定语言/期限，按同一权限目录调用 Operation；错误按精确 code 映射 HTTP/gRPC/MCP，不在 handler 重写业务规则。
6. 用真实客户端消费同一个已保存材料和任务。分别验证开始响应前失败、已发送流后失败、主动取消和 deadline；gRPC 检查实际 status/trailers。

**可观察结果：** SDK、CLI、HTTP、MCP、gRPC 的同一请求共享业务结果与错误 code，差异只在各自协议编码。真实网络与 Native 的较早接通顺序见 [distribution.md](distribution.md)。

## 离线维护与库存应用检验存储组合

**落点：** `packages/application/src/maintenance.ts`、Storage 备份/校验原语、Content 回收查询、`examples/inventory/`。消费实例排他锁、Database、CAS、Content；对外使用 `storage backup/restore/collect/verify/migrate` 命令和库存应用自己的业务 API。

实施动作：

1. 为维护打开最小资源集合，先拿同一实例锁，不启动模型和服务。备份用 VACUUM INTO 后从快照枚举对象，复制并复核 CAS、配置和 Prompt 覆盖，最后发布整个目标目录。
2. 恢复到不存在的实例目标，检查身份/当前格式/SQLite/哈希后再发布。verify 检查实际引用、长度与哈希，并报告具体失败对象。
3. 按 Content 的根与边实现回收查询。一个事务提高 history_floor 并删除不可达元数据，随后移除无引用 CAS；删除失败保留准确报告，下一次继续清理。
4. 使用 [库存示例](../examples/inventory/README.md) 的业务表、解析器与应用定义。`prepared.adopt(tx)` 和业务版本更新在同一个同步事务内执行；查询按一个 cut 读取当前量或历史量，导出实际 CSV 原件。
5. 在库存导入的最后一行触发真实 SQLite 约束失败，检查前面写入的业务行、材料引用和 seq 一起回滚。再次正常导入后，按两个 cut 读取不同库存并回到对应来源。
6. 直接更新本期开发格式和全部消费者。只有用户确实需要保留某个已知旧数据格式时，补相应离线源→目标迁移程序及字段映射；普通 open 始终检查当前格式。

**可观察结果：** Themelios 能服务普通业务数据应用，保存与事务接口无需借用 Nous 概念。备份恢复后的结果和来源完整；物理清理只删除已经越过保留界线且无正式引用的对象。

## 正式发行完成独立平台的交付

**落点：** 包构建/打包脚本、Native 构建、Portable 启动器和 staging，详见 [distribution.md](distribution.md)。消费完整工作台和正式包出口，产出当前版本的 tgz、Windows x64 和 Linux x64 glibc Portable。

实施动作：

1. 产出各包 ESM、声明、语言/Prompt/Schema 资源及 runtime Native，逐个 exports 指向本次真实文件。
2. 在仓库外安装本批 tarball，执行独立模型脚本和库存应用。包消费者有自己的 manifest/lockfile，整个运行过程不解析 Themelios 源码目录。
3. 在新 staging 用固定 lockfile 组装应用闭包、生产依赖与目标 Bun；携带 sharp 等 Native 共享库、PDF 资源和许可。启动器固定 installation root，并关闭运行时自动安装依赖。
4. 分别在目标 Windows/Ubuntu 执行 [完整验收路径](verification.md)。移动目录后再读取已保存结果、导出原件并使用各协议；开发者运行时与源码对该运行不可见。
5. 交付可复用的运行说明和真实执行结果。把实际发现的限制写在相应功能或平台旁，定位到命令、依赖或输入；移除被替换的旧实现和专属文档。

**可观察结果：** 一个普通应用能安装 Themelios，一位用户能解压并使用独立工作台。此时本期完成；Nous 和 Nexus 在各自后续任务中消费已经交付的能力。

## 调整施工粒度时保持依赖和完成行为

实现者可以合并同一 owner 的相邻步骤、把互不共享修改的工作并行、根据实际代码改变私有文件名或成熟依赖的接入写法。公共值、保存完成点、资源生命周期、能力边界和上述真实使用路径保持稳定。

当具体运行时接缝受阻，先完成最小复现、确认已锁版本和官方支持用法，再修该适配器。仍受阻时记录可复现命令与实际影响，继续所有不依赖该接缝的单元。最终未完成路径如实列出；本计划不把跳过的验证写成已通过。
