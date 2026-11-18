# 材料和成果由一个内容所有者完成保存与追溯

本章对应 `packages/content/src/`，完整接口见 [content.ts](../contracts/content.ts)。Content 使用 Storage 的 Database/CAS；应用通过 `createContent({database,cas,...limits})` 取得绑定该存储的 materials、results、representations。普通读取、保存和来源操作均在这个对象完成。

## 四组表保存四种不同事实

DDL 见 [storage.sql](../schema/storage.sql)，由 `@themelios/content/schema` 的 `contentSchemaSql` 公开提供。

| 表 | 每行含义 | 权威与写入方法 |
| --- | --- | --- |
| artifacts | 一次已采用的不可变材料：种类、MIME、CAS 字节、大小、名称、extent、来源、created_seq/at | materials.accept 或 results.save |
| artifact_edges | 一份已保存结果直接依赖的材料及精确选区 | 保存时从结果正文生成的查询/回收索引 |
| artifact_roots | 应用保留一份材料的提交区间 | accept/save 顶层采用、retain/release |
| representations | 某个原选区在某用途及 recipe 下显式采用的结果输出 | representations.set/remove |

结果本身也是 artifacts 的一行，kind=`result`，MIME=`application/vnd.themelios.result+json`，正文放 CAS，格式为 `ResultManifest`，带固定 `format:'themelios.result/1'`。正文保存 value、规范化后的 inputs、files、producer、可选 mappings，以及直接依赖的 upstreamResults。files 是名称到 SavedFile 的对象，SavedFile 保留 `{material:Selection,sourceIndices:number[]}`，下标仍指该 manifest 的 inputs。结果行的 ref、created_at/cut 保存在 artifacts，不在 manifest 重复保存。

artifact_edges 是正文的机械索引，ordinal 按每种 relation 的遍历次序分配。input 包括所有 source 和 delivered 选区；file 包括各命名文件的 material；copy 包括精确映射的 source；representation-source 包括 upstreamResults 中的生产结果，选区为 `{ref:upstreamResultRef}`。同一目标出现多次可按不同 ordinal 保留，原始角色及顺序仍以 manifest 为准。读取结果通过 manifest 取得完整内容；来源查询和回收直接使用边索引。

upstreamResults 是 ResultOutput 归一化前直接引用的结果 ref，按首次出现顺序去重。它保留“这份文件来自哪次完成结果”的事实：B 使用 A 的命名文件时，B 既依赖文件字节，也依赖 A 的 producer、输入与每个文件的 sourceIndices。只保存 B 后回收，A 仍通过这条边可达。普通 Selection 输入不反向推测其所有曾经消费者；文件被别的结果复用，也不会因此自动把那些结果变成来源。

## 接纳材料先捕获真实字节，再提交来源

`materials.accept(input, options)` 等价于 prepare→一次 write/adopt→close。输入可为 InlineMaterial、本地文件或带 MIME 的字节流。网络来源由 source adapter 使用 Network 获取，再把 body 和 Origin 交给 Content。

prepare 的具体流程：

1. InlineMaterial 捕获当前 bytes；本地文件打开一个只读句柄并从该句柄读取；流在本次调用期间只消费一次。名称取显式 name、文件 basename 或空值。
2. 内联大小限制为 `content.maxInlineBytes`，流/文件导入限制为 `content.maxImportBytes`。文件大小在实际读取时累计，禁止依赖可能过时的 stat 作为唯一计数。
3. MIME 显式提供时使用该值，并核对已知图像/PDF 文件签名；未提供时用 `file-type` 识别二进制，文本依扩展及有效 UTF-8 识别，最终落到 application/octet-stream。未知格式仍可原样保存。
4. 文本声明 UTF-8 时用 fatal 解码检查编码；保留原始字节、BOM 和换行。图像用 sharp.metadata 读取尺寸、EXIF 方向与帧数，extent 使用应用方向后的尺寸。其余未解析格式保存 `{kind:'unknown'}`；PDF 的实际页数由 PDF 扩展在需要使用时探测。
5. 流式发布 CAS，生成一次 ArtifactRef，准备 immutable metadata。Origin 保存 source kind、经过凭据清理的 locator、捕获时间及必要源元数据。
6. 返回 PreparedMaterial。adopt(tx) 插入 artifacts 和当前 root，created_seq/at 使用该 tx；close 关闭剩余句柄和准备资源。应用自己的行可以在相同 tx 内引用返回的 ref。

