# @themelios/runtime

Runtime 提供安装与实例目录、跨进程实例锁、分层配置、调用期限和会话资源管理。应用实现 `ApplicationModule`，通过 `Installation.at(root, application)` 绑定自己的安装目录。

```ts
import { Installation, runtimeSettings } from "@themelios/runtime";

const installation = Installation.at("./example", {
  id: "example.notes",
  formatId: "example.notes",
  settings: runtimeSettings,
  async provision() {},
  async open(env) {
    return { locale: () => env.configuration.snapshot().locale };
  },
});

const instance = installation.instance("default");
await instance.init(); // 首次建立实例
const session = await instance.open();
try {
  console.log(session.api.locale());
} finally {
  await session.close();
}
```

将人工设置写入安装目录的 `config/installation.toml` 或实例目录的 `config/instance.toml`。SDK 使用 `configuration.set` 写入实例的 `managed.toml`，使用 `configuration.explain` 查看设置来源和生效状态。

SDK 可独立从 `@themelios/runtime/network` 创建 HTTP 客户端，从 `@themelios/runtime/secrets` 读取凭据引用。实例使用 Bun SQLite 句柄持有排他锁，进程退出后释放。自定义业务操作从 `@themelios/runtime/operations` 注册。
