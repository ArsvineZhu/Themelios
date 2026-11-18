# 公共合同让完成值直接进入下一个操作

配套的 [core.ts](../contracts/core.ts)、[content.ts](../contracts/content.ts)、[storage.ts](../contracts/storage.ts)、[models.ts](../contracts/models.ts)、[runtime.ts](../contracts/runtime.ts) 和 [application.ts](../contracts/application.ts) 给出完整字段与签名。它们是目标 API 的可检查声明；实现时在各自包内用 Zod 定义外部输入、持久格式及对应推导类型，并保留这些公开签名。

## 值、字节和引用具有各自的用途

| 值 | 语义和格式 | 创建者 |
| --- | --- | --- |
| `ArtifactRef` | `art_` 加小写 UUID v4，指当前实例中一次不可变材料或结果；相同字节可有不同来源引用 | Content |
| `BlobRef` | `sha256:` 加 64 位小写十六进制，指精确字节 | CAS |
| `CommitPoint` | 非负十进制整数字符串；程序内部转换为 bigint，数据库上限为有符号 64 位整数 | Database |
| `Selection` | 一份正式材料及可选局部范围 | 调用方/读取器根据实际材料构造 |
| `InlineMaterial` | 本次调用已有的字节、MIME 和可选名称 | 调用方或转换器 |
| `Completed<T>` | 已完成、立即可消费的值、输入、输出文件和生产信息 | Task/转换器/应用 |
| `SavedResult<T>` | 已保存结果的引用及完整内容，所有材料连接已归一为 Selection | Results |

`Json` 只包含 null、boolean、有限 number、string、数组和普通对象。BigInt、Date、Map、NaN、Infinity、函数和 undefined 在外部输入/保存处报 `content.schema_invalid`；通用整数时间以十进制字符串跨协议。数组顺序有意义，普通 JSON 对象的键顺序不表达业务含义。

引用在所属实例内解析。实例身份已由 API 对象和协议端点绑定，方法参数无需再带 instanceId。跨实例导入走显式备份恢复或应用导入，复制一个字符串不会复制材料。

## 选区坐标有固定的单位与边界

| `Range.kind` | 坐标 | 处理 |
| --- | --- | --- |
| `text` | UTF-8 原件字节，零基 `[start,end)` | 两端在 Unicode 编码边界；保留换行、BOM 和原字节；允许空选区 |
| `pages` | PDF 页码，一基 `[start,end)` | 第一页为 `{start:1,end:2}`；准备器检查 end≤页数+1 |
| `time` | 媒体起点后的毫秒 `[startMs,endMs)` | 有限非负数，允许小数；start<end；转换器负责实际采样边界并报告覆盖 |
| `image` | 自动应用 EXIF 方向后的整数像素矩形 | x/y≥0，width/height>0；矩形处于方向归一后的图像范围 |
| `json` | RFC 6901 JSON Pointer | 空串表示根值；`/value` 选结果正文；转义 `~0`、`~1` 按标准处理 |

一个 Selection 表达一个连续范围。多个离散范围用有序 Selection 列表表达。普通材料读取 `materials.read(ref)` 返回完整原件字节；`materials.text(selection)` 处理文本和 JSON 值；媒体准备器完成图像、页或时段的确定性裁切。

文本的 UTF-16 编辑器位置在结构解析出口一次性转换为 UTF-8 字节位置。调用者只看到原材料坐标。解析器规范化了空白、OCR 或模型转写产生新文本时，产出新的表示，并用来源关系关联原件。

JSON 选区得到字符串时直接使用该字符串；得到其他 JSON 时使用 `JSON.stringify(value, null, 2) + "\n"`。这是逻辑值的文本呈现；逐字节复制关系只用于 `text` 选区。JSON Pointer 参考 [RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)。

## 完成值保存实际消费关系

`Completed.inputs` 按本次输入顺序保存 `InputUse`：`source` 是用户提交的原材料或上一结果输出，`delivered` 是最终实际交给模型/转换器的表示，`role` 区分当前处理对象与上下文。原生发送时 delivered 只有原材料自身；转换后它指向转换结果中的真实文件。

