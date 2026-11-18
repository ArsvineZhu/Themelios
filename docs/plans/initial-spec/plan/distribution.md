# 包、协议与 Portable 按真实消费顺序完成

目标是让一个仓库外应用和一个已解压的工具使用同一套 Themelios 能力。本计划落实 [构建与发行](../spec/build-release.md) 与 [应用与协议](../spec/application-transports.md)，与总实施计划的存储、内容、模型和运行会话工作汇合。

依赖顺序为：包出口与基础构建 → 原生锁/协议实际装载 → 完整业务适配 → 仓库外消费 → Portable 目标平台使用。原生装载与协议装载可以在业务能力尚未齐备时并行完成，以便尽早消除运行时接缝问题；完整验收在实际材料和任务 owner 可用后执行。

## 将现有工作区接到正式包出口

**前置能力：** 已确定的包所有权、core 类型、现有 Agent 工具链。

**文件落点：** 各包 package.json、tsconfig.json；`scripts/build-packages.ts`、`scripts/pack-packages.ts`；现有 check:repo 和包边界检查脚本。若本机已有同责文件，直接在原处完成。

**实施步骤：**

- 读取真实 manifests/lockfiles，列出实际包依赖和 exports；按架构补齐缺失公开入口，迁移内部消费者。
- 给每个出口确定 dist JavaScript、声明与所属资源，接入现有 TS project references 和 Bun 构建。工作台通过正式 exports 使用包。
- 将包归属检查接入已存在的检查入口；合法包内相对路径保留，跨包按解析后 owner 判断。
- 打出 tgz，解包查看实际 manifest、公开入口和资源。任何 workspace/catalog 引用和发行缺失都在本次构建修复。

**可观察结果：** `bun run build:packages` 和 `bun run pack:packages` 产出真实 dist/tgz；一个不在 workspace 内的 Bun 程序可导入 core、models 与 storage 的公开入口。源目录改名后该消费者仍能运行。该场景保护包完整性，不建立额外产物资格表。

## 先接通原生锁和真实 HTTP/2

**前置能力：** runtime 原生锁合同、统一错误与基本会话；协议操作可以先使用应用已有的 instance.info。

**文件落点：** `native/runtime/`、`packages/runtime/src/native.ts`；`packages/transports/src/grpc/server.ts`、`proto/themelios/v1/application.proto`、现有协议集成测试目录。

**实施步骤：**

- 用当前 Rust/napi 工具链构建实际锁模块，放入 runtime 目标目录。两个独立 Bun 进程争用同一实例；首进程结束后，第二进程重新取得锁。实例路径覆盖空格与中文。
- 用 Connect-Node 接入 Bun `node:http2.createServer`。从正式 gRPC 客户端发起 instance.info；检查响应以正确 trailers 结束。
- 增加一个可取消的实际应用流后，检查客户端 deadline 和主动取消传到共同 CallOptions；服务端结束源迭代器并释放资源。
- 将遇到的 Bun/依赖兼容差异修在 transport/native adapter。若固定版本出现稳定复现的 runtime 缺陷，先用同版本上游支持的调用方式修正；需要更改用户固定运行时才作为明确阻塞上报。

**可观察结果：** Bun 进程执行真实文件锁；gRPC 客户端读到结果与结束状态，取消后没有继续执行的应用请求。检查针对这两个具体接缝，日常局部编辑只重跑受影响项。

## 用同一操作接通 CLI、HTTP、MCP 与 gRPC

**前置能力：** application 的 operations、materials/results/tasks/configuration；runtime 会话和共享错误。

**文件落点：** `packages/transports/src/{cli,http,mcp,grpc}/`，`apps/workbench/src/main.ts`，协议说明生成入口。

**实施步骤：**

