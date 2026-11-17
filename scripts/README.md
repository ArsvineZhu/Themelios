# 开发工具

根目录的 `dev.ps1` 和 `dev.sh` 配置当前终端的工作区环境。第一次运行 `init` 会安装项目指定的 Bun、安装锁定的开发依赖，准备 CodeGraph、Zvec-grep 和 ast-grep MCP，并配置 Codex 连接。Fallow 和 ast-grep MCP 使用工作区自己的配置；工具、缓存与临时文件放在 `temp/`。

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

`init` 需要 Node.js、npm、Python、uv 和 Codex；`env` 只配置当前终端。初始化还会安装 Fallow 的 Git pre-commit 钩子，检查暂存内容；已有其他钩子时保留原样并提示合并。仓库尚无首个提交时，Fallow 没有比较基准，首个提交会跳过这项检查。

Fallow 的 Codex 提交与推送门禁位于 `.codex/hooks.json`。在 Codex 的 `/hooks` 或设置中的 Hooks 页面检查并信任后，它才会执行。

在 Codex 会话中配置环境时，如果 `AGENT` 尚未设置，脚本会设为 `1`，让 Bun 测试保留失败详情与汇总。可显式设为 `0` 恢复完整测试输出。

- [check/](check/README.md)：当前可用的开发检查。
- [temp/](temp/README.md)：临时目录、素材和工具的管理。
