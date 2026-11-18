# 构建与发行

Themelios 同时发行面向应用开发者的独立 ESM 包与开箱即用的平台 Portable 运行包。

## 工作区构建与验证

- `bun run build:packages` 按依赖拓扑顺序执行 `tsc -b` 声明生成与 `bun build` ESM 产物打包，并将资源文件同步到各包结构可寻址位置。
- `bun run check:repo` 运行全仓库或指定工作区的综合门禁：构建、类型检查（`bun check`）、格式化校验（`bun fmt --check`）、`oxlint`、源文件行数上限检查（`scripts/check/manage.py length`）、跨包导出边界分析（`checkBoundaries`）与全量行为测试（`bun test --agent`）。

## 外部 ESM 发行包（`.tgz`）

- `bun run pack:packages` 为全部公开工作区包生成可直接被外部消费项目安装的 `.tgz` 归档于 `artifacts/packages/`。
- 消费者在仓库之外通过标准依赖管理安装所需归档（如独立嵌入仅需 `@themelios/models` 时无需安装 `@themelios/application` / `@themelios/storage` / `@themelios/content`；完整应用按需消费 `@themelios/core`、`@themelios/runtime`、`@themelios/storage`、`@themelios/content`、`@themelios/application`、`@themelios/transports`），并通过局部 `overrides` 确保各传递工作区包指向同一发行批次。

## 可搬迁 Portable 发行包

- `bun run build:portable`（目标 `windows-x64-msvc` 与 `linux-x64-gnu`）在隔离 staging 目录安装纯生产依赖、打包 Workbench 闭包，并复制锁定版本的 Bun 可执行文件、启动器脚本（`themelios.cmd` / `themelios` + `app/launch.mjs`）、`app/release.json`（`format: "themelios.portable"`）、`config/installation.toml` 与空白 `instances/` 目录。
- `launch.mjs` 校验目标平台、Bun 版本与清单格式后从相对路径引导工作台；用户将整个解压目录整包搬迁至新路径后，原有实例与保存的成果继续直接读取与运行。
