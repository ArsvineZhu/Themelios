# 协议与发行的技术依据

查阅日期：2026-11-18。下表记录影响本包决定的资料；版本与二进制最终由实施仓的锁文件和目标平台构建确定。

| 资料 | 核实的事实 | 本包采用的决定 |
| --- | --- | --- |
| [Bun HTTP server](https://bun.sh/docs/runtime/http/server) | Bun.serve 支持 HTTP/2，但当前文档列明 response trailers 尚未提供 | HTTP/JSON 与 SSE 用 Hono/Bun.serve；原生 gRPC 使用独立 node:http2 监听器 |
| [Bun Node.js compatibility](https://bun.sh/docs/runtime/nodejs-compat) | node:http2 客户端和服务端已实现，仍有部分选项差异 | 使用 Connect-Node 的标准适配，实际检查 trailers、deadline 与取消，保持 Bun 产品运行时 |
| [Connect server plugins](https://connectrpc.com/docs/node/server-plugins/) | connectNodeAdapter 接入 http/http2；gRPC 需要 HTTP/2 | 直接 createServer(connectNodeAdapter(...))；协议层复用统一操作函数 |
| [Connect getting started](https://connectrpc.com/docs/node/getting-started/) | 服务由 Protobuf 定义，protobuf-es 生成类型；支持单次和流式 RPC | 固定传输信封使用 proto，任务 variables/value 使用 google.protobuf.Value；不复制业务执行器 |
| [MCP SDK v2 packages](https://ts.sdk.modelcontextprotocol.io/v2/get-started/packages) | v2 使用 @modelcontextprotocol/server 和 /client，服务端公开 export 替代旧深路径 | 使用 v2 公开入口；版本由锁文件固定 |
| [MCP web-standard serving](https://ts.sdk.modelcontextprotocol.io/v2/serving/web-standard) | createMcpHandler 返回 fetch；认证信息需宿主提供，Host/Origin 检查需入口启用 | 复用应用认证；MCP HTTP 只挂载 /mcp，入口校验已配置主机与来源 |
| [MCP stdio](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio) | serveStdio 管理连接、关闭与 EOF 取消；stdout 为协议通道 | stdio 入口使用 SDK handle；应用日志走 stderr；连接关闭传播取消 |
| [MCP first server](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server) | registerTool 接受 Zod 对象 Schema，并生成发现信息、校验输入和推导类型 | 工具复用操作 Schema 与同一执行函数，描述按用户任务组织 |
| [MCP Schema libraries](https://ts.sdk.modelcontextprotocol.io/v2/advanced/schema-libraries) 与 [Errors](https://ts.sdk.modelcontextprotocol.io/v2/servers/errors) | input/outputSchema 接受带 JSON Schema 转换的 Standard Schema；isError 结果跳过 SDK 输出校验 | 工具输出注册为单一对象 Schema，result/error 恰一字段由适配器在成功与失败两条路径检查 |
| [Bun workspaces](https://bun.sh/docs/pm/workspaces) | 工作区包声明依赖；打包时 workspace 版本转为普通版本 | 正式 exports 和 tgz 是独立消费边界；submodule 只负责源码固定 |
| [Bun catalogs](https://bun.sh/docs/pm/catalogs) | pack/publish 把 catalog 引用替换成实际版本 | 打包后检查普通 semver，与同批本地 tgz 一起供独立消费者安装 |
| [Bun isolated installs](https://bun.sh/docs/pm/isolated-installs) | isolated 采用 .bun store 与链接；可选 global store 位于项目外 | 开发仓沿用 isolated；Portable 在独立 staging 安装生产依赖，并关闭 global store |
| [Bun filter](https://bun.sh/docs/pm/filter) 与 [install](https://bun.sh/docs/pm/cli/install) | 名称后缀 `...` 选择依赖闭包；production 安装排除开发依赖，frozen-lockfile 保持固定解析 | 全新 staging 用 `--production --frozen-lockfile --linker hoisted --filter '<workbench-name>...'` 组装实际生产依赖 |
| [Bun pm pack](https://bun.sh/docs/pm/cli/pm) | pack 产生实际 npm 包 tarball，支持固定输出目录和简短输出 | 使用 bun pm pack 产生本地可安装包，再在仓库外消费 |
| [Bun type checking](https://bun.sh/docs/runtime/check) 与 [1.4.4 release](https://bun.sh/blog/bun-v1.4.4) | bun check 支持项目引用；--no-script 可避开同名脚本解析 | 保留仓库统一 check:repo，必要时在其内部调用固定的内置检查命令 |
| [Bun executable](https://bun.sh/docs/compiler/executables) | compile 支持 N-API；sharp 等仍需共享库布局；当前 AOT 支持嵌入资源目录 | 本期采用自带运行时的完整目录发行，单文件编译留作可替换发行实现 |
| [Bun runtime](https://bun.sh/docs/runtime) 与 [auto-install](https://bun.sh/docs/runtime/auto-install) | 运行时在缺少 node_modules 时可能自动下载依赖；`--no-install` 明确关闭该行为 | 正式启动器带该参数，依赖由发行组装提供，移动后无需从 registry 补包 |
| [sharp installation](https://sharp.pixelplumbing.com/install/) | sharp/libvips 按 OS、CPU、libc 分发，依赖 optional dependencies；支持 Bun 安装 | 按目标平台准备完整依赖，真实运行图像转换；发行保留许可证 |
| [sharp #4283](https://github.com/lovell/sharp/issues/4283) | 用户与维护者讨论编译文件中的 native/shared-library 装载问题 | 把真实图像操作及目录搬迁纳入发行验收，避免以编译成功代替可运行发行物 |
| [Bun #25635](https://github.com/oven-sh/bun/issues/25635) | Bun 1.3.x 曾出现编译产物解析 sharp 子路径的回归 | 该问题是历史失效样本；本期在固定目标版本直接验证装载，不据此认定当前版本同样失效 |

协议入口、包结构与发行路径的具体设计见 [应用与协议](../spec/application-transports.md) 和 [构建与发行](../spec/build-release.md)。
