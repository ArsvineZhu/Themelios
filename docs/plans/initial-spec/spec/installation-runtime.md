# 安装、实例与会话共同管理真实资源

本规范实现 `@themelios/runtime` 的安装定位、实例创建、运行会话和取消；应用装配由 `@themelios/application` 完成。公开签名见 [runtime.ts](../contracts/runtime.ts)。模型与模板的独立使用直接调用各自包，只有需要实例目录、配置文件和长期状态时才创建 Installation。

## 安装布局同时包含程序与实例数据

Portable 发行采用下列固定位置；包内依赖和资源的具体发布规则见 [build-release.md](build-release.md)。

| 路径 | 内容与所有者 |
|---|---|
| `themelios`、`themelios.cmd` | 定位自身目录并启动自带 Bun 的入口；保留调用者 cwd |
| `runtime/bun`、`runtime/bun.exe` | 固定版本 Bun |
| `app/release.json` | 安装的应用 ID、发行版本、平台、入口和实例格式 |
| `app/packages/*/{dist,resources,native}` | 正式包产物；Native 只存在于实际需要的包 |
| `app/apps/workbench/dist/` | 独立文档工作台入口 |
| `app/node_modules/` | 目标平台生产依赖 |
| `config/installation.toml` | 安装层人工设置 |
| `instances/<name>/instance.json` | 稳定实例身份及其当前格式 |
| `instances/<name>/config/{instance,managed}.toml` | 实例人工设置、程序管理的覆盖 |
| `instances/<name>/config/prompts/` | 模板覆盖 |
| `instances/<name>/state/`、`objects/` | 数据库与 CAS |
| `instances/<name>/cache/`、`logs/`、`run/` | 可重建缓存、诊断文件、当前会话信息 |

`Installation.at(root, application)` 将 `root` 解析为绝对安装根。`configRoot` 默认 `<root>/config`，`dataRoot` 默认 `<root>/instances`；系统安装通过第三参数显式传入平台安装器选择的目录。库不根据环境变量猜测另一套数据目录。

`installation.instance(name)` 接受 `[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}`，定位到 `dataRoot/name`。`installation.external(root)` 显式绑定其他位置的同应用实例；两者得到同一种 Instance 对象。外部目录不需要追加一份安装登记数据库。

路径基准固定如下。

| 路径来源 | 解析基准 |
|---|---|
| 包内翻译、模板、Schema | 包的正式资源目录或 `import.meta.url` |
| release.json 的文件位置 | 安装根 |
| 实例的标准子目录 | 实例根 |
| TOML 中的路径与 `file:` 凭据 | 最后提供该叶值的 TOML 文件目录 |
| SDK 的相对文件输入 | 调用时显式传入的 baseDir，默认构造该客户端时的 cwd 快照 |
| CLI 文件输入与导出 | 该次 CLI 的原始 cwd |
| 远程文件输入 | 协议上传字节；服务器无客户端路径解释责任 |

移动完整 Portable 目录后，实例 ID、材料引用和结果引用保持不变。正式引用和数据库记录采用逻辑身份；路径解析只在当前安装的边界发生。

## Instance 创建与打开是两项明确操作

`instance.init()` 创建当前格式，返回 `InstanceInfo`。`instance.open()` 打开已初始化的同应用实例，返回带 `api`、`configuration` 和 `close()` 的 Session。默认 `mode='read-write'`；`read-only` 用于查看与导出。两种模式都持有实例独占锁，避免读流与维护清理竞争；同一实例需要并发客户端时由一个常驻 Session 提供协议入口。

`OpenEnvironment.mode`把该模式传给实际数据库、CAS与应用API。只读会话可以写自己的run信息和诊断日志；正式保存、删除、配置set/unset和维护变更返回`runtime.read_only`。配置reload可读取人工文件并更新进程内资源。

`instance.json` 使用以下字段；`name` 只是目录展示名，`id` 才是长期身份。

```json
{
  "id": "实例初始化时生成的 UUID",
  "name": "default",
  "applicationId": "themelios.workbench",
  "formatId": "themelios.workbench/1",
  "createdAt": "2026-11-18T00:00:00.000Z"
}
```

