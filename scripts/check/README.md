# 开发检查

先按[根目录说明](../../README.md)配置开发环境。长度检查支持 TypeScript、JavaScript、Python 和 Rust，扫描目录和阈值在 [config/check.toml](config/check.toml)。

`bun run check:repo` 构建包并运行类型、格式、代码长度、包边界和行为检查。指定一个包名可缩小范围，例如 `bun run check:repo -- storage`。Protobuf 自动生成的绑定保留生成器输出，由类型检查和协议测试验证。

```powershell
pwsh -File ./scripts/check/run.ps1 length
pwsh -File ./scripts/check/run.ps1 length scripts/workspace.py
```

```sh
sh scripts/check/run.sh length
sh scripts/check/run.sh length scripts/workspace.py
```

无文件参数时检查配置中的源码目录，只列出超过阈值或无法检查的文件；指定文件时逐项显示结果。也可以用 `--stdin` 接收路径列表，默认每行一个；`--stdin --zero` 接收 NUL 分隔的路径。

有效行数按只读格式化后的代码统计，不计空行和注释；Python 的模块、类、函数文档字符串也不计入。TypeScript/JavaScript 使用 Bun 格式化和 ast-grep 识别注释，Python 使用固定版本的 Ruff，Rust 使用 rustfmt。字符串中的内容计入代码。

TypeScript、JavaScript 和 Python 超过 800 行警告、超过 900 行拒绝；Rust 超过 500 行警告、超过 600 行拒绝。警告的退出码为 0，拒绝为 1，用法或配置错误为 2。

其他配置文件可以用 `bun fmt --check package.json tsconfig.base.json .vscode/settings.json .vscode/extensions.json` 检查格式。Git pre-commit 钩子使用 Fallow 检查暂存内容；仓库尚无提交时，首次提交没有比较基准，Fallow 会跳过检查。

Agent 对受影响的 TypeScript 或 JavaScript 文件运行 `bun run lint:agent <文件>`，取得精简的 oxlint 诊断。`bun run fallow:agent` 输出适合工具处理的精简 JSON；发现项可能随退出码 0 返回，应读取输出中的发现项和 `gate_outcomes`。Fallow 默认启用 TypeScript 语义分析，缓存位于 `temp/cache/fallow/`。
