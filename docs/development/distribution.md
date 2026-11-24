# 构建和验证发行物

在根目录执行 `. ./dev.ps1 bootstrap`（Windows）或 `source ./dev.sh bootstrap`（Ubuntu），然后运行：

```sh
bun run pack:packages
```

`pack:packages` 构建公开出口并将 ESM 包写入 `artifacts/packages/`。可传 `--output ./artifacts/my-build/packages` 保存独立的一批包。在自己的项目中声明所需的 `@themelios/*` 依赖，然后运行 `bun scripts/install-packages.ts ./artifacts/packages /path/to/consumer`。安装工具把直接及传递的 Themelios 依赖绑定到同一批本地包。

## Portable

Windows x64 与 Ubuntu x64 各在目标平台构建：

```sh
bun run build:portable -- --target windows-x64-msvc
bun run build:portable -- --target linux-x64-gnu
```

产物位于 `artifacts/portable/`，Windows 为 ZIP，Ubuntu 为 tar.gz。重复构建可传 `--output` 指定新的目标目录。发行目录带有 Bun、应用依赖、图像和 PDF 资源、gRPC 定义及许可证。解压运行相应启动器即可。搬迁时一并移动 `config/` 与 `instances/`，应用数据和引用保留原值。Windows 实例与文件导出支持 NTFS 和 exFAT。Linux 实例使用支持硬链接的本地文件系统，例如 ext4。需要 FFmpeg 配方时，在运行机器上安装 FFmpeg 和 ffprobe。

在 Windows 可以把 `--output` 直接设在 exFAT 卷。构建会拒绝覆盖既有目录或归档。归档发布成功后如果无法发布目录，工具会撤回刚生成的归档，便于纠正问题后用同一目标重试。

## 运行验证

```sh
bun run test:distribution -- --portable /ABS/UNPACKED/PORTABLE
bun run test:live
```

`test:distribution` 在仓库之外安装 tarball，从 CLI 和 HTTP/SSE 导入库存，使用 MCP 查询同一实例的历史，再下载原件。使用 `--packages PATH` 选择指定的包目录，提供 `--portable PATH` 时也运行实例搬迁。添加 `--live` 通过已配置的模型执行两种 Prompt。

`test:live` 使用明确提供的 `THEMELIOS_MODEL_URL`、`THEMELIOS_MODEL_ID` 和按需提供的 `THEMELIOS_MODEL_KEY`。它运行工作台的材料、提示词、模型、保存、断开模型后回读和备份恢复。可给脚本传入 Portable 目录，使实际调用走发行包内的 Bun 和应用。

添加 `--media` 验证 PDF 选页和空页错误。再提供 `THEMELIOS_VISION_URL`、`THEMELIOS_VISION_ID` 和按需提供的 `THEMELIOS_VISION_KEY`，运行实际的图像裁切、描述及以描述为输入的摘要。
