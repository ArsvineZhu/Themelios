# 完整使用路径决定本期完成状态

本计划交给实现者执行。它把模块检查接到真实应用、外部消费者与发行物上；本 Spec 自身的静态检查另记在 [交付检查](../research/delivery-checks.md)。付费模型调用由 `test:live` 读取明确配置，其余确定性检查沿现有 `check:repo` 和对应包测试运行。

每条路径保留能够复用的脚本和简短结果：实际命令、采用的版本/平台、产出引用或文件、失败的具体位置。修复已经定位的问题后重跑受影响路径；局部文字或资源改动按其影响范围验证。

## 验收输入同时覆盖文字、媒体与独立业务

| 输入 | 具体内容与准备方式 | 检查的行为 |
| --- | --- | --- |
| 简短摘要 | 本包 [summary-request.json](../examples/summary-request.json) 和 [summary-material.txt](../examples/summary-material.txt) | 一次真实结构化生成、默认变量、来源短键 |
| 精确文本 | UTF-8 字节表示 `A\r\n中🙂Z\n`，保留 CRLF | `[3,10)` 解码为 `中🙂`；截断汉字或 emoji 的选区失败 |
| Markdown | 含标题、段落、链接和 fenced code，至少有中文和非 BMP 字符 | remark 的 UTF-16 offset 转为真实 UTF-8 字节；结构选区可以回读原文 |
| 图片 | 用 sharp 生成带明显分区的 400×300 PNG；再生成一份带 orientation 元数据的 JPEG | 坐标基于应用方向后的像素面，裁切/缩放结果尺寸与区域准确 |
| PDF | 用 PDF-LIB 生成两页，分别含 `PAGE ONE`、`PAGE TWO`；另有一页只含图片 | PDF.js 真实提取、页选区、扫描页路线与缺失能力错误 |
| 业务 CSV | 库存示例里的 first.csv、second.csv；包含正常行及 FAIL 行的第三份合法 CSV | 原子导入、历史切面、引用、真实约束失败回滚 |

这些材料由测试代码通过正式依赖创建或从本包复制；媒体转换调用实际 sharp/PDF.js。真实模型验收使用一个可用文字模型和一个实际视觉配置。音视频扩展若随应用启用，再加入与所启用配方对应的真实媒体；基础发行不因未启用外部媒体工具增加安装负担。

## 普通脚本可以只使用模型与 Prompt

在仓库外的新目录安装本批 Core、Runtime、Models、Application tarball 及它们的正式依赖；复制 embedded-summary.ts、任务定义、resources 和 summary-material.txt。提供 `THEMELIOS_MODEL_URL`、`THEMELIOS_MODEL_ID` 与凭据引用对应的环境值，运行：

```sh
bun run embedded-summary.ts
```

必须得到经过任务 Zod 和来源校验的 `Completed.value`，含 title、sections、notes；section.sourceKeys 都属于本次目录。该脚本直接使用 createModels/createPrompts/createPreparation/createTasks，目录中不产生实例、SQLite 或安装锁文件。Models.close 释放本次连接。

另用同一 Prompt 资源单独编译一次默认变量；由生成参考取得完整 variables/output Schema，故意省略一个无默认必填字段或引用未知变量，应得到带任务/模板/字段位置的错误。真实请求的用量与模型信息来自服务实际返回值；凭据只以引用进入诊断。

同一 binding 的重试用可控本地响应源检验机械行为：首次 429 后成功、持续失败、流已产生文字后失败。观察总尝试数和取消。真实模型只需覆盖实际成功输入及其结构/来源语义。

## 文档工作台贯穿导入、编辑、执行与重开

创建独立安装根，在已构建工作台或 Portable 的命令目录执行以下操作。`themelios` 代表本平台正式启动器；所有命令选择同一个 installation/instance。先把 [themelios.toml](../examples/themelios.toml) 合并到人工配置文件，填入实际模型 ID 和对应凭据引用。

