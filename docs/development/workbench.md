# 使用文档工作台

Portable 解压后运行 `themelios.cmd`（Windows）或 `./themelios`（Ubuntu）。下面使用 `themelios` 表示启动器。在源码工作区可用 `bun run workbench --` 后跟相同参数。

## 配置模型和导入材料

`themelios instance init` 创建默认实例。要将数据放到指定目录，可在每条命令前加 `--installation ./demo`。用 `--instance 名称` 选择另一个实例。

把 [themelios.toml](../examples/themelios.toml) 的相关内容合并到安装目录的 `config/installation.toml`，替换服务地址和模型 ID。需要认证时设置文件中的凭据引用，例如 `env:THEMELIOS_MODEL_KEY`。不需要认证的本机 OpenAI 兼容服务可省略 `credential`。

```sh
themelios material import --file ./notes.txt --json
themelios config explain /models/tasks/document.summary
themelios task describe document.summary --json
```

把导入返回的 `ref` 放入 `request.json`。以下文件选择整份材料：

```json
{
  "task": "document.summary",
  "variables": { "language": "zh-CN", "maxSections": 3 },
  "materials": [{ "source": { "ref": "替换为导入返回的 art_ 引用" } }]
}
```

文本文档可使用 `{"kind":"text","start":3,"end":10}` 这类 UTF-8 字节范围，PDF 可使用 `{"kind":"pages","start":2,"end":3}` 选择第 2 页，图像可使用 `kind:"image"` 和朝正后的像素矩形。范围放在对应 `source.range` 内。文字 PDF 可以交给文本模型；扫描页需要相应视觉路线。实际 MIME、模型能力和启用的配方决定输入方式。

## 预览、修改和保存

```sh
themelios task preview --input ./request.json --json
themelios prompt read document.summary --part user > edited.liquid
themelios prompt edit document.summary --part user --file edited.liquid
themelios prompt diff document.summary
themelios task run --input ./request.json --save --stream --json
```

编辑 `edited.liquid` 后再运行 `prompt edit`。预览通过 `sources` 显示来源与实际交付范围，通过 `pending` 显示尚未执行的转换或辅助模型请求。模型运行后，`--save` 返回正式成果引用。流式机器输出每行一个事件，最后一行为完整结果。要将结果送给下一步后再保存，可省略 `--save`。

保存后再次运行相同选区及配方时，工作台会重用已交付的派生材料。预览会直接显示已复用的内容。去掉 `--stream --json` 可在终端阅读带来源链接的 Markdown。

用 `themelios result read ARTIFACT_REF --json` 重读结果，用 `themelios material sources ARTIFACT_REF` 追溯到材料，再用 `themelios material export MATERIAL_REF ./original.txt` 导出精确原件。模型服务关闭后这些操作仍然可用。`task run --output PATH` 和原件导出的目标路径必须事先不存在。

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

## 离线维护

结束占用实例的进程，再使用 `storage verify`、`storage backup ./backup`、`storage collect`。用 `--instance restored storage restore ./backup` 恢复到一个尚未创建的实例，再以 `--instance restored storage verify` 校验。`storage collect --retain-since CUT` 显式提高历史查询下界，仍被保留成果引用的材料继续可读。
