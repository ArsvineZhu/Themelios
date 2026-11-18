# 配置由字段定义生成，并按实际资源生效

`runtime/configuration` 负责配置的解析、层级合并、来源说明、保存和有效快照。各能力模块提供自己的 `SettingsDefinition`；Application 在装配时将这些定义合成一个应用 Schema。公开类型见 [runtime.ts](../contracts/runtime.ts)，模型连接与任务字段见 [models-prompts.md](models-prompts.md)，监听与认证字段见 [application-transports.md](application-transports.md)。

## 一个字段同时说明值与效果

Schema 使用 Zod。类型、可选性、数值范围、枚举和默认值只在 Schema 中定义，`fields` 按字段路径提供描述、单位、可修改层级与生效方式。文档和 CLI `config describe` 从这两者生成。

Runtime公开`runtimeSettings: SettingsDefinition<RuntimeSettings>`，包含locale/runtime/logging/telemetry/network五组字段；各能力包公开自己的settings定义。应用用`combineSettings(a,b)`显式组合，得到`SettingsDefinition<A & B>`并交给ApplicationModule。两个schema根必须是ZodObject，顶层键互不重名；helper通过公开shape合成新对象、合并字段metadata，并依次调用两边的validateEffective。重复顶层键返回config.invalid，由应用统一拥有冲突字段。库存示例只添加inventory字段，直接复用runtimeSettings。

| 定义项 | 规则 |
|---|---|
| `titleKey`、`descriptionKey`、`impactKey` | 对应模块翻译资源键；分别说明名称、允许内容、修改后改变的行为 |
| `scopes` | installation、instance、task、call 的允许子集 |
| `effect` | next-call、reload、restart 之一 |
| `unit` | ms、bytes、requests 等实际单位，可省略 |
| `format` | path 解析文件基准，credential 解析凭据引用，其余普通值省略 |
| `sensitive` | 标记非公开值；describe保留字段说明，get/explain脱敏 |
| `examples` | 符合该字段 Schema 的 JSON 值 |
| `dependsOn` | 生成说明所用的字段路径；真实跨字段约束由 validateEffective 校验 |

具名资源的元数据使用路径模板，如 `models.connections.*.credential`。名称采用 `[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}`，因此 `models.connections.local.baseURL` 可以无歧义地用于 SDK 与 CLI。任务 ID 的点号作为整体映射键处理；CLI 参数接受 JSON Pointer 作为替代寻址形式，内部先转换成字符串路径段，再匹配 Schema。公开 `SettingPath` 同时接受点分路径或以 `/` 开始的 RFC 6901 JSON Pointer，`describe` 的返回路径统一使用 JSON Pointer。

路径解析在 `configuration/path.ts` 内完成；转义采用 RFC 6901 的 `~0`、`~1`。访问对象时仅接受 own property，拒绝 `__proto__`、`constructor`、`prototype` 路径段。路径不存在或指向未声明字段返回 `config.unknown_setting`。

`validateEffective(settings)` 返回跨字段问题，例：binding 指向不存在的 connection、同一 listener 的地址冲突、模型任务需要的能力未提供。它是模块的普通函数；所有问题合并进一个 `config.invalid`，包含字段路径和原因。配置错误发生在创建资源前。

## 层级合并与来源解析保持确定

合并顺序为内置默认 → 安装 TOML → 实例 TOML → managed TOML → 任务覆盖 → 本次允许覆盖。先合并用户实际提供的部分值，再通过完整 Schema 填默认；上层缺少字段继续继承。`undefined` 代表缺少，JSON null 是配置无效值，移除使用 unset。

| 值形状 | 合并行为 |
|---|---|
| 字符串、数字、布尔 | 上层覆盖下层 |
| 普通对象、具名 map | 对每个 own key 递归合并 |
| 数组 | 上层整体替换；空数组清空 |
| 可选字段未提供 | 继承下层或保留省略 |

低层已有的整个资源需要删除时，编辑提供它的人工 TOML；`unset(path)` 只删除 managed 层的该路径，结果恢复继承。调用返回的新 effective 值让用户直接看到这一结果。