```sh
themelios --installation ./demo instance init
themelios --installation ./demo material import --file ./summary-material.txt --json
themelios --installation ./demo task describe document.summary --json
themelios --installation ./demo task preview --input ./summary-request.json --json
themelios --installation ./demo prompt read document.summary --part user > edited.liquid
themelios --installation ./demo prompt edit document.summary --part user --file ./edited.liquid
themelios --installation ./demo prompt diff document.summary
themelios --installation ./demo task run --input ./summary-request.json --save --json
```

中间实际编辑 edited.liquid，使任务强调当前进度；再次 preview 应显示有效模板变化、完整来源目录和实际发送的 parts。程序追加材料正文一次，模板只编辑说明和目录。首次 preview 不调用模型；启用模型描述准备时，preview 显示 pending 的明确任务和模型。

把导入返回的 Selection 填入请求的 `materials[0].source`，再执行一次任务，以此覆盖正式引用输入。将输出的 SavedResult.ref 交给 `result read`、`material sources`；导出原件到一个不存在的目标。关闭工作台，取消模型凭据或断开模型网络，重新打开后读取同一 SavedResult、具名文件及来源仍成功。

对应检查应看到：

- 返回结构通过实际任务 Schema；source key 与 InputUse 一一对应，正式来源显示为真实材料/选区。
- 保存后 value、producer、inputs 和 files 都能回读；文件 bytes 与保存前一致。结果读取无需任务定义和模型仍然存在。
- 原件导出与输入逐字节一致；目标已存在时拒绝覆盖，失败信息包含目标路径。
- `run` 将同一材料数组作为共同上下文；`runMany` 对每个请求分别生成并保持输入顺序，某项失败保留其他项的成功。
- 机器模式 stdout 是一个 JSON 或约定 NDJSON；进度/日志在 stderr，失败返回非零状态与稳定 code。

## 媒体准备保留原件、实际交付与转换来源

继续在同一文档工作台接纳 PNG/JPEG/PDF。为每次运行选一个固定 binding，并先 preview 再 run，验证以下路线：

| 操作 | 必须观察到的实际结果 |
| --- | --- |
| 原生图像模型读一个区域 | 朝向、crop、resize 次序正确；输入是该区域生成的图片 bytes，delivered 指向转换成果 |
| 文字模型读 PDF 第 2 页 | 扩展只提取 PAGE TWO；InputUse.source 是原 PDF 的页选区，delivered 是提取成果的文字文件 |
| 原生 PDF 模型读页选区 | 实际提交的是只包含选中页的新 PDF，原件和派生文件均保留来源关系 |
| 扫描页交给纯文字配置 | 在模型主调用前报告缺少文字/视觉准备能力，指出具体页与可配置配方 |
| 为任务显式启用 media.describe | 先执行图像描述，再把完成值交给文字摘要；两次模型调用分别有自己的 producer 与来源 |
| 把已完成 A 的文件交给 B，最后仅 save(B) | A、文件和原件随 B 在一次采用事务中保存；B 的 upstreamResults 保留生产结果 A，回收后 sourceIndices 和整条来源链仍可读 |
| 对材料运行 retrieval-text | 生成可用于检索的独立普通成果，不改变该材料的主任务模型准备选择 |

对文字成果使用 CopyMap 时逐字节比较原/目标选区。模型改写、PDF 提取、描述和转写只声明实际来源关系，不能产生没有字节相等依据的精确复制映射。

图像/PDF 操作同时在正式包消费者与 Portable 上至少完成一次，以捕获 Native 共享库、worker、字体或资源目录缺失。转换完成值在内存和保存后的读取语义相同。

## 各协议消费同一能力并正确终止流

使用已保存的相同材料，依次通过 CLI、HTTP、MCP、gRPC 读取、预览和运行 document.summary。模型自然语言输出可以有差异；应一致的是输入结构、来源、保存选择、动态校验、权限和失败 code。确定性读取的值应完全一致。

