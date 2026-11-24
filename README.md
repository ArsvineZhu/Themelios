# Themelios

Themelios 是独立开发和发行的通用软件基础平台，为应用提供运行、配置、存储、内容处理、模型调用和协议适配等基础能力。

文档工作台可以接纳文本、图片和 PDF，预览和编辑提示词，调用已配置的模型，再保存结果与来源。嵌入应用可按需使用单个包，也可打开同一套实例和会话。

## 使用工作台

已有 Portable 时，解压后即可运行。Windows 使用 `./themelios.cmd`，Ubuntu 使用 `./themelios`。工作台默认在解压目录保存实例，输入和输出的相对路径按当前终端目录解析。

从源码开始时，先准备构建环境。需要 Git、Node.js 22 或更新版本及 npm、Python 3.11 或更新版本。

```powershell
. ./dev.ps1 bootstrap
```

```bash
source ./dev.sh bootstrap
```

在仓库根目录构建并打开工作台：

```bash
bun run build:packages -- workbench
bun run workbench -- --installation ./temp/work/notes instance init
bun run workbench -- --installation ./temp/work/notes material import --text "Tea at 3." --name notes.txt --json
```

继续[从一份笔记生成并保存摘要](docs/development/workbench.md)，或查阅[工作台命令和协议实例](docs/development/operations.md)。要制作可直接解压运行的 Portable，见[构建与发行](docs/development/distribution.md)。

## 嵌入应用

在已准备好的工作区运行 `bun run pack:packages`，生成 `artifacts/packages/` 下的 SDK tarball。[SDK 实例](docs/development/sdk.md)从本地安装开始，展示独立模型调用、材料和成果、事务与备份、运行时和扩展。两个可单独运行的应用见[模型与模板](examples/embedded/README.md)和[库存登记](examples/inventory/README.md)。

## 开发环境

需要 Agent 检索和 Harness 集成时，另外安装 uv，在仓库根目录运行完整初始化：

```powershell
. ./dev.ps1 init
```

Linux 或 macOS：

```sh
source ./dev.sh init
```

之后每个新终端先运行 `. ./dev.ps1` 或 `source ./dev.sh`，再使用 `bun`。完整初始化会为已检测到的 Agent Harness 配置 CodeGraph、Zvec-grep、Fallow 和 ast-grep MCP。详见[开发工具](scripts/README.md)。

开发环境配置后运行：

```sh
bun run check:repo -- workbench
bun run operations:describe -- tasks.preview
```

从[文档目录](docs/README.md)查看任务、接口和设计。平台当前状态见 [CURRENT.md](CURRENT.md)。
