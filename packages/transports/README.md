# @themelios/transports

将 Themelios 应用接入 CLI、HTTP/SSE、MCP 或 gRPC。各入口共享 `@themelios/runtime/operations` 定义的操作、输入、权限和结果合同。

- `createHttpHandler(api, options)` 提供标准 Fetch handler，支持 JSON、原始材料字节和 SSE。
- `createMcpEndpoint(api, options)` 提供 MCP Streamable HTTP，`serveMcpStdio(api, options)` 服务本机 stdio 客户端。
- `runApplicationCli(installation, argv, {name, operations, principal})` 生成命令并打开相应实例。需要支持 `--installation` 时传入 `useInstallation`，由它按指定路径创建安装实例。
- `startGrpcServer(api, {address, tls}, options)` 从 `@themelios/transports/grpc` 启动 gRPC 监听，提供 `Operations.Invoke`、`Stream` 和 `Upload`。包内 `proto/operations.proto` 可供其他语言生成客户端。
- `serveApplication(session, {http, grpc, signal})` 管理监听和关闭；`http.options.enableMcp` 将 MCP 与 REST 放在同一监听器。

远程入口通过 `options.policy` 读取请求大小、令牌和来源设置。静态令牌由 `options.secrets` 解析，也可由宿主提供 `options.authenticate`。下面是嵌入已有监听器的方式：

```ts
import { createHttpHandler } from "@themelios/transports";

const handler = createHttpHandler(session.api, {
  operations, policy, secrets, enableMcp: true,
});
const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: handler.fetch});
console.log(server.url.href);
// 退出时依次关闭监听器、handler 和实例会话。
```