同一 prepare 对象重复 adopt 只定位其预先分配的同一 ref，并核对记录一致；已提交后再次 adopt 不追加 root 区间。prepare 所在的 Content/Database 与 tx 不一致时报 `content.transaction_mismatch`。事务回滚允许该准备对象在关闭前重试。

来源中的 URL 去掉 userinfo 和已知凭据参数；请求头和认证令牌由 Network 持有。原文件路径只记录确有用途的用户路径，远程客户端不能提交任意服务器路径。

## 读取只取得已存在的材料

inspect 同步查询 ArtifactInfo，kind、MIME、长度、extent、来源和提交位置均来自 artifacts。所需 ref 没有正式记录时，材料与成果入口返回 `content.not_found`，details 含 ref。read(ref) 返回完整 CAS 流及 info，调用方负责消费或取消。text(selection) 支持 text/plain、text/markdown、application/json 和结果 manifest 的 JSON Pointer；超出支持范围报 `content.text_unavailable`，由显式准备操作生成文本表示。

text 字节选区先检查边界和大小，再读取对应范围；编码边界错误报 `content.range_invalid`。JSON Pointer 用标准转义解析实际 JSON 值，未知字段和非法数组下标报同一错误；value 呈现方式遵循公共合同。

structure(ref) 对 Markdown 使用 unified/remark-parse + remark-gfm；普通文本按连续非空段落分块。输出 TextBlock 包含类型、实际文本和原字节 Selection；Markdown 标题附 depth。结构块选择顶层可独立阅读的块，列表/引用内部信息由同一块文本保留，避免把每个 AST 节点都变成永久对象。解析结果可在当前进程以 blobRef 为键缓存，实例关闭即可释放。

解析器输出的 UTF-16 offset 通过原文代码点前缀表转换为 UTF-8 字节位置，保留 CRLF、emoji、组合字符和代码块。块文本通过原件 Selection 再读取得到，保证定位与内容一致。全文索引、嵌入、生成描述由明确的上层操作调用。

sources(ref,{depth=1}) 返回直接或有限深度展开的 SourceLink，按关系与 ordinal 稳定排序；相同 selection/relation 去重，访问集合防止重复展开。depth 范围 1..16。list 默认列当前 root，limit 默认100、范围1..1000，按 ArtifactRef 字典序分页；at 使用 `retained_seq<=cut AND (released_seq IS NULL OR released_seq>cut)` 并检查 history_floor。

export(ref,destination) 将完整原件流写入目标的同卷临时文件，flush/fsync 并关闭后，以 `fs.link(temp,destination)` 排他建立最终名称，再 unlink 临时名称；已有目标使 link 返回 EEXIST，映射为 `storage.already_exists`。实现者可在支持的平台用等价的原子 no-replace 操作；普通可覆盖 rename 不满足此发布语义。选区文本用 text 取得；裁切后的图像/页/时段由输入准备产生具体输出，再按其正式引用导出。

## 保存结果采用一次准备、一次同步事务

`results.save(completed)` 的唯一实现路径是 `prepare(completed)` → `database.write(tx => prepared.adopt(tx))` → close。结果准备算法如下：

1. 对 value 执行有限 JSON 检查；验证 files 名称唯一、sourceIndices 合法、producer 和 mappings 形状完整。错误带 JSON Pointer 字段位置。
2. 使用本次调用的 WeakMap 记录已经遇到的 Completed/InlineMaterial 对象；先深度处理 ResultOutput 依赖，再处理当前结果。递归栈检测对象循环，报 `content.result_cycle`。这份映射只服务一次保存，完成后释放。
3. Selection 指向已有 artifacts，检查引用存在和可确定的范围；SavedResult 以其 ref 从当前数据库读取为准。新 InlineMaterial 发布 CAS 并分配 material ref。一个内存对象在本次保存中使用同一个 ref；两个独立接纳的同内容对象保留两个来源身份。
4. 对每个子 Completed 生成结果 ref，处理其 files，并把所有 source/delivered 归一为 Selection。files 的名称成为 map key，原 sourceIndices 原样保存，material 归一为 Selection。遇到 ResultOutput 时先把其结果 ref 加入当前 manifest 的 upstreamResults，再选择输出：`$value` 指子结果 `/value`，命名文件取 `files[name].material`。文件来源下标属于其生产结果的 inputs，下游仍通过结果关系解释它。
5. 验证 CopyMap 的输出和源片段实际字节相同。媒体转写、PDF 文本提取和模型生成的语义关系保留在 inputs，分别指原件及实际送入的表示。
6. 序列化 `ResultManifest` 为 UTF-8 JSON 并发布 CAS。manifest 在 `Omit<SavedResult,'ref'>` 基础上增加固定 format 与 upstreamResults，文件的 sourceIndices 也在其中。未产生来源 ID 的任何模型字符串都保持在 value 中，任务自己的 validateOutput 负责本次 SourceDirectory 短键。
7. 返回 PreparedResult，其中已含所有新 artifacts、边、根和 manifest 的待写记录。整个准备阶段完成后才开始数据库写入。

