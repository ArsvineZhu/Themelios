# Agent Harness 适配器工具

为多种 Agent Harness（Codex、Antigravity 等）提供统一的命令门禁与 MCP 配置同步能力，共用同一套工作区工具定义，各 Harness 仅保留薄适配层。

## 用法

在仓库根目录执行：

```powershell
pwsh -File ./scripts/harness/run.ps1 gate --harness antigravity
pwsh -File ./scripts/harness/run.ps1 mcp
pwsh -File ./scripts/harness/run.ps1 status
```

```sh
sh scripts/harness/run.sh gate --harness codex
sh scripts/harness/run.sh mcp
sh scripts/harness/run.sh status
```

无平台区分的入口 `node scripts/harness/run.mjs` 供仅接受单条跨平台命令的 Harness 钩子配置调用，行为与 `run.ps1` / `run.sh` 一致。

## 子命令与选项

- `gate [-a|--harness canonical|codex|antigravity]`：从 `stdin` 读取钩子载荷，仅在命令可能执行 `git commit` 或 `git push` 时调用 `fallow-gate.sh`，其余命令直接放行。
  - `canonical`：读写中性 JSON（`{"command", "cwd"}` -> `{"decision", "reason"}`），放行返回 `0`，拒绝返回 `2`。
  - `codex`：读取 `tool_input.command` / `cwd`；放行返回 `0`，拒绝输出原因到 `stderr` 并返回 `2`。
  - `antigravity`：读取 `toolCall.args.CommandLine` / `cwd`；始终返回退出码 `0`，并在 `stdout` 输出 `{"decision": "allow"|"deny", ...}` JSON。
- `mcp [-a|--harness all|codex|antigravity] [-f|--force]`：将标准 MCP 定义（全局 `codegraph`、`zvec-grep` 与工作区 `fallow`、`ast-grep`）同步到目标 Harness。默认保留用户全局配置中已存在且可执行文件有效的服务器条目；传入 `-f` 强制覆盖全局条目。
- `status [-a|--harness all|codex|antigravity]`：报告各 Harness 的检测状态、门禁钩子接入情况以及已登记的 MCP 服务器。

## 结构与配置

- `config/harness.toml`：维护受支持的 Harness 列表、`temp/` 缓存与报告路径及 MCP 超时等配置。
- `adapters.py`：各 Harness 的载荷解析、响应格式及 MCP 配置文件读写适配器。
- `manage.py`：核心命令路由、门禁快速预过滤与标准 MCP 定义构建。
- `fallow-gate.sh`：Fallow 上游提交与推送审计门禁脚本。