- 按应用与协议章的固定操作表建立适配。未知请求由共同 Zod Schema 解析，handler 只调用应用 owner，协议层只负责身份、编码和结果呈现。
- 接通二进制导入与下载；远程参数中的客户端文件路径在客户端读取/上传，服务器仅处理实际 bytes 或已存在的 Selection。
- 接通 tasks.run/stream 的 Completed/SavedResult wire codec。stdout JSON、HTTP JSON/SSE、MCP structuredContent 和 Protobuf 中动态任务值使用同一序列化规则。
- 将断开连接、CTRL+C、MCP cancellation 与 gRPC deadline 合并到共同取消路径；最终结果只在操作完成后出现。
- 接通 `themelios storage backup <destination>`、`themelios storage restore <backup>`、`themelios storage collect [--retain-since CUT]`、`themelios storage verify` 和 `themelios storage migrate`，统一经离线实例锁调用 Storage 维护入口。`material export` 与 `--output` 写入不存在的目标，完整临时文件以排他步骤原子发布。
- CLI 正常打开自己的实例会话；另一个会话占用时报告 `runtime.instance_busy` 与已有 owner/已配置端点信息。对常驻会话的操作由显式连接的 HTTP、MCP 或 gRPC 客户端完成。
- 由实际操作 Schema 生成帮助、工具描述与 HTTP 文档；具体 task 的 variables/output Schema 来自任务定义。

**可观察结果：** 通过四个入口对同一已接纳材料运行相同任务，得到相同业务结构；错误 code 一致且各协议状态正确；模型只调用一次，保存失败按原错误返回；任一入口日志不会污染机器结果通道。

## 在仓库外完成独立消费

**前置能力：** 全部核心公共包、模型真实配置、完整材料/成果保存读取。

**文件落点：** `examples/embedded/` 的短示例；总验收指定的非 Nous 应用；`scripts/test-distribution.ts` 只负责临时目录、安装、运行和清理。

**实施步骤：**

- 把独立示例复制到仓库外临时目录，为它安装本批 tgz。消费者依赖以实际 tgz 满足内部包，自己的依赖和 lockfile 留在自己的目录。
- 执行只用 Models/Prompts 的调用，确认使用者只提供模型连接/模板/输入；无需创建实例或数据库。
- 执行只用 CAS 的 bytes put/read；执行总验收规定的非 Nous 数据应用，验证独立领域记录与 Themelios 的存储/配置/诊断组合。
- 执行文档工作台的文本/图片/PDF、任务输出和成果重开流程。保留简短可复用示例；调试用脚本在解决问题后清理。

**可观察结果：** 使用者能按 README 的完整短例完成实际工作，包消费者不依赖源码导入、父 workspace、开发者绝对路径或 Nous/Nexus。

## 组装并移动每个目标平台的完整发行物

**前置能力：** 当前平台所有运行依赖、上述独立消费完成、安装路径解析与实例身份确定。

**文件落点：** `scripts/build-portable.ts`、`scripts/test-distribution.ts`、启动器模板、`apps/workbench/resources/` 与发行说明。

**实施步骤：**

- 按构建与发行章组装 staging：固定运行时、应用闭包、生产依赖、真实 Native、默认 Prompt/语言/Schema/工具资源和许可。
- 将产物解压至与仓库无关的路径，执行 init、材料接纳、图片转换、任务执行、保存、关闭及重开。
- 把整个目录移动到含中文和空格的另一位置，隐藏开发者 Bun/Node 与源目录，再读取已保存的成果及来源。
- 关闭服务后执行 `themelios storage backup <new-backup-directory>`；向新的目标实例路径执行 `themelios storage restore <backup>`，再以 `themelios storage verify` 检查恢复内容并读取成果。
- 分别运行 HTTP/JSON、MCP stdio/HTTP 和 gRPC。对一条长请求取消，检查错误与上游取消。用两个进程检查实例互斥。
- Windows x64、Linux x64 glibc 分别运行一次这条完整使用链；保存对应发行文件和一段实际使用说明。

**可观察结果：** 每个平台得到可直接启动、可移动、能够完成真实任务的发行物。交付只记录已完成能力、文件路径、使用方式与尚存阻塞；公网发布和后续 Nous/Nexus 工作保持各自授权范围。
