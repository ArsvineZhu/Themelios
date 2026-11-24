# 库存登记应用直接消费 Themelios 公共包

这个应用把一份 CSV 原件和其中的库存记录在同一笔提交中保存，并能读取指定提交位置的库存和历史。它使用 Runtime 的安装与会话、Storage 的事务与 CAS、Content 的材料准备与采用；业务 API 完全由应用自己定义。

## 一次导入更新列出的 SKU，并保留来源

CSV 使用 UTF-8，可带 BOM，表头必须恰好为 `sku,name,quantity`，列顺序固定。带引号的逗号和换行按 CSV 规则解析；空行忽略，字段内容保持原样。

| 字段     | 允许值                                                      |
| -------- | ----------------------------------------------------------- |
| sku      | 1–64 个大写字母、数字、点、下划线或连字符；同一次导入内唯一 |
| name     | 1–200 个字符，至少包含一个非空白字符                        |
| quantity | 0–1000000000 的十进制整数；除 0 外没有前导零                |

每份导入声明其中各 SKU 的最新名称和数量。上一次活动版本的 `valid_to_seq` 设为本次提交位置，新版本的 `valid_from_seq` 取同一位置；未列出的 SKU 保持当前值。数值相同的再次导入仍记录一次新的来源声明。

一次导入只有一个 `source_ref`，所有数据行共享这份完整 CSV 材料。`source_record` 是表头之后从 1 开始的数据记录序号；带引号的字段可包含换行，因此它不表示物理行号或字节偏移。

## 文件捕获、验证与提交顺序固定

1. 读取本次根操作捕获的配置；按实际读取字节累计文件大小。默认上限为 2 MiB，允许在 1 byte–8 MiB 内配置。
2. 捕获整份字节、严格解码 UTF-8、解析 CSV、检查全部记录。默认最多 5000 条，允许 1–100000 条；超过上限时解析立即退出。
3. 把已经解析过的同一份字节交给 `materials.prepare`，保留提交的文件名与捕获时间。
4. 在进入同步事务前检查取消；`database.write` 内调用一次 `prepared.adopt(tx)`，再写导入记录、结束旧版本、插入新版本。
5. COMMIT 成功后返回 `{cut,sourceRef,rows}`，最后释放准备对象。旧引用与新库存行共同提交；任意业务写入失败时共同回滚。

Content 的采用操作同时保留顶层材料，应用无需为每条库存行重复保留。该示例保留全部库存历史和源文件；未来增加历史清理时，应用先确定业务保留范围，再协调其来源根的释放。

`list(at)` 在一个读快照中选择截止位置，只返回该位置有效的版本。`history(sku,at)` 返回截至该位置已产生的全部版本；当某版本在更晚的提交才结束时，此次历史查询仍返回 `validTo:null`。提交位置用十进制字符串跨 API，SQL 内使用 bigint。

## 源文件按所有者组织

| 文件                                          | 内容                                                                |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `main.ts`                                     | 应用设置、CSV 验证、ApplicationModule、业务操作与 HTTP/MCP/CLI 入口 |
| `schema.sql`                                  | 库存导入及版本表，含数量范围、当前版本唯一性和来源约束              |
| `package.json`                                | 实际消费包及 CSV/Zod 依赖                                           |
| `resources/locales/{zh-CN,en}/inventory.json` | 设置说明与应用错误词典                                              |

`Database.init` 自建 Storage 的提交元数据表。应用通过 `@themelios/content/schema` 取得 `contentSchemaSql`，与自己的 SQL 一起初始化；这个应用没有时间域映射需求，因此无需加载 time 表。

设置使用 `combineSettings(runtimeSettings, inventorySettings)`。两个业务字段分别是 `inventory.maxFileBytes` 和 `inventory.maxRows`，在下一次导入生效；Runtime 的日志、代理、语言和关闭设置继续由 Runtime 定义。Content 的固定导入上限设为示例允许的最大值 8 MiB，每次实际导入再应用本次配置的更小限制。

应用词典通过 `ApplicationModule.locales` 注册。业务操作使用 `@themelios/runtime/operations` 声明，由 `@themelios/transports` 将同一操作目录开放给 CLI、HTTP/SSE 与 MCP。

## 从仓库外目录安装发行包

在 Themelios 仓库运行 `bun run pack:packages -- core runtime storage content transports`。将本示例目录复制到仓库外的空目录。

在 Themelios 仓库运行，指定消费目录：

```sh
bun scripts/install-packages.ts ./artifacts/packages /ABS/CONSUMER
```

进入消费目录，初始化实例：

```sh
bun run main.ts --installation ./demo instance init
```

安装脚本让各包之间的依赖也使用同一批本地发行包。Bun 同时安装 CSV 解析器和 Zod，并生成消费目录自己的锁文件。