| 入口 | 实际操作 | 观察点 |
| --- | --- | --- |
| SDK | 从 ApplicationApi 调用 tasks.run/stream，随后 results.read | 得到正式 Completed/SavedResult，提前 break 进入清理 |
| CLI | `task run --input request.json --save --json`；另一次 `--stream --json` | 正常 JSON、单次终止结果、CTRL+C 后上游停止 |
| HTTP | 原始 bytes POST 到 `/v1/materials`，用 Selection POST 到任务 `/run`，再 GET result/content | 二进制不被 base64 放大；Content-Type、权限和大小限制正确 |
| HTTP SSE | POST 到任务 `/stream`，读取 progress/text-delta/result；首段后断开 | 事件顺序正确；断开后取消 provider，实际 reader 在 finally 关闭 |
| MCP stdio/HTTP | 官方 client 发现 tasks_describe、tasks_preview、tasks_run 并调用 | 完整 Schema、structuredContent 与可读内容相符；日志不占 stdout |
| gRPC | 正式客户端调用 UploadMaterial、RunTask、ReadMaterial、StreamTask | 双向分块语义正确，HTTP/2 status/trailers 与 Failure detail 可读 |

协议验证使用真实 socket、stdio 进程和官方客户端，业务输入使用真实应用。补两项能暴露编码错误的请求：包含内联字节及 ResultOutput 的未保存 Completed；包含 null、缺省可选字段和大整数提交位置的结果。编码/解码往返后与公共 Schema 一致。

分别用只有 read 权限的令牌和完整权限令牌调用付费任务；前者在执行前返回权限失败，后者正常进入。对同一非法选区，HTTP/gRPC/MCP 保留同一个错误 code，映射到各自正确状态。gRPC 客户端设置短 deadline，既观察客户端结束状态，也观察服务端实际清理完成。

总 JSON 超过 transports.maxJsonBytes 时，返回具体大小限制和 Selection/persist 路径。大文件通过上传、已保存引用和流式下载完成。不得通过测试专用直调 handler 绕过这一条真实网络路径。

## 配置更新、取消和故障在真实完成点收束

在本地可控模型端点打开一条持续流，再修改 connection、代理或相关可重载字段。确认新调用使用新资源，已开始的流继续使用原快照；旧资源只在真正 finally 后关闭。重启类字段显示 desired 与 effective 差异，实例重开后才使用新值。

同时检查下列具体分支：

| 场景 | 预期结果 |
| --- | --- |
| 设置字段越界或 TOML 解析失败 | 候选失败，文件/有效配置/运行资源保持原状态；错误指出实际字段或行列 |
| 准备新资源失败 | 释放新候选已建立资源，原有效资源继续服务；不发布半套配置 |
| managed.toml 写入失败 | 不交换资源指针；给出文件路径和底层原因 |
| 流已输出正文后 provider 失败 | 该调用失败并关闭；不生成成功成果，不在同一流自动换模型 |
| 数据库提交前取消 | 正式材料与业务行没有提交；已发布孤立 CAS 留待回收 |
| COMMIT 后收到取消 | 返回已经保存的结果；清理/通知失败进入诊断 |
| 两个进程打开同一实例 | 第二个返回 instance_busy；首进程退出后系统锁释放 |
| 两个嵌入 Session 使用不同语言和日志目录 | 翻译/trace/log 归属正确，不出现全局语言或 provider 串用 |

关闭期间停止接纳新请求，取消或等待已在运行的操作，真实停止后释放句柄。用一次仍有活动流的关闭操作检查诊断中的任务、阶段和 deadline。观察回调抛错只记录 observer.failed，保持该操作自己的完成状态。

## 库存应用在外部目录完成真实业务

按 [库存 README](../examples/inventory/README.md) 从正式 tarball 安装并执行 first.csv、second.csv 的导入。它有自己的安装、配置、领域表与 CLI。第一次导入后 PEN=12、BOOK=0；第二次后 PEN=7、PAPER=1000000000、BOOK=0。按第一次 cut 查询仍读到初始库存，历史视图不泄露后续才发生的版本结束位置。

