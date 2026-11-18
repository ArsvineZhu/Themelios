# 错误、网络和诊断保留一次操作的实际上下文

本规范覆盖 `core/errors`、runtime 的诊断、网络、凭据和国际化出口。共同值与方法见 [core.ts](../contracts/core.ts)、[runtime.ts](../contracts/runtime.ts)。每个实际能力在拥有语义的边界解释失败；Application 根操作负责一次最终呈现。

## AppError 是公共错误值的唯一来源

`AppError` 保存 `code`、`messageKey`、可本地化的 `params`、安全的 `details`、`retryable` 以及原始 `cause`。原始栈与cause留在进程诊断中；协议只输出 `ErrorInfo {code,message,details?,retryable,traceId?}`。

`code` 使用小写点命名。`params` 只含生成友好消息所需的字符串/数字/布尔，`details` 使用 Json 并限于该code声明的公开字段。没有实际值时省略字段。外部未知异常由最接近其语义的owner转成AppError，已经是本owner可解释的AppError直接传播。根操作捕获未知异常时使用 `internal.unexpected`，客户端显示通用失败原因和traceId，本地诊断保存原始栈。

`retryable` 表示该失败是否具有暂时性，实际重试由操作owner根据调用语义和剩余预算决定。Models只按其规范重试网络及明确暂时性provider响应；配置、保存与导出各自报告自己的完成点。

### 基础错误目录

| code | 默认retryable | 公开details | HTTP | gRPC |
|---|---|---|---|---|
| `call.cancelled` | false | reason（用户取消/会话关闭等简短原因） | 499；连接已断时仅记录本地 | CANCELLED |
| `call.timeout` | true | operation、timeoutMs、stage | 504 | DEADLINE_EXCEEDED |
| `call.invalid_state` | false | operation、state | 409 | FAILED_PRECONDITION |
| `call.stream_consumed` | false | operation | 409 | FAILED_PRECONDITION |
| `runtime.instance_busy` | true | instanceId、ownerPid、startedAt、endpoints（已知时） | 409 | FAILED_PRECONDITION |
| `runtime.closed` | false | state | 503 | UNAVAILABLE |
| `runtime.native_unavailable` | false | target、runtimeVersion、modulePath（路径仅本地） | 503 | UNAVAILABLE |
| `runtime.read_only` | false | operation | 403 | PERMISSION_DENIED |
| `runtime.instance_exists` | false | instanceId | 409 | ALREADY_EXISTS |
| `runtime.instance_not_found` | false | instanceId（已知时） | 404 | NOT_FOUND |
| `runtime.instance_not_empty` | false | path（仅本地入口公开） | 409 | FAILED_PRECONDITION |
| `runtime.application_mismatch` | false | expected、actual | 409 | FAILED_PRECONDITION |
| `runtime.format_mismatch` | false | expected、actual | 409 | FAILED_PRECONDITION |
| `runtime.close_timeout` | false | remainingOperations | 500 | INTERNAL |
| `runtime.close_failed` | false | owners、codes | 500 | INTERNAL |
| `config.invalid` | false | issues：path、messageKey、params | 400 | INVALID_ARGUMENT |
| `config.unknown_setting` | false | path | 404 | NOT_FOUND |
| `config.write_failed` | false | file（仅本地）、reason | 500 | INTERNAL |
| `input.invalid` | false | issues：path、reason | 400 | INVALID_ARGUMENT |
| `secret.unavailable` | false | reference、reason | 503 | FAILED_PRECONDITION |
| `network.failed` | 按底层原因 | method、origin、phase、status（已知时） | 502 | UNAVAILABLE |
| `network.timeout` | true | method、origin、timeoutMs | 504 | DEADLINE_EXCEEDED |
| `internal.unexpected` | false | 无 | 500 | INTERNAL |

`config.invalid`表示候选值、跨字段依赖或定义冲突未通过校验；`config.unknown_setting`表示路径未声明；`config.write_failed`表示候选已验证但保存失败，当前有效配置保持原状。OS权限或文件写入失败在对应owner下解释。调用方自己的显式取消保留`call.cancelled`，到期由`call.timeout`表示。

### 模型、模板与准备错误

