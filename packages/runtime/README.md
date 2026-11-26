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

`installation.configurationPath` 返回安装配置文件的实际路径。`instance.root` 返回实例目录，初始化前也可读取，可用作恢复目标。自定义的配置根和数据根由 `Installation` 解析。

用 `defineSettings({schema, fields, validateEffective})` 定义应用自有设置。每个定义拥有自己的顶层字段，组合时使用 `combineSettings`。Runtime 设置始终由 Runtime 定义；应用可将 `runtimeSettings` 加入自己的定义，在应用代码中取得带类型的 Runtime 配置。

SDK 可独立从 `@themelios/runtime/network` 创建 HTTP 客户端，从 `@themelios/runtime/secrets` 读取凭据引用。实例持有操作系统文件锁，进程退出后释放。自定义业务操作从 `@themelios/runtime/operations` 注册。
