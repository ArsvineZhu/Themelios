# 运行与配置

## 安装根与实例布局

`Installation.at(root, module)` 将应用模块绑定到安装根目录 `root`（例如 Portable 目录或外部指定目录）：

```text
<installationRoot>/
  config/
    installation.toml         # 安装级默认配置
  instances/
    <name>/
      instance.json           # 实例 ID、applicationId、formatId
      config/
        instance.toml         # 实例级配置
        managed.toml          # configuration.set / unset 管理的配置
        prompts/<taskId>/     # 实例级提示词模板覆盖
      state/
        main.sqlite           # 应用与存储主库
      objects/                # CAS 内容对象目录
      logs/                   # 运行日志与诊断文件
      run/
        instance.lock         # 排他锁 SQLite 文件
        owner.json            # 当前锁持有者 PID、启动时间与监听端点
```

应用启动或搬迁后只根据相对位置打开上述目录；路径变化时直接沿用原实例数据与引用。

## 排他实例锁与只读打开

`packages/runtime/src/lock.ts` 直接使用 `bun:sqlite` 在 `run/instance.lock` 上开启 `PRAGMA locking_mode = EXCLUSIVE` 与 `BEGIN EXCLUSIVE` 持有系统文件句柄：

- 任意进程异常退出后由操作系统内核自动回收文件句柄，下次打开无需人工清理遗留锁文件。
- 锁冲突时读取 `run/owner.json` 报告 `ownerPid`、`startedAt` 与 `endpoints`，并抛出可重试的 `runtime.instance_busy`。
- `session.setEndpoints(endpoints)` 替换会话的端点记录，也可传入函数，以当前记录为基础更新。监听器停止时撤回自己公布的地址。`withOfflineInstance(instance, work)` 使用同一实例锁协调离线维护。
- 打开会话时明确区分读写模式（`read-write` / `read-only`）；只读会话拒绝写操作并抛出 `runtime.read_only`。

## 分层配置与资源重载

配置解析遵循严格优先级合并：

1. 模块 `SettingsDefinition` 的 Schema 默认值（`defaults`）
2. `<installation>/config/installation.toml`（`installation`）
3. `<instance>/config/instance.toml`（`instance`）
4. `<instance>/config/managed.toml`（由 `configuration.set` / `unset` 管理）

每个设置路径声明生效时机（`next-call`、`reload`、`restart`）、作用域与说明键。`configuration.explain(path)` 给出期望值、当前生效值、来源与是否需要重启。等待重启的设置保留原来的有效值，同一次编辑中的其他设置按各自时机生效。`set` 固定托管层值，即使与继承值相同；`unset` 移除该层贡献。

会话通过 `env.bindResource(keyFn, buildFn)` 托管需要按配置重建的应用资源。首次注册与配置写入共用队列，工厂从传入的配置快照构建资源，构建成功后发布。配置重载后新调用读取新代资源，在途调用退出后释放旧代资源。

材料 I/O 的并发队列归工作台会话管理。操作启动时捕获本次使用的内容大小限制，模型配置重载后继续共用该队列。

## 凭据、网络、日志与追踪

- **凭据（`Secrets`）**：生产配置使用 `env:VAR_NAME` 或 `file:相对/绝对路径` 引用，禁止明文写入配置文件与错误响应。
- **网络（`Network`）**：受控 `fetch` 支持代理、授权、额外 CA、超时与响应流取消。`network.noProxy` 按原始请求 URL 选择是否绕过已配置的代理，例如 `["localhost", "127.0.0.1", ".example.local"]`，重定向沿用该次选择。
- **诊断（`Diagnostics` + `traceId`）**：Pino 输出结构化 JSONL，执行通过 `AsyncLocalStorage` 绑定 `traceId` 并以 `AppError.traceId` 将错误关联到调用。调试日志可记录已知长度的发送正文和实际读取的响应字节，任务批次记录执行结果摘要。`logging.captureModelContent` 可选择记录脱敏模型正文。
