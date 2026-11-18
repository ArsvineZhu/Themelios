# 构建和验证发行物

在根目录初始化开发环境后运行：

```sh
bun run check:repo
bun run build:packages
bun run pack:packages
```

`check:repo` 运行包构建、类型、格式、代码长度、包边界和行为检查。加包名可缩小范围。`pack:packages` 将各正式 ESM 包写入 `artifacts/packages/`。外部应用在自己的目录和锁文件中使用同批包的公开出口。两个外部消费示例各有实际安装命令。

## Portable

Windows x64 与 Ubuntu x64 各在目标平台构建：

```sh
bun run build:portable -- --target windows-x64-msvc
bun run build:portable -- --target linux-x64-gnu
```

产物位于 `artifacts/portable/`，Windows 为 ZIP，Ubuntu 为 tar.gz。发行目录带有 Bun、应用依赖、Sharp、PDF 资源、清单（`format: "themelios.portable"`）和许可证。解压运行相应启动器即可。搬迁时一并移动 `config/` 与 `instances/`，应用数据和引用保留原值。

## 运行验证

```sh
bun run test:distribution -- --portable /ABS/UNPACKED/PORTABLE
bun run test:live
```

`test:distribution` 在仓库之外安装 tarball，从 CLI 和 HTTP/SSE 导入库存，使用 MCP 查询同一实例的历史，再下载原件。提供 `--portable` 时也运行实例搬迁。添加 `--live` 可用独立模型示例分别运行内联和文件 Prompt。

`test:live` 使用明确提供的 `THEMELIOS_MODEL_URL`、`THEMELIOS_MODEL_ID` 和按需提供的 `THEMELIOS_MODEL_KEY`。它运行工作台的材料、提示词、模型、保存、断开模型后回读和备份恢复。可给脚本传入 Portable 目录，使实际调用走发行包内的 Bun 和应用。

添加 `--media` 验证 PDF 选页和空页错误。再提供 `THEMELIOS_VISION_URL`、`THEMELIOS_VISION_ID` 和按需提供的 `THEMELIOS_VISION_KEY`，运行实际的图像裁切、描述及以描述为输入的摘要。