TOML 采用当前 Bun 的 `Bun.TOML.parse` 与 `Bun.TOML.stringify`。人工设置由编辑器修改，程序只重写自己拥有的 managed.toml，因此保留人工文件的注释与排版。配置值采用 JSON 可表达的类型，时间值写成带引号的 ISO 字符串。[Bun TOML](https://bun.sh/docs/runtime/toml)

配置文档不使用静态 `import '*.toml'` 加载运行中可修改的文件；每次显式 reload 读取字节并 parse，避免把实际设置编译进发行包。每个已提供叶值保存内部 provenance：层级、文件路径以及原始值。默认值标记为 default。`format=path` 和 `format=credential` 的文件路径在合并后按该叶值的来源目录解析。

`explain(path)` 返回所有实际贡献及 `desired/effective/state`。路径值在 contributions 中保留原写法，effective 返回用于当前调用的绝对路径；秘密值统一脱敏，凭据引用可显示其引用名。运行快照是新建并递归冻结的纯数据对象，不包含连接、Schema、Map、文件句柄或环境对象。

`snapshot()`在根操作中返回该操作捕获的快照；没有当前操作时返回Session的active快照。`describe/explain`是管理查询，始终显示Session最近提交的定义、desired及active状态。由配置更新本身产生的返回值因此能立即说明新状态。

任务覆盖只修改该任务允许的参数；本次覆盖同样经过 scopes 检查。连接的 baseURL、凭据、文件目录、数据库模式和监听地址均不开放 call scope。环境变量只供显式凭据引用和启动入口参数读取。

## 保存与重载在一个串行更新队列中完成

`set`、`unset`、`reload` 共享 Session 的单个更新队列，后一个更新从前一个提交后的 desired 状态重新计算。`set/unset` 以 managed.toml 为写入目标；`reload` 只重新读取并采用磁盘内容。读快照与正在执行的业务不等待 prepare。

一次 `set` 的顺序如下。

1. 在队列中读取全部当前文件和 managed 层，解析修改路径，检查 scope。以该份最新内容形成候选 desired；语法和跨字段校验完成后计算改变的叶路径。
2. 按 effect 形成候选 effective：next-call/reload 字段取候选值，restart 字段保持本会话旧值。对这个实际可采用的组合再次执行跨字段校验。
3. 如果混合后的 effective 违反跨字段约束，本次修改整体延迟：effective保持旧值，changed中的全部字段进入restartRequired。desired已通过完整校验，重新open可采用完整组合。explain给出导致延迟的字段关系。
4. 为有效差异准备 runtime 资源，再准备应用的一个组合资源槽。新建模型客户端可以解析地址和能力，凭据与付费服务在实际请求时使用。prepare 失败就逆序关闭本次新对象。
5. 用 `Bun.TOML.stringify` 生成 managed 文本，随后 `write-file-atomic` 以 fsync 开启的默认行为替换同目录文件。文件写入失败返回 `config.write_failed`，保留旧有效集合并关闭候选资源。[write-file-atomic](https://github.com/npm/write-file-atomic)
6. 文件保存成功后，立即进入同步提交段：更新 desired、来源、pending 集合和 active 资源指针。该段只交换已构造值，不调用用户 callback、IO 或 await。
7. 返回 `ConfigurationChange`。旧资源在原有根操作结束后关闭；旧资源 close 失败记入诊断，不逆转已经对外生效的新配置。

变更全部为空时返回空数组，资源保持原状，managed 文件也保持原字节。对同一路径并发 set 的最终值遵循调用进入队列的顺序；一次设置多个相关字段可对其最近公共父对象执行一次 set，经过同一候选检查与提交。

`reload` 沿用以上计算和 prepare/采用过程，但省略写文件。外部文件有错时保留当前有效值并返回文件与字段原因。发现磁盘存在 restart 差异时更新 desired 和 pending；有效可更新部分照常采用。默认由用户或应用明确执行 reload，没有后台 watch 循环。

## 生效点与失败后状态可直接解释

| 场景 | 磁盘与 desired | 已有调用 | 新调用与下一步 |
|---|---|---|---|
| 候选不合法、prepare 失败 | 不写入 | 继续旧集合 | 继续旧集合；set返回实际错误 |
| 原子写入失败 | 原正式文件保持；临时文件由依赖清理 | 继续旧集合 | 继续旧集合 |
| 文件已保存、指针已交换 | 保存新 desired | 使用捕获的旧集合 | 使用新 effective |
| 保存之后进程崩溃 | 新文件已提交 | 随进程结束 | 重启从文件建立完整新集合 |
| restart 字段保存 | desired为新值，pending列出路径 | 继续旧值 | 本会话继续旧值；重新open后生效 |
| 外部编辑产生坏TOML | 文件仍是用户编辑内容 | 继续旧集合 | reload返回错误；修正后再reload |
| Session正在关闭 | 拒绝新更新；等待已经开始的更新退出 | 依关闭顺序完成 | `runtime.closed` |

restart 字段在同一会话多次修改时，pending始终比较 latest desired 与启动有效值；改回启动值即移除 pending。下一次 open 成功后全部启动设置已经有效，pending为空。`ConfigurationChange.restartRequired` 列出当前仍待重启的变化。

## 首发字段具有确定默认、范围与影响

所有整数值要求 `Number.isSafeInteger`。下表给出 runtime 所有的基础字段，模块自己的完整具名字段由相应规范的 Schema 合并进来。除表内另列外，字段允许 installation/instance 层。

| 字段 | 默认与允许值 | effect 与具体影响 |
|---|---|---|
| `locale` | `zh-CN`；首发 `zh-CN`、`en` | next-call；改变本次操作的呈现语言，另允许call覆盖 |
| `runtime.shutdownGraceMs` | 10000；0..300000 ms | next-call；下一次close开始时取值 |
| `runtime.ioConcurrency` | 4；1..64 | reload；IO容量资源换新，已排队调用保留所属队列 |
| `logging.level` | `info`；debug/info/warn/error | next-call；下个根操作绑定的logger级别 |
| `logging.file` | true | reload；是否建立实例文件日志出口 |
| `logging.rotateBytes` | 10485760；65536..1073741824 | reload；文件轮换阈值 |
| `logging.maxFiles` | 5；1..100 | reload；最多保留的已轮换文件数，另有一个当前文件 |
| `telemetry.endpoint` | 省略；http/https URL | reload；OTLP/HTTP出口基址，附加`/v1/traces`和`/v1/metrics` |
| `telemetry.credential` | 省略；CredentialRef | reload；OTLP Authorization完整header值的引用 |
| `telemetry.captureModelContent` | false | next-call；记录本次模型请求和响应诊断附件 |
| `network.timeoutMs` | 60000；1..3600000 ms | next-call；单次HTTP总期限，和操作剩余期限取较小值 |
| `network.proxy` | 省略表示直连；http/https URL，无userinfo | reload；固定此资源集合的代理 |
| `network.proxyAuthorization` | 省略；CredentialRef | reload；传给代理的完整Authorization值；要求同时提供proxy |
| `network.caFile` | 省略；文件路径 | reload；读取附加CA证书，保留默认TLS验证 |
| `models.timeoutMs` | 120000；1..3600000 ms | next-call；一次模型操作总预算，允许task/call覆盖 |
| `models.maxAttempts` | 1；1..5 | next-call；总尝试次数，允许task覆盖 |
| `models.concurrency` | 4；1..64 | reload；模型连接队列容量 |
| `content.maxImportBytes` | 1073741824；1..Number.MAX_SAFE_INTEGER bytes | next-call；流式文件及CAS导入累计字节上限 |
| `content.maxInlineBytes` | 8388608；1..67108864 bytes | next-call；内联字节材料上限 |
| `preparation.maxMaterialBytes` | 67108864；1..1073741824 bytes | next-call；单次准备持有的材料及转换输出总预算 |
| `preparation.image.maxPixels` | 40000000；1..268435456 pixels | next-call；图片解码最大像素数 |
| `storage.synchronous` | `FULL`；FULL/NORMAL | restart；SQLite新连接的持久性模式 |
| `transports.maxJsonBytes` | 8388608；1..1073741824 bytes | next-call；完整JSON请求及结果字节上限，包括base64内容 |
| `transports.http.listen` | 省略；对象`{host,port}`，host默认127.0.0.1，port 1..65535 | restart；HTTP监听地址 |
| `transports.grpc.listen` | 省略；同上 | restart；gRPC监听地址 |
| `transports.grpc.tls` | 省略；对象`{key,cert}`，两个字段均为CredentialRef | restart；读取gRPC服务端私钥与证书，非loopback策略见协议章 |
| `transports.mcp.mode` | 省略；stdio/http | restart；MCP入口，http模式复用HTTP宿主 |
| `transports.authTokens` | 空map；值为`{secret,permissions}` | reload；新请求认证，secret为CredentialRef，permissions为read/write/admin子集 |
| `transports.http.allowedHosts` | `localhost`、`127.0.0.1`、`[::1]` | reload；HTTP/MCP Host检查 |
| `transports.http.allowedOrigins` | 空数组 | reload；允许的浏览器Origin；同源请求按协议规范处理 |

模型名称、provider model、端点及凭据均由用户实际配置。模型连接不完整只使依赖它的任务不可执行；材料读取、Schema参考、离线模板预览和配置管理仍可用。已声明的binding如果指向缺失connection，则属于真正的配置错误。

连接名、binding名、任务名对应关系、能力和参数范围见 [models-prompts.md](models-prompts.md)。输入预算取本表全局值、任务要求与binding限制中的最小适用值。应用可以在自身Schema中添加字段；生成参考时保留对应模块命名空间。

`transports.authTokens` 的token ID只用于管理和诊断，验证时读取真实secret，根请求绑定本次 Principal。删除token不会中断已经完成认证的当前请求。非loopback监听必须有配置token或宿主认证实现；具体认证与协议错误映射由 [application-transports.md](application-transports.md) 决定。

## 凭据由明确引用取得

凭据值采用 `env:NAME` 或 `file:PATH`。`Secrets.resolve(ref)` 在真实请求前读取并返回字符串；env从当前process.env取值，file使用规范化后的绝对路径。文本文件按UTF-8读取，移除结尾一个LF或CRLF，保留其他字符；空内容、缺失环境变量、读文件失败分别返回带引用名的 `secret.unavailable`。凭据不会写回配置或进入结果。

`Secrets.available(ref)` 只检查环境值存在且非空、文件可读且非空；返回布尔值，权限和IO错误可在debug诊断中查看。普通配置explain显示引用，调用方需要可用性时明确调用available，help命令只读取字段定义。

相对file引用必须带有明确基准。TOML加载器使用来源文件目录；独立SDK使用`createSecrets({baseDir})`。凭据内容在一次HTTP尝试开始时读取；重试可取得轮换后的env/file值。日志只记录引用和是否成功解析。

HTTP Authorization、Proxy-Authorization、Cookie、Set-Cookie、X-Api-Key、Api-Key与provider专用key headers均在通用诊断出口脱敏。配置提供的普通headers也走同一脱敏规则。模型凭据由连接adapter生成认证头；配置headers与其冲突时返回 `config.invalid`，避免顺序覆盖改变认证。

## 实施落点与完成操作

| 文件 | 具体工作 |
|---|---|
| `packages/runtime/src/configuration/definition.ts` | SettingsDefinition组合、Schema与字段元数据检查 |
| `packages/runtime/src/configuration/path.ts` | 点分/JSON Pointer寻址、具名字段模板匹配 |
| `packages/runtime/src/configuration/load.ts` | 读取TOML、合并、来源、路径规范化 |
| `packages/runtime/src/configuration/configuration.ts` | snapshot/describe/explain/set/unset/reload与更新串行化 |
| `packages/runtime/src/configuration/reference.ts` | 同源字段参考生成 |
| `packages/runtime/src/credentials.ts` | env/file凭据解析 |
| `packages/runtime/test/configuration.test.ts` | 分层恢复、外部坏文件、热换、保存失败、restart差异 |

完成时能从 CLI 查看一个字段的范围、默认、来源与实际生效值；修改代理或模型连接时，新旧并发任务各使用一致配置；磁盘写入失败保留原连接；修改SQLite模式显示restart-required，重开后生效。一次设置多个依赖字段能作为一个变更成功应用，原人工文件注释保持原样。
