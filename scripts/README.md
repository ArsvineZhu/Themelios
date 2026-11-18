# 开发工具

根目录的 `dev.ps1` 和 `dev.sh` 配置当前终端的工作区环境。第一次运行 `init` 会安装项目指定的 Bun、安装锁定的开发依赖，准备 CodeGraph、Zvec-grep 和 ast-grep MCP，并同步到已检测到的 Agent Harness（Codex、Antigravity 等）。Fallow 和 ast-grep MCP 使用工作区自己的配置；工具、缓存与临时文件放在 `temp/`。

```powershell
. ./dev.ps1 init    # 首次准备
. ./dev.ps1         # 新终端配置环境
. ./dev.ps1 status  # 查看运行时与检索索引
```

```sh
source ./dev.sh init
source ./dev.sh
source ./dev.sh status
```

`init` 需要 Node.js、npm、Python 和 uv；`env` 只配置当前终端。初始化还会安装 Fallow 的 Git pre-commit 钩子，检查暂存内容；已有其他钩子时保留原样并提示合并。仓库尚无首个提交时，Fallow 没有比较基准，首个提交会跳过这项检查。

Fallow 的统一提交与推送门禁由 `scripts/harness/` 提供；各 Harness 的适配器入口分别位于 `.codex/hooks.json`（Codex，需在 `/hooks` 或设置中检查信任后生效）和 `.agents/hooks.json`（Antigravity）。

在 Agent 会话（Codex、Antigravity、Claude Code）中配置环境时，如果 `AGENT` 尚未设置，脚本会设为 `1`，让 Bun 测试保留失败详情与汇总。可显式设为 `0` 恢复完整测试输出。

- [check/](check/README.md)：当前可用的开发检查。
- [harness/](harness/README.md)：统一的 Agent Harness 门禁与 MCP 适配器。
- [temp/](temp/README.md)：临时目录、素材和工具的管理。

## 结构规范

一个工具一个目录。入口和 Python 文件的名字由这个工具决定：

```text
scripts/<name>/
  README.md
  config/
    <配置文件>.toml
  <入口>.ps1
  <入口>.sh
  <程序>.py
  ...
```

`<程序>.py` 实现命令。配置、模板，以及按职责拆出的 Python 模块，放在同一目录。它以脚本方式运行，同目录模块按顶层名字导入。这个目录不是包，不加 `__init__.py`。仓库根目录取 `Path(__file__).resolve().parents[2]`。

`<入口>.ps1` 和 `<入口>.sh` 定位解释器，以 `-B` 运行同目录的 `<程序>.py`，原样转发参数，并返回 Python 的退出码。参数、配置和动作都在 Python 里。两个入口接受同一组参数；短选项在 Python 的参数解析中登记。

阈值、外部命令和扫描路径只留在该目录的配置文件中，由 Python 读取。`README.md` 写这个工具在仓库根目录的调用方式、参数和退出码。

```powershell
pwsh -File ./scripts/<name>/<入口>.ps1
```

```sh
sh scripts/<name>/<入口>.sh
```

Windows 入口需要 PowerShell 7 和 PATH 中的 `python`。Linux 和 macOS 入口需要 PATH 中的 `python3`。入口不改当前 shell 的环境，也不安装依赖。工具要使用项目虚拟环境时，调用者先做工作区设定，再由 `<程序>.py` 调用该环境中的解释器。