| code | 默认retryable | 公开details | HTTP | gRPC |
|---|---|---|---|---|
| `model.binding_not_found` | false | binding | 404 | NOT_FOUND |
| `model.capability_missing` | false | binding、required | 422 | FAILED_PRECONDITION |
| `model.invalid_request` | false | binding、issues | 400 | INVALID_ARGUMENT |
| `model.input_too_large` | false | actualBytes、maxBytes | 413 | RESOURCE_EXHAUSTED |
| `model.authentication_failed` | false | connection、providerStatus | 502 | UNAVAILABLE |
| `model.rate_limited` | true | connection、retryAfterMs（存在时） | 429 | RESOURCE_EXHAUSTED |
| `model.unavailable` | true | connection、providerStatus（存在时） | 503 | UNAVAILABLE |
| `model.output_truncated` | false | binding、finishReason | 422 | FAILED_PRECONDITION |
| `model.refused` | false | binding、reason（可公开时） | 422 | FAILED_PRECONDITION |
| `model.incomplete` | false | binding、stage | 502 | UNAVAILABLE |
| `model.output_invalid` | false | binding、issues | 422 | FAILED_PRECONDITION |
| `prompt.invalid_template` | false | task、template、line、column、reason（已知时） | 400 | INVALID_ARGUMENT |
| `prompt.resource_missing` | false | task、resource | 404 | NOT_FOUND |
| `input.capability_missing` | false | task、mediaType、required | 422 | FAILED_PRECONDITION |
| `input.invalid_source_key` | false | task、sourceKey | 422 | INVALID_ARGUMENT |
| `content.media_mismatch` | false | declared、detected | 422 | INVALID_ARGUMENT |
| `content.decode_failed` | false | mediaType、reason | 422 | INVALID_ARGUMENT |
| `content.output_not_found` | false | output、availableNames | 404 | NOT_FOUND |

provider完整响应体、请求header、输入正文和机密参数不会通过details自动公开。Structured output 的issues保留Schema字段路径与约束，输出原文仅在明确开启内容诊断时保留。

### 存储、内容与时间错误采用明确映射

以下每个码对应 [storage.md](storage.md)、[content-results.md](content-results.md) 和 [time.md](time.md) 中实际规定的失败。适配器按完整code查表；公开details只输出表中列出的字段，文件路径仅供本地入口使用。

| code | HTTP | gRPC | retryable | 含义及公开details |
|---|---|---|---|---|
| `storage.already_exists` | 409 | ALREADY_EXISTS | false | 初始化、备份、恢复或导出目标已经存在；operation、path（仅本地） |
| `storage.format_mismatch` | 409 | FAILED_PRECONDITION | false | 数据库格式与本次打开要求不符；expected、actual、path（仅本地） |
| `storage.transaction_closed` | 500 | INTERNAL | false | 应用在事务回调结束后继续使用其句柄；operation |
| `storage.transaction_nested` | 500 | INTERNAL | false | 应用在事务内再次进入Database.read/write；operation |
| `storage.async_transaction` | 500 | INTERNAL | false | 同步事务回调返回Promise/thenable，事务已经回滚；operation |
| `storage.write_failed` | 500 | INTERNAL | false | 字节或正式文件发布失败；operation、reason、path（仅本地） |
| `storage.blob_missing` | 500 | DATA_LOSS | false | 所需CAS对象不存在；blobRef。通过材料接口读取时表示已登记材料的字节缺失 |
| `storage.blob_corrupt` | 500 | DATA_LOSS | false | 对象实际哈希或长度与正式记录不符；blobRef、expected、actual |
| `storage.history_unavailable` | 410 | OUT_OF_RANGE | false | 请求cut早于已经采用的历史保留下界；requestedCut、earliestCut |
| `content.transaction_mismatch` | 500 | INTERNAL | false | 准备对象与采用它的事务不属于同一Content/Database；operation |
| `content.prepared_closed` | 500 | INTERNAL | false | 应用继续使用已经关闭的准备对象；operation |
| `content.not_found` | 404 | NOT_FOUND | false | 请求的材料或结果引用不存在；ref |
| `content.text_unavailable` | 422 | FAILED_PRECONDITION | false | 当前材料类型没有可直接读取的文本；ref、mediaType |
| `content.range_invalid` | 400 | INVALID_ARGUMENT | false | 选区坐标、编码边界或JSON Pointer无效；ref、range、reason |
| `content.mapping_invalid` | 422 | INVALID_ARGUMENT | false | 声明精确复制的输出区间与来源字节不一致；output、range、source |
| `content.result_cycle` | 400 | INVALID_ARGUMENT | false | 待保存的内存结果依赖构成循环；path |
| `content.schema_invalid` | 422 | INVALID_ARGUMENT | false | 内容值不满足公开结构或调用者要求的Schema；issues：path、constraint |
| `time.precision_unsupported` | 400 | INVALID_ARGUMENT | false | UTC输入包含毫秒之后的非零精度；field、supportedPrecision |
| `time.domain_conflict` | 409 | FAILED_PRECONDITION | false | 同一时间域ID已经具有不同的单位定义；domain、expectedTicksPerSecond、actualTicksPerSecond |
| `time.overflow` | 422 | OUT_OF_RANGE | false | 计算得到的ticks超出有符号64位范围；domain、value、minimum、maximum，整数均用十进制字符串 |
| `time.unmapped` | 422 | FAILED_PRECONDITION | false | 指定提交cut下，没有覆盖目标UTC的领域映射；domain、utc、cut |