`ApplicationModule` 的 `id`、`formatId` 与实例清单精确比较。应用 ID 不同返回 `runtime.application_mismatch`，格式不同返回 `runtime.format_mismatch`，错误携带 expected/actual。离线迁移另见存储规范。实例打开不根据旧清单推测变更步骤。

初始化按同一文件系统上的临时目录完成：

1. 解析目标父目录，检查目标不存在或是空目录；已有 `instance.json` 返回 `runtime.instance_exists`，已有其他内容返回 `runtime.instance_not_empty`。
2. 在同一父目录建立 `.<name>.init-<随机值>`，创建标准子目录及空 `managed.toml`。初始化时生成一次实例 UUID。
3. 解析安装配置和应用默认值；调用 `application.provision(env)`。此时 `env.paths` 指向临时目录，应用只建立当前 Schema 和初始资源，初始化阶段不进行模型调用。
4. 关闭 provision 创建的文件与数据库句柄，最后原子写入 `instance.json`。清单存在即表示 provision 已成功。
5. 发布前重新检查目标。目标仍为空目录时，仅调用非递归`rmdir(target)`移除它；该操作自身要求删除时仍为空。`ENOENT`表示目标已经不存在，可继续；`ENOTEMPTY`保持目标原样，已有清单则返回`runtime.instance_exists`，其余内容返回`runtime.instance_not_empty`。目标已变成文件或其他非空对象时同样停止发布，其他IO错误保留实际cause。
6. 将完整临时目录rename到此时不存在的目标。另一初始化已发布的目录包含`instance.json`和正式子目录，无法被此rename覆盖；竞争失败后检查目标，含清单返回`runtime.instance_exists`，其他非空目标返回`runtime.instance_not_empty`。目标状态不能解释的rename失败保留原始IO原因。
7. 返回最终路径的`InstanceInfo`。失败时只清理当前调用创建的临时目录。