adopt(tx) 按依赖在前的顺序插入全部 artifacts，再插入机械索引边和顶层 root。子结果/内部文件由来源关系保留；显式传入的既有 Selection 不新增来源身份。引用验证与实际 INSERT 位于同一事务；CAS 字节已在此前发布。

准备阶段若失败，正式状态保持原样；已发布字节由离线 collect 回收。adopt 失败回滚全部新记录。adopt 成功返回 SavedResult，普通调用方可以立即读取 value 或继续传给下游。

重复调用 `save` 是两次显式保存，产生两个顶层结果引用；一个 PreparedResult 对象的 adopt 使用同一组分配好的 ref。接口没有通用幂等台账。网络端的 persist 请求提交后断线时，客户端通过结果列表和请求 trace 查找完成记录。

## 结果读取独立于当前模型和任务定义

`results.read(ref)` 检查 kind=result，读取 CAS manifest，按当前 manifest 格式解析并返回 SavedResult。读取不加载任务注册表、模型连接或 Prompt。调用方提供 `results.read(ref,schema)` 时，再校验 value 是否满足它当前需要的类型；不匹配报 `content.schema_invalid`，存储内容保持原样。

读取时检查 manifest 的字段、所引用 artifacts 和 upstreamResults 存在；源选区在使用时依据其材料类型验证。SavedResult 提供可直接消费的内容，`materials.sources(saved.ref)` 同时返回直接生产结果的 representation-source 关系，调用方可继续 results.read 取得上游生产信息。离线验证可遍历所有结果及索引边，发现损坏时报告具体 ref/blobRef，而不是用空值继续生成结果。

## 表示是显式采用的派生成果

确定性转换和生成式文本化都先产出 Completed。需要复用时，调用 results.save，再调用 representations.set({source,purpose,recipe,result,output})。set 检查 result 为已保存结果，output 存在，并在一笔事务中结束旧活动行、插入新活动行。

range_key 使用 Selection.range 的固定字段顺序 JSON 序列化，无范围用空串。recipe 是配方的完整语义标识：确定性配方包含版本和影响结果的参数，例如 `image.resize/1:maxEdge=1600`；显式采用的检索描述以对应文本化任务名和资源版本为身份。改变参数后使用新的 recipe，或明确重新采用相同槽位的新结果。

find 返回当前相同 source/range/purpose/recipe 的表示；remove 结束活动区间。普通 materials.read/text 不自动选择表示。输入准备可以在已选定的配方下查找可用表示；检索文本化通过 `purpose='retrieval-text'` 独立管理。原生模型可以直接使用原件，同时另行准备文本供未来索引消费。

## 这些操作成为内容层的完成条件

| 实际操作 | 可观察完成条件 |
| --- | --- |
| 原文含中文、emoji、CRLF 和代码块，structure 后逐块 text | 原字节选区精确回读，拼接/复制没有 UTF-16 偏移错误 |
| 图片→描述→结构提取，最后只保存末端结果 | 上游两份完成值与原件可追溯；保存前下游已经能直接运行 |
| 两个引用指同一 blob，其中一个被释放 | 另一个引用可读，来源身份仍分别存在 |
| 关闭模型配置后读取旧结果 | value/files/inputs 完整读取，读取不产生模型请求 |
| 非 Nous 应用在同一 tx 采用材料并写业务行 | 任一业务约束失败时两者共同回滚 |
| 提高 history_floor 后离线 collect | 保留结果仍能展开完整来源；已无保留关系的字节被回收 |

实现按 `materials.ts`、`results.ts`、`representations.ts`、`text-structure.ts` 与 `schema.ts` 组织。共同的 prepare/adopt 代码仅留在 Content 的真实所有者内部，公开 SDK 保持上述完整操作。

依据：[unist 的 UTF-16 位置定义](https://github.com/syntax-tree/unist)、[remark](https://github.com/remarkjs/remark)、[sharp metadata](https://sharp.pixelplumbing.com/api-input/)、[file-type](https://github.com/sindresorhus/file-type)。