这些失败需修正输入、应用调用或存储状态后重新操作。`storage.history_unavailable`给出可用历史起点；`storage.blob_missing/blob_corrupt`保留损坏事实以供恢复处理。直接使用SDK时同样保留这些AppError code，HTTP与gRPC值由相应协议入口编码。

### 协议错误只解释传输边界

| code | HTTP | CLI退出码 | gRPC状态 |
|---|---|---|---|
| `transport.invalid_request` | 400 | 2 | INVALID_ARGUMENT |
| `transport.auth_required` | 401 | 3 | UNAUTHENTICATED |
| `transport.access_denied` | 403 | 3 | PERMISSION_DENIED |
| `transport.not_found` | 404 | 4 | NOT_FOUND |
| `transport.request_too_large` | 413 | 2 | RESOURCE_EXHAUSTED |
| `transport.result_too_large` | 413 | 2 | RESOURCE_EXHAUSTED |
| `transport.unsupported_media_type` | 415 | 2 | INVALID_ARGUMENT |
| `transport.delivery_failed` | 500 | 1 | INTERNAL |

这些错误默认retryable=false。delivery_failed的details可包含已保存ref和本地导出path；业务成果仍已提交。MCP工具执行失败使用isError=true与公开ErrorInfo，JSON-RPC非法消息交给官方SDK按协议处理。

## 日志记录动作，Trace连接因果

每个Session拥有独立logger、tracer provider、meter provider与ALS上下文。独立嵌入使用可传入宿主的logger/tracer；Session关闭仅释放自己创建的出口。OTel使用实例provider直接取得tracer，手动埋点以显式parent context开始span，ALS保存当前context。库不调用全局provider注册。