Windows目录移动要求目标目录不存在，因此空目标的处理使用上述rmdir→rename顺序；已发布目录始终保持非空。[Windows目录移动](https://learn.microsoft.com/en-us/windows/win32/fileio/moving-directories)

进程崩溃留下的`.<name>.init-*`是未发布内容，`instance.open()`只检查正式目标。初始化失败诊断记录本次staging的完整路径及清理结果，便于定位尚存目录；再次初始化使用新的临时目录。

## 本地实例用操作系统文件锁保护

`native/runtime` 中的 `themelios-runtime-native` crate 用 Rust 标准库 `File::try_lock()`，napi 薄接缝持有 `File` 并导出同步 acquire/close。该标准接口在本次 Rust 基线中已可用，锁随句柄关闭或进程退出释放。[Rust File 文档](https://doc.rust-lang.org/std/fs/struct.File.html#method.try_lock)

实现位置是 `packages/runtime/src/native.ts` 和 `packages/runtime/native/<target>/themelios_runtime.node`。锁文件固定为 `<instance>/run/instance.lock`：

- 以 read/write/create、`truncate=false` 打开；成功 `try_lock` 后才允许打开数据库或修改实例设置。
- `WouldBlock` 转为 `runtime.instance_busy`；其他 IO 错误保留 path 与原始 cause。
- 会话拥有唯一原生句柄，关闭持久资源后释放。文件始终保留在原路径，日常清理和备份都不删除或替换它。
- 进程PID、启动时间和已配置的协议端点写入旁边的`owner.json`供展示；监听完成后更新展示值。能否取得OS锁决定所有权，owner文件只提供诊断信息。
- SDK 内两个 Session 打开同一实例也会冲突；关闭后可以重新打开。实例目录支持本地磁盘。

本期CLI直接打开目标实例并执行操作。取得锁失败时返回`runtime.instance_busy`，展示已知owner与配置端点；需要并发访问常驻实例的客户端使用HTTP、MCP或gRPC入口。

锁的真实用途同时成为 TS→Rust 的集成案例：一个进程持锁，另一个进程取得明确冲突；前者异常退出后，后者能够成功取得锁。

## 启动从最少可用能力逐步完成

启动按下面顺序推进，任何一步失败都逆序关闭已经创建的资源。

| 顺序 | 动作 | 该步可依赖的能力 |
|---|---|---|
| 创建启动诊断 | 生成本次会话关联，建立 stderr 出口和内置 zh-CN/en 最小错误文本 | 系统时间、stderr |
| 定位实例 | 解析目录与 instance.json，核对应用和格式，取得 OS 锁 | 路径、文件系统、Native loader |
| 加载配置 | 读取 TOML、合并、Schema 校验、解析路径、冻结有效值 | 启动诊断 |
| 建立运行基础 | 创建正式日志、实例 tracer/metrics、Secrets、Network、Execution | 有效设置、锁 |
| 打开应用 | `application.open(env)` 显式打开数据库/CAS/材料/任务服务 | 已建立的运行基础 |
| 接纳调用 | 绑定实际操作；CLI 执行请求，长期宿主开始监听 | 完整应用 API |

构造 provider 客户端、渲染帮助和查看配置不触发联网探测。`open({signal})` 在每个可取消启动步骤检查信号；打开成功后该信号结束其职责，后续调用由各自 `CallOptions` 控制。

应用通过 `env.own(resource)` 把自己创建的 `close()` 责任交给 Session。按构建顺序登记，按逆序关闭。例如先登记数据库，再登记 CAS 和材料服务，最后登记模型连接，则关闭时依赖者先结束。单个资源只登记一次。构造函数失败时由它清理尚未返回给调用方的部分资源。

SDK 注入的 fetch、时钟、logger、tracer 由调用方保有。runtime 只关闭自己创建的对象；借用对象参与调用时长但不转移所有权。runtime 库不安装进程级 signal handler，独立 CLI main 负责 SIGINT/SIGTERM。

## 每次根操作捕获一次配置与资源

Execution 使用实例内的 `AsyncLocalStorage` 保存当前操作的取消信号、单调期限、设置快照、实际资源集合与诊断关联。`run(name, work, options)` 等待并返回结果；`start` 返回当前进程内的 `{result,cancel}`；它们都登记真实尚未结束的 Promise。嵌套调用复用根操作，只能缩短期限。`start` 的句柄生命周期止于当前 Session。

根操作开始时增加当前资源集合的一次使用计数；最终 `finally` 释放。每层函数直接使用已绑定服务，普通接口只接收 [CallOptions](../contracts/core.ts) 中的 signal、timeoutMs、onProgress。每个服务通过其 owner 限制模型连接、文件 IO、媒体工作或 Native 计算的并发；等待下游的 orchestration 层只登记任务，不重复占用同一容量。

流式操作使用 `execution.flow(name, create, options)`。它在首次迭代时捕获根上下文，在 `done`、`return()` 或抛错之后完成清理；`cancel()` 发出取消请求，租用的资源直到内部迭代器实际退出才释放。`for await` 提前 break 的 `return()` 会取消底层请求并等待其 finally。未开始迭代的 Flow 尚未占用连接；空置不产生后台任务。模型的单独使用遵循同一 Flow 行为。

关闭消费端时，正文流的 backpressure 和取消沿原始 reader 传递。`Promise.race` 可以使用户看到超时，但 runtime 中的真实执行记录仍保留到工作退出。已提交的保存操作返回其真实结果，即使取消在提交后抵达；后续导出可以另行失败。

持久化owner在进入短同步SQLite写事务前做最后一次signal检查。进入同步提交段后，commit成功就是保存完成点。Execution.run在work返回后直接返回该结果，不再追加throwIfAborted覆盖已提交事实。客户端断线导致响应未收到时，可通过实际trace和结果列表查找已经保存的成果；平台没有通用幂等请求台账。

`timeoutMs` 是该次根操作的总预算，从单调时钟计时，排队、网络与重试共同消耗它。设置为零表示立即到期，省略采用操作 owner 的默认值。外部 signal 与父 signal 通过 `AbortSignal.any` 组合；owner 使用一个 controller 和可清理定时器记录 `call.timeout` 或 `call.cancelled` 的原因。

## 应用资源更新通过一个类型化组合槽完成

应用调用 `env.bindResource(select, create)` 注册自己的一组可重建客户端，例如 Models 与其 provider 连接。`select(settings)` 返回影响这组资源的 JSON 设置投影；`create(context)` 创建真实资源并返回带 `close()` 的组合对象。Application 只注册一个组合槽，跨客户端依赖在自己的 create 中按正常顺序构造。

`slot.get()` 在根操作中返回该操作捕获的资源；启动装配期间返回当前资源。业务服务通过闭包持有 slot，调用者无需传资源版本。槽由 Session 关闭，应用不再对同一组合调用 `env.own`。

更新顺序固定为 runtime 的诊断/Network → 应用组合资源。创建新应用资源时，`create(context)` 得到新候选设置和已经准备好的新 Network；不得从旧操作的 `slot.get()` 取依赖。Network 变化也会重建应用组合，即使 select 返回的模型字段没有变化。prepare 出错时按逆序关闭本次新对象；原资源集合继续处理调用。

文件提交后，Session 在一个同步段把 active 指针换成完整新集合；详见 [configuration.md](configuration.md)。旧集合持有计数归零后逆序关闭。数据库、CAS 等长期状态仍由 `env.own` 持有；设置将它们的连接模式标记为 restart，避免与客户端热换混用。

## Session 关闭等待资源实际停用

`session.close({graceMs})` 的默认 graceMs 为 `runtime.shutdownGraceMs=10000`，第一次调用创建关闭 Promise，重复调用复用它。

1. 会话进入 closing，拒绝新的根操作及配置更新；停止协议接纳。
2. 等待已接受操作在宽限期内完成。宽限期为零时立即进入取消。
3. 对剩余操作统一请求取消。网络 owner 取消 response body；媒体进程 owner 终止所启动进程并等待退出；Native owner 保留其输入直到计算实际结束。
4. 等待实际操作和未完成配置更新退出，关闭各旧资源集合及当前集合。
5. 逆序关闭应用登记资源，完成数据库/CAS 收尾；flush 诊断，再关闭其自有出口。
6. 删除当前会话的 owner.json，释放 OS 锁句柄，状态变为 closed。

媒体 adapter 用参数数组创建子进程。Unix 下可创建专用进程组并结束该组；Windows 下使用同一创建句柄对应的 Job Object 或成熟进程树终止库，等待退出事件后删除工作目录。每个 adapter 只负责它实际启动的进程；在规格要求的文档场景中优先使用进程内成熟依赖。

资源 close 的错误在继续关闭其余独立资源后合并为一个 `runtime.close_failed`，details 列出失败 owner 和 code；锁最后释放。尚在访问资源的工作会阻止释放。独立 CLI 在取消后再等 5000ms，仍未退出时写一条 `runtime.close_timeout` 并以失败码终止进程，由 OS 回收句柄。嵌入 SDK 的关闭 Promise 持续等待，其宿主决定进程退出政策。

## 文件落点与完成行为

| 文件 | 直接承担的内容 |
|---|---|
| `packages/runtime/src/installation.ts` | Installation、Instance、manifest 校验与 staging 初始化 |
| `packages/runtime/src/paths.ts` | 路径基准及 Portable/system 映射 |
| `packages/runtime/src/session.ts` | 启动、资源登记、关闭与状态 |
| `packages/runtime/src/execution.ts` | 根操作、嵌套上下文、Flow 生命周期、取消和总期限 |
| `packages/runtime/src/resources.ts` | 内部资源集合、唯一应用组合槽、引用释放 |
| `packages/runtime/src/native.ts` | 目标平台 Native 加载及实例锁错误转换 |
| `native/runtime/src/lib.rs` | 标准库文件锁和持有句柄的 napi 薄类 |
| `packages/runtime/test/instance.test.ts` | 创建、重开、格式不符、路径迁移 |
| `packages/runtime/test/lifecycle.test.ts` | 启动中途失败、取消流、两个实例交错关闭 |

本部分完成时，文档工作台能够从全新目录初始化、导入材料、关闭、换目录后重开并读到相同材料；第二进程明确报告实例被占用，原进程异常退出后可重开。一个迟缓模型流在配置更新期间继续使用原连接，新调用使用新连接；提前结束流能够释放其旧连接。启动阶段损坏 TOML 的错误同时给出文件、字段或位置与可读原因。
