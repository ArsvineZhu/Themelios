# 使用文档工作台

已有 Portable 时，解压后运行 `./themelios.cmd`（Windows）或 `./themelios`（Ubuntu）。从源码开始时，先在[仓库首页](../../README.md#使用工作台)安装构建依赖并构建工作台。下面用 `themelios` 表示启动器。使用源码时，将其换成 `bun run workbench --`，并在命令中加 `--installation ./temp/work/notes` 选定安装根。

## 配置模型和导入材料

`themelios instance init` 创建默认实例和安装配置目录。要把数据放到指定目录，可在每条命令前加 `--installation ./demo`。用 `--instance 名称` 选择另一个实例。`themelios instance info --json` 可以查看实际实例路径。

把 [themelios.toml](../examples/themelios.toml) 中的模型设置写入安装目录的 `config/installation.toml`，设置兼容网关的 API 根地址和支持结构化输出的模型 ID。需要认证时，按文件中的 `credential` 引用设置进程环境变量 `THEMELIOS_MODEL_KEY`。免密的本机 OpenAI 兼容服务可省略 `credential`。安装目录内所有实例继承这份配置，也可以在某一实例的 `config/instance.toml` 单独选择模型。

同一实例可按任务调整默认输出语言和调用预算。例如，把下面两段合并到示例中，调用时仍可以传入 `variables.language` 选择另一种语言：

```toml
[models.tasks."document.summary"]
model = "summary"
timeoutMs = 90000
maxAttempts = 2

[models.tasks."document.summary".variables]
language = "ja"
```

默认摘要最多生成六节。要处理更长材料，可提高任务输入 `variables.maxSections`，再按模型的实际上下文和输出能力设置 `parameters.maxOutputTokens` 与 `timeoutMs`。摘要字段不设统一的额外篇幅上限。

需要跨网关备用模型时，在同一任务表中设置 `fallback = ["backup", "local"]`，并预先配置这两个绑定。列表顺序决定尝试顺序。应仅列入可以接收该任务材料的服务。单次输入显式指定 `model` 时只使用所指定的绑定。

用编辑器创建 `notes.md`，第一行写 `# Tea`，正文写 `Tea at 3.`。先导入文件，再检查任务模型和输入要求：

```sh
themelios material import --file ./notes.md --json
themelios config explain /models/tasks/document.summary
themelios task describe document.summary --json
```

把返回的 `ref` 填入 `request.json`。以下请求选择首行的 `Tea`：

```json
{
  "task": "document.summary",
  "variables": { "language": "zh-CN", "maxSections": 3 },
  "materials": [{
    "source": {
      "ref": "替换为导入返回的 art_ 引用",
      "range": { "kind": "text", "start": 2, "end": 5 }
    }
  }]
}
```

文本范围按 UTF-8 字节计，包含起点并排除终点。要发送整篇笔记，删去 `range`。导入 PDF 后，使用 `{"kind":"pages","start":2,"end":3}` 选择第 2 页；带文本层的页可由 `pdf.text` 交给文本模型，扫描页需要视觉路线。导入图像后，使用 `{"kind":"image","x":0,"y":0,"width":32,"height":32}` 选择朝正后的左上角，宽高须在图像范围内。图像描述和二次摘要的路由参见配置样例。

本机装有 FFmpeg 和 ffprobe 时，时间选区如 `{"kind":"time","startMs":500,"endMs":1500}` 可以用于压缩音频和视频。工作台从 `PATH` 找到工具。也可在 `[preparation.media]` 中用 `ffmpeg`、`ffprobe` 指定可执行文件。具体配方和选择方式见 [SDK 媒体实例](sdk.md#媒体材料来源和成果)。

## 预览、修改和保存

```sh
themelios task preview --input ./request.json --json
themelios prompt read document.summary --part user > edited.liquid
themelios prompt edit document.summary --part user --file edited.liquid
themelios prompt diff document.summary
themelios task run --input ./request.json --save --stream --json
```

编辑 `edited.liquid` 后再运行 `prompt edit`。预览中的 `sources` 显示原件范围、请求选区和已可用的交付内容，`pending` 显示待运行的转换或辅助模型。模型运行后，`--save` 返回正式成果引用。`--stream --json` 逐行输出事件，成功时末尾是 `result`。要将完成值交给下一步后再保存，可先省略 `--save`。

保存后再次运行相同选区及配方时，工作台会重用已交付的派生材料。预览会直接显示已复用的内容。去掉 `--stream --json` 可在终端阅读带来源链接的 Markdown。

用 `themelios result read ARTIFACT_REF --json` 重读成果，用 `themelios material sources ARTIFACT_REF` 追溯到材料，再用 `themelios material export MATERIAL_REF ./original.md` 导出精确原件。模型服务关闭后这些操作仍然可用。`task run --output PATH` 和原件导出的目标路径必须事先不存在。

要用已保存的摘要做下一次任务的上下文，在请求 `materials` 中加入 `{"source":{"resultOutput":{"result":"已保存的成果引用","output":"$value"}},"role":"context"}`。对于命名附件，将 `$value` 改成文件名。直接读取先前成果可节省重复的模型请求。

## 连接正在运行的工作台

`themelios serve` 启动已配置的监听器，并持有该实例。下面的配置启用本机 HTTP 和 MCP。把令牌放入工作台进程的环境变量，HTTP 客户端使用 `Authorization: Bearer …`。权限按集合检查，需要读取、执行和管理的用户显式获得三项。

```toml
[transports.http.listen]
port = 9010

[transports.mcp]
mode = "http"

[transports.authTokens.operator]
secret = "env:THEMELIOS_OPERATOR_TOKEN"
permissions = ["read", "write", "admin"]
```

HTTP 可调用 `GET /instance`、`POST /materials` 和 `POST /tasks/document.summary/stream`。MCP HTTP 地址为 `/mcp`（自动为 Agent 压缩为 24 字母 `art_…` 短引用），stdio 客户端可显式启动 `themelios mcp`。停止监听器后，CLI 可以直接打开同一实例。

若要让系统选择空闲端口，设置 `port = 0`，从启动输出取得实际地址。可在 `[transports.http]` 设置 `idleTimeoutSeconds`（默认 `180`）。工作台可以通过以下设置仅对外开放任务目录和材料读取，并将本机 MCP 限为只读。改变监听或发布范围后重启服务。

```toml
[transports]
allowOperations = ["tasks.list", "tasks.describe", "materials.inspect", "materials.read"]

[transports.mcp]
mode = "http"
localPermissions = ["read"]
```

把示例字段合并到已有 TOML 表。`allowOperations` 与 Bearer 权限同时生效。本机 CLI 仍可打开工作台自身的管理命令。

各项命令及其请求示例见[工作台命令与协议](operations.md)。

## 离线维护

结束占用实例的进程，再使用 `storage verify`、`storage backup ./backup`、`storage collect`。用 `--instance restored storage restore ./backup` 恢复到一个尚未创建的实例，再以 `--instance restored storage verify` 校验。`storage collect --retain-since CUT` 显式提高历史查询下界，仍被保留成果引用的材料继续可读。

## 在启动时加载扩展

将 `THEMELIOS_EXTENSIONS` 设为本机可信 JavaScript 或 TypeScript 模块的路径。模块默认导出 `tasks`、`adapters`、`locales` 中所需的字段，类型与 `createApplicationModule` 的对应字段一致。多个路径用当前系统的 `PATH` 分隔符连接，Windows 用 `;`，Linux 用 `:`。相对路径以启动工作台的当前目录为基准。修改后重启相应 CLI 或监听进程。

例如在源码工作区运行 [关键词任务扩展](../../examples/sdk/workbench-extension.ts)。在 PowerShell 中设 `$env:THEMELIOS_EXTENSIONS = './examples/sdk/workbench-extension.ts'`，在 Bash 中设 `export THEMELIOS_EXTENSIONS=./examples/sdk/workbench-extension.ts`。用已有的工作台实例运行 `themelios task describe document.keywords --json` 查看合同。在模型配置中加入 `[models.tasks."document.keywords"]` 和 `model = "summary"`，把此前笔记请求里的 `task` 改为 `document.keywords`，将 `variables` 改为 `{}` 后运行，即得到 `keywords` 数组。