ALS的`run`把上下文限制到当前回调及其创建的异步工作，适合让普通SDK方法保留自然参数。[Node AsyncLocalStorage](https://nodejs.org/api/async_context.html#asynclocalstoragerunstore-callback-args) OTel提供span与指标模型及批量导出组件；本项目手动记录实际能力边界，采用其标准导出格式。[OpenTelemetry JS](https://opentelemetry.io/docs/languages/js/instrumentation/)

根操作创建一个span，阶段只对实际发生的独立步骤创建：`input.obtain`、`input.prepare`、`prompt.render`、`model.request`、`result.adopt`、`output.deliver`。没有进行转换或保存时，也就没有对应span。每次真正网络模型尝试有独立attempt编号；排队等候记录queueMs，外部请求记录durationMs，结束记录outcome与真实用量。

Pino输出JSONL。最低有用日志形状为：

```json
{
  "time": "2026-11-18T00:00:00.000Z",
  "level": "info",
  "event": "model.request.completed",
  "operation": "tasks.run",
  "stage": "model.request",
  "traceId": "实际OTel trace id",
  "spanId": "实际span id",
  "durationMs": 823,
  "outcome": "success",
  "connection": "local",
  "binding": "summary",
  "attempt": 1,
  "inputTokens": 121,
  "outputTokens": 53
}
```

JSONL中的时间用UTC；耗时用单调时钟计算。未知token数省略，缓存/推理等子类用量采用provider真实字段。不同指标单位区分bytes/tokens/ms；一个请求在模型与网络层都产生span时，只有model.request计为模型调用次数。

`Diagnostics.log(level,event,fields)` 使用稳定事件名与结构字段。用户可读的句子由呈现层产生；日志不在每个helper重复输出同一异常。成功路径默认记录根操作结束和关键有独立含义阶段，debug才展开中间诊断。进度观察回调抛错时记录一次`observer.failed`诊断事件，业务继续；该事件不转换成操作失败。

## 启动与文件出口可以独立失败

BootstrapDiagnostics从启动第一步向原始stderr输出，不依赖TOML、模型、SQLite或外部OTLP服务。配置可用后建立Pino及文件出口，关联ID保持连续。首次Native加载失败、清单不匹配、配置解析失败均有阶段和原因；文件日志建立成功之前的stderr记录不另外补入业务存储。

文件日志使用 `rotating-file-stream`，文件为 `logs/runtime.jsonl`，按`logging.rotateBytes`轮换，保留`logging.maxFiles`个已轮换文件；当前文件另计。每一条JSONL作为单次write写入，使一条记录保持完整。[rotating-file-stream](https://github.com/iccicci/rotating-file-stream)

Pino使用自定义Writable时，`flush`与目的stream的关闭责任不同。自有出口关闭时先停止生产新记录，随后`end()`并等待`finish`，错误路径也等待已接受写入完成。[Pino API](https://github.com/pinojs/pino/blob/main/docs/api.md)

诊断文件写入失败时，向原始stderr报告一次path与原因，关闭该出口，继续可用出口。标准日志单条限制为32KiB，超长字段截断并标出truncated。文件出口的`writableLength`超过1MiB时丢弃debug/info，warn/error同步转发原始stderr并报告一次拥塞；恢复后继续写入。内容附件使用独立文件流，不进入这一日志缓冲。

启用OTLP时采用批量导出和有界队列。导出失败记录本地诊断，继续业务操作；关闭时forceFlush和shutdown各有2000ms上限，超时写入stderr后完成关闭。未配置endpoint时保留本地结构日志与traceId，外部导出组件不发请求。

## 指标测量有限且有实际意义的数量

实例meter保存以下仪表；标签限定到操作名、stage、connection/binding、outcome与错误code，内容ref、用户文本和traceId留在日志中。

| 指标 | 类型与单位 | 记录时机 |
|---|---|---|
| `themelios.operation.duration` | Histogram，ms | 根操作实际结束 |
| `themelios.operation.active` | UpDownCounter，operations | 根操作开始/真实finally结束 |
| `themelios.model.attempts` | Counter，requests | 每次真正发出的模型请求 |
| `themelios.model.tokens` | Counter，tokens；附input/output/cache/reasoning类别 | 收到provider真实用量时 |
| `themelios.queue.wait` | Histogram，ms | 取得实际owner容量时 |
| `themelios.network.bytes` | Counter，bytes；附direction | 实际发送/接收可计量字节时 |

价格只有在明确配置该binding价格时才计算估算费用，带currency和`estimated=true`；缺失价格保留缺失。失败尝试已经产生的用量照实记录，不并入成功尝试伪装成一次请求。

指标通过OTLP/HTTP导出；本地`status`的活动数量来自Execution的真实记录。平台不为遥测另开业务数据库，也不把指标当成恢复队列。

## 内容诊断是明确开启的附件

`telemetry.captureModelContent=true`时，在`logs/model-content/<traceId>/`记录编译后的请求JSON、模型文本响应、Schema转换说明与每次attempt的状态。二进制材料只写mediaType、长度和原始/转换后选择；需要保存原始字节时使用既有材料引用或已有缓存文件位置，保留其实际来源。

写入前过滤认证header和已解析秘密值，模型内容附件仍可能含用户材料。附件写入失败记录诊断，模型结果继续正常返回。内容附件属于日志目录中的独立子目录；清理该目录只删除诊断副本，正式成果继续保存在对象存储。

普通日志只记录模板来源、task/binding、输入模态/数量、有效参数摘要、用量和状态。配置未开启内容捕获时，请求正文与响应正文不落盘。服务端向远程客户端公开diagnostics操作时按admin权限处理。

## Network提供一次受控的标准fetch

`createNetwork(options)`创建可独立使用的Network；实例模式由Session按有效设置创建。Network内部持有 `Bun.FetchSession`，具体连接设置和keep-alive池归该对象。Bun支持显式`proxy:false`以及每个session自己的池，因此采用新设置时能够让新旧请求各保有自己的连接。[Bun Fetch](https://bun.sh/docs/runtime/networking/fetch)

`network.fetch`是已绑定函数，使用标准Request/Response形状，可直接传给AI SDK provider。执行过程固定如下：

1. 合并Request自身signal、init.signal、当前根操作signal，以及该请求的截止控制器。相同信号只订阅一次。
2. 期限取network.timeoutMs和根操作剩余预算的较小值。计时从进入Network开始，覆盖连接、响应头和整个响应体。
3. 以当前资源集合的代理、CA和解析后的代理认证发出一次fetch。省略proxy时显式传false；构造后process.env代理变化不影响该集合。
4. 取得Response后保留status、statusText、headers、url、redirected与body的标准语义；把body包在一个透传ReadableStream中，EOF、error和cancel均释放本次登记并清理定时器及signal监听。
5. body为空时立即释放。消费端cancel与截止控制器都取消原始reader；reader关闭后该请求才算真正退出。
6. 映射网络异常：证书、无效地址等确定失败retryable=false；连接重置、暂时性解析失败等retryable=true。HTTP非2xx作为Response交给实际owner解释。

返回响应头不会清除总期限；provider的json()或流式读取仍受其约束。克隆Response产生标准tee分支，原始请求登记持续到所有实际分支结束；Network.close会中止并收尾仍未消费完的自有请求，再关闭池中的空闲连接。无实例的SDK调用者用try/finally关闭自己创建的Network。

Network不附加通用重试。模型owner拥有尝试次数、backoff和总预算；SourceAdapter拥有下载重定向与字节上限。重试每次取得新credential，stream已交付正文后的处理见模型规范。

provider连接只使用已配置的baseURL，URL取得器处理用户材料URL。普通材料下载限定http/https，用`credentials:'omit'`，重定向逐跳验证并最多5次；允许访问哪些host由应用的源adapter权限决定。日志记录origin和去敏路径，签名query与user-info不进入通用诊断。

Network只读取显式传入的CA文件，并保持主机名及证书验证。发送header时使用`Headers`处理大小写和合并；Authorization、Proxy-Authorization由所属凭据生成位置唯一负责。

## 国际化保持实例和调用各自的语言

使用 `i18next.createInstance()` 为每个应用建立词典实例，用`getFixedT(locale, 'translation')`绑定本次调用语言。首发提供zh-CN、en，缺失目标语言键回退到en；核心启动错误文本随runtime直接打包，保证配置错误也能呈现。[i18next API](https://www.i18next.com/overview/api)

语言有三项独立用途：界面locale控制CLI/help/error，任务outputLocale控制模型输出语言，原材料language是内容事实。改变界面语言只影响后续呈现；进行中的任务保留开始时的输出语言。

每包使用`resources/locales/{zh-CN,en}/<module>.json`，module采用runtime/content/models/application/transports或扩展包声明的名称。JSON为平面对象，完整messageKey带所属模块前缀；值使用i18next插值与复数语法，数值、日期和单位用Intl格式化。Schema的title/description/impact以及Prompt维护参考从这些资源键产生，正式结果保存结构值与原始文本。

各包通过公开`locales`常量提供这些词典；应用合并所用模块的词典并通过`ApplicationModule.locales`交给Runtime，形状为`语言 -> 完整messageKey -> 模板`。Runtime以`keySeparator:false`创建i18next实例，将合并后的每种语言词典放入固定`translation`空间；同语言同键的相同值可合并，重复而不同的值在装配时返回`config.invalid`。业务模块通过自己的公开出口或包资源URL提供词典。

构建时由每包en资源推导本包键类型，并检查zh-CN包含同一组必需键；扩展使用自己的键前缀提供资源。局部键类型由包导出，宿主无需承担一个跨所有扩展的全局TypeScript声明合并。

错误先在owner处生成code/params/details，呈现层才按实际locale格式化message。外部原始异常作为cause保留，可读界面先显示本地化操作原因，debug再展开脱敏后的原始原因与栈。CLI普通结果走stdout，日志和进度走stderr；MCP stdio的stdout保留给协议帧。

## 实施落点与可观察完成行为

| 文件 | 直接责任 |
|---|---|
| `packages/core/src/errors.ts` | AppError、ErrorInfo、错误目录与公开字段过滤 |
| `packages/runtime/src/diagnostics/bootstrap.ts` | 无配置依赖的stderr启动出口 |
| `packages/runtime/src/diagnostics/logger.ts` | Pino、自有文件出口、轮换与背压 |
| `packages/runtime/src/diagnostics/tracing.ts` | 实例OTel provider、手动span与上下文 |
| `packages/runtime/src/diagnostics/metrics.ts` | 上述有限仪表及OTLP出口 |
| `packages/runtime/src/network.ts` | FetchSession、请求/body寿命、取消与期限 |
| `packages/runtime/src/locale.ts` | 独立词典、固定语言呈现及Intl |
| `packages/runtime/resources/locales/` | 核心两种语言资源 |
| `packages/runtime/test/diagnostics.test.ts` | 两实例隔离、启动失败、日志出口失败 |
| `packages/runtime/test/network.test.ts` | 慢响应体、断线取消、代理切换与连接释放 |

完成操作：损坏实例TOML后启动，stderr给出文件和解析原因；恢复后执行一个真实模型任务，能从同一traceId看到输入准备、模型尝试和结果保存的时长；取消慢响应体使真实连接退出；关闭一个实例不影响另一个实例的日志与locale。将模型内容诊断开关分别置为false/true，确认普通日志和明确附件目录的内容差别。