`Completed.files` 是具有唯一名称的输出文件，名称使用 UTF-8 普通文件名且排除路径分隔符、`.`、`..` 和保留名称 `$value`。`sourceIndices` 指向当前 inputs 的零基下标；独立生成的文件用空数组。`Producer` 记录实际执行者：模型记录 task/binding/providerModel、已知返回模型名、实际用量和 Prompt 资源；确定性转换记录 recipe 及版本；应用记录自身操作名。缺失的提供者用量保持缺失。

`ResultOutput` 直接引用内存中的 Completed 或已保存的 SavedResult。`output` 默认 `$value`，表示该结果的 value；其他名称在 files 中查找。保存后的 files 以名称为 key，值为 `{material:Selection,sourceIndices:number[]}`，保留每份文件与本结果输入的对应关系；命名输出读取 `files[name].material`。把当前结果交给下游只需：

```ts
const draft = await tasks.run(describeDocument, request);
const structured = await tasks.run(extractFacts, {
  variables: {},
  materials: [{ source: { result: draft }, role: 'primary' }],
});
const saved = await results.save(structured);
```

保存时，`$value` 归一为 `{ref: resultRef, range:{kind:'json',pointer:'/value'}}`；命名文件归一为文件对应的 Selection。Content 在一次保存中处理尚未保存的依赖结果，让下游可以完整追溯上游。调用方无需建立额外运行 ID、采用记录或结果中转表。

Completed 是普通完成数据。调用开始时捕获外部可变输入；同一调用中的源码字节/表示复用同一份捕获值。返回后的字节由调用者持有并按只读使用，新的改写应形成新的应用结果。大材料先 accept 为 Selection，内存结果受配置中的字节预算约束。

## 精确复制和语义来源分别记录

一般生成、摘要、解释、OCR 与图片描述只记录 inputs 和 sourceIndices。`CopyMap` 仅表达已知的逐字节复制：output 是输出文件名，range 是该文件的 UTF-8 区间，source 必须是文本选区。保存前比较两段实际字节；区间长度或字节不同报 `content.mapping_invalid`。

程序可以依据精确复制关系跳回原文。模型给出的引文、概括或短键属于任务输出字段，经过任务验证器绑定到 SourceDirectory；程序数据库 ID 和字节偏移由读取器产生。

## 取消、期限和流是同一组调用合同

`CallOptions.timeoutMs` 从进入公共操作开始计时，覆盖排队、材料准备、模型重试及网络请求。嵌套调用继承剩余期限；显式更短期限可以收紧它。用户取消产生 `call.cancelled`，总期限耗尽产生 `call.timeout`。

`Flow<T>` 首次迭代才开始工作，只有一个消费者。成功输出零个或多个 progress/text-delta，再输出恰好一个 result 并结束；失败抛 AppError。`cancel()`、迭代器 `return()`、消费者 `break` 和外部 AbortSignal 都传递取消，清理在真实执行停止后完成。流未开始时 cancel 只使它成为已取消流；第二个消费者报 `call.stream_consumed`。结构化片段始终只是进度，最终 result 才经过完整 Schema 验证。

进度回调是观察出口。回调异常记录一次 `observer.failed` 并继续业务操作；流消费者异常则关闭迭代并取消工作。保存操作在同步事务提交前检查取消；提交成功后的 SavedResult 仍作为成功结果返回。

## 存储组合保留一处事务权威

普通调用使用 `materials.accept()` 与 `results.save()`。需要与应用自有业务表一起提交时，使用 `prepare()`：它完成所有异步字节工作，返回短期准备对象；随后在 `database.write(tx => ...)` 中调用 `prepared.adopt(tx)`，与业务表写入同一事务；最后 close 准备对象。

准备对象绑定原 Content 与 Database。adopt 只接受对应数据库当前同步事务。事务回滚后可在该对象关闭前重试 adopt；close 后报 `content.prepared_closed`。prepare 成功而 adopt 失败时，已发布 CAS 字节成为待离线清理的未引用对象，正式数据库没有半份结果。

这个高级接口服务真实的原子操作，例如资料登记应用同时保存发票材料与 inventory 行。普通任务继续使用一个 save 调用。