在临时验收实例添加 README 所示 SQLite 触发器，使包含 FAIL 的第二行在数据库中失败；整个导入的业务行、材料采用、commit_seq 都必须回滚。导出两份 CSV 与输入逐字节相同。将 Content 源码目录临时移出包解析范围后，消费者继续依靠已安装 tarball 运行。

这个应用完成后，实施者已经证明：Runtime 可以承载自己的 API，Storage 可以服务自己的表，Content 可以参与应用拥有的事务；应用无需借用任务工作台的领域对象。业务规则与平台能力的分界见该示例源码。

## 维护保留已经提交的事实并明确历史下界

关闭普通服务后，在同一个实例执行：

```sh
themelios --installation ./demo storage verify
themelios --installation ./demo storage backup ./backup-demo
themelios --installation ./restored storage restore ./backup-demo
themelios --installation ./restored result read SAVED_RESULT_REF --json
```

目标路径均事先不存在。恢复后检查 SavedResult、原件、来源、实例身份和 Prompt 覆盖一致。备份时复核引用字节哈希；在一份验证备份中故意改坏一个对象，restore 必须在发布正式目标前报告具体损坏。普通实例保持原样。

回收用单独临时实例：保存根 A、由 A 生成并保存根 B；释放 A；以当前 cut 为 retain-since 回收。B 仍引用 A，因此 A 字节保留。释放 B 后，在保留界线推进到释放提交的情况下再次回收，A/B 的不可达对象才删除。历史查询早于 history_floor 返回 storage.history_unavailable 并告知下界。两个不同 ArtifactRef 共享相同 BlobRef 时，保留任意正式引用就保留该字节对象。

在“CAS 已发布、SQL 尚未采用”处中止进程，重新打开后没有半条正式结果；collect 删除孤立字节。在“元数据回收已提交、文件清理尚未结束”处中止，重新执行 collect 可以清理残留。进程中止检验恢复次序；文件同步和目标 OS 的持久性行为仍遵循对应实现与文件系统。

## 时间域在历史切面上保持相同解释

用 timeSchemaSql 创建 domain=`world.school`、ticksPerSecond=1000 的域，初始映射从 `2026-01-01T00:00:00.000Z` 起以 2/1 运行。+1000ms 对应 ticks=2000，原点之前通过 floorDiv 计算。保存 cutA 后覆盖某窗口为 rate=0/1，再取得 cutB。

在 cutA 查询仍得到旧映射；cutB 的暂停窗口映射到同一 ticks，其 toUtc 返回整个有效窗口。窗口外的左右剩余映射继续有效。补一个非整数比率，直接按 [时间公式](../spec/time.md) 计算期望半开区间，检查零长度交集不返回。模拟 UTC 回拨时，活动调用期限继续依据单调时钟结束。

## 正式包和 Portable 在目标环境完成交付

跨包集成完成后运行 `bun run check:repo`、`bun run build:packages`、`bun run pack:packages`。在仓库外消费目录运行上述独立模型和库存路径。正式包 exports、声明及资源全部来自 dist，内含 workspace/catalog 的实际依赖已经转为普通版本。

分别在目标平台执行构建与发行路径：

```sh
bun run build:portable -- --target windows-x64-msvc
bun run build:portable -- --target linux-x64-gnu
bun run test:distribution
bun run test:live
```

每个平台使用其真实运行依赖和 Native 构建；命令在相应支持的主机上执行。Portable 解压到独立目录后初始化实例，完成文本/图片/PDF、任务、保存、关闭与重开。然后移动整个目录到含空格和中文的路径，隐藏开发者 Bun/Node、源工作区及包缓存，再执行读取、导出、图片转换、MCP stdio 和 gRPC。

最终交付每个平台的发行文件、npm tarball、简短使用说明、两份独立应用及已执行结果。缺少某目标 OS 或真实模型凭据时，记录受阻的明确路径及需要的输入，完成所有可执行部分；产品完成声明依据实际执行结果。
