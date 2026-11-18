# Themelios

Themelios 是独立开发和发行的通用软件基础平台，为应用提供运行、配置、存储、内容处理、模型调用和协议适配等基础能力。

当前仓库正在准备开发环境，平台尚未实现。设计材料仍在完善，现阶段先维护工具链和工作区。

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

[开发工具](scripts/README.md)介绍工作区和检查命令，[文档目录](docs/README.md)介绍现有资料。
