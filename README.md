# Themelios

Themelios 是独立开发和发行的通用软件基础平台，为应用提供运行、配置、存储、内容处理、模型调用和协议适配等基础能力。

文档工作台可以接纳文本、图片和 PDF，预览和编辑提示词，调用已配置的模型，再保存结果与来源。嵌入应用可按需使用单个包，也可打开同一套实例和会话。

## 使用工作台

解压当前平台的 Portable。Windows 使用 `themelios.cmd`，Ubuntu 使用 `./themelios`。工作台默认在解压目录保存实例数据，命令中的相对输入和输出路径按调用目录解析。

```sh
themelios instance init
themelios material import --file notes.txt --json
themelios task describe document.summary --json
```

配置实际模型后，可预览、执行、保存和追溯结果。完整命令和配置在[工作台指南](docs/development/workbench.md)，配置样例在 [themelios.toml](docs/examples/themelios.toml)。当前能力与生效决策见 [CURRENT.md](CURRENT.md)，架构设计见[设计文档](docs/design/README.md)。

## 嵌入应用

正式包位于 `artifacts/packages/`。使用同一批 tarball 安装对应依赖。可以从[独立模型脚本](examples/embedded/README.md)或[库存登记应用](examples/inventory/README.md)开始。包入口、依赖和扩展位置见[平台架构](docs/ARCHITECTURE.md)。

## 开发环境

需要 Git、Node.js 22 以上与 npm、Python 3.11 以上和 uv。项目使用 Bun 1.4.4、TypeScript 7.0.2；首次初始化会把指定版本的 Bun、工具和下载缓存放在 `temp/`，安装锁定的开发依赖，并准备工作区检索工具。ast-grep MCP 需要 Python 3.13 以上，uv 可以安装所需版本。

在仓库根目录运行：

```powershell
. ./dev.ps1 init
```

Linux 或 macOS：

```sh
source ./dev.sh init
```

之后每个新终端先运行 `. ./dev.ps1` 或 `source ./dev.sh`，再使用 `bun`。要重新安装工作区依赖，运行 `bun install --frozen-lockfile`。初始化会检测已安装的 Agent Harness（如 Codex、Antigravity）并配置对应的 CodeGraph、Zvec-grep、Fallow 和 ast-grep MCP 连接；已有的全局或其它连接保持原样。

开发环境配置后运行：

```sh
bun run build:packages
bun run workbench -- --installation ./temp/work/demo instance init
bun run check:repo
```

可用 `bun run check:repo -- application` 缩小检查范围。打包、安装验证和目标平台构建见[发行说明](docs/development/distribution.md)。[文档目录](docs/README.md)链接到当前接口和任务参考。
