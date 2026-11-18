# @themelios/transports

将已打开的 Themelios 应用接入 HTTP、MCP 和 gRPC。各入口共享应用操作的输入、权限和结果合同。

- `createHttpHandler(api, options)` 提供标准 Fetch handler，支持 JSON、原始材料字节和 SSE。
- `createMcpEndpoint(api, options)` 提供 MCP Streamable HTTP，`serveMcpStdio(api, options)` 服务本机 stdio 客户端。
- `startGrpcServer(api, options)` 启动 HTTP/2 gRPC 监听。客户端可使用导出的 `ApplicationService`，也可从包中的 `resources/proto/themelios/v1/application.proto` 生成所用语言的客户端。

远程入口通过 `options.policy` 读取请求的大小上限、令牌和来源设置。静态令牌由 `options.secrets` 解析，也可由宿主提供 `options.authenticate`。关闭顺序依次为停止监听、等待各协议的 `close()`、关闭应用会话。