`./demo` 是安装根，默认实例位于 `./demo/instances/default`。CSV 和导出目标按命令调用目录解析；启动器不改变当前目录。`instance init` 只执行一次，后续命令均使用已初始化的默认实例。

## 两份导入贯穿当前值、历史值和原件回读

保存 `first.csv`：

```csv
sku,name,quantity
PEN,黑色签字笔,12
BOOK,练习本,0
```

执行：

```sh
bun run main.ts --installation ./demo --json import ./first.csv
bun run main.ts --installation ./demo --json list
```

首次导入返回 `cut:"1"`、一份 `sourceRef` 和 `rows:2`；当前列表按 SKU 排序，BOOK 数量为 0，PEN 数量为 12。保留这次返回的 `sourceRef`。

再保存 `second.csv`：

```csv
sku,name,quantity
PEN,黑色签字笔,7
PAPER,A4纸,1000000000
```

执行以下命令，其中提交位置以导入返回值为准；全新实例只执行本节操作时依次为 1、2：

```sh
bun run main.ts --installation ./demo --json import ./second.csv
bun run main.ts --installation ./demo --json list
bun run main.ts --installation ./demo --json list 1
bun run main.ts --installation ./demo --json history PEN
bun run main.ts --installation ./demo --json history PEN 1
bun run main.ts --installation ./demo --json export FIRST_SOURCE_REF ./first-restored.csv
```

可观察结果如下：

| 操作                    | 应得到的业务事实                                                    |
| ----------------------- | ------------------------------------------------------------------- |
| 第二次导入后的 list     | BOOK=0、PAPER=1000000000、PEN=7；未列出的 BOOK 仍保留               |
| list 1                  | BOOK=0、PEN=12；没有 PAPER                                          |
| history PEN             | 第一版 `[1,2)`、第二版 `[2,∞)`；sourceRef 分别对应两份 CSV          |
| history PEN 1           | 只返回第一版，validTo 为 null                                       |
| export FIRST_SOURCE_REF | 导出文件与 first.csv 的字节完全一致，包括原来的 BOM、换行和引用格式 |

CLI 和监听服务打开实例时持有实例锁。终止尚在读取的导入会取消工作，已提交的记录和原件继续可读。

## HTTP/SSE 与 MCP

让进程读取 `THEMELIOS_INVENTORY_TOKEN`，运行 `bun run main.ts --installation ./demo serve`。启动后从标准错误输出取得监听地址。HTTP 和 MCP 客户端携带 `Authorization: Bearer …`。

- `POST /inventory` 接收 `text/csv` 字节并返回提交位置。`POST /inventory/import-stream` 返回 SSE 进度和最终结果。通过查询参数 `name` 提供原件名。
- `GET /inventory` 和 `GET /inventory/PEN/history` 读取相同实例，传入 `?at=1` 可查询历史切面。用 `GET /inventory/source/<ref>` 下载原始 CSV。
- MCP 地址为 `/mcp`。调用 `inventory_history` 查询一个 SKU，或调用 `inventory_import` 并传入 Base64 的 `bytes`。使用本地 stdio 时，MCP 客户端启动 `bun run main.ts --installation ./demo mcp`。

## 导入错误与回滚

可以用当前实例检查以下行为。

| 场景                                            | 验收内容                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| CSV 出现重复 SKU、负数、1000000001 或非法 UTF-8 | 调用失败；cut、artifacts、inventory_imports 和 inventory_versions 不变 |
| 将 maxFileBytes 降低后导入超限文件              | 本次配置生效，累计读取超过上限就停止，未建立正式材料                   |
| 合法 CSV 的第二行在写入时违反 SQL 约束          | 前一行更新、材料采用、导入记录、提交位置共同回滚                       |
| 再次导入同一份 CSV                              | 形成新的来源身份和新版本，CAS 字节可复用                               |
| 查询尚未提交的 cut                              | 返回 inventory.invalid_cut，并给出当前最新 cut                         |
| 在只读 Session 中调用 importCsv                 | 返回 runtime.read_only，文件读取和 CAS 写入尚未开始                    |

事务回滚用临时验证实例中的 SQLite 触发器制造真实写入失败：在 `inventory_versions` 上对 `NEW.sku='FAIL'` 执行 `RAISE(ABORT,'fixture')`，再导入包含正常行和 FAIL 行的合法 CSV。失败后检查全部正式表和 cut 与之前相同，再删除这个验证触发器。准备阶段已发布而未被正式采用的 CAS 字节可留待正常离线回收。

## CSV 能力采用成熟解析器

选择 `csv-parse/sync`，因为示例在明确字节和记录预算内完整验证一份文件后才进入事务。`columns` 回调检查精确表头，标准解析器处理引号、逗号及字段内换行，`on_record` 在记录数超限时终止解析。参考 [同步 API](https://csv.js.org/parse/api/sync/)、[columns](https://csv.js.org/parse/options/columns/) 和 [on_record](https://csv.js.org/parse/options/on_record/)。
