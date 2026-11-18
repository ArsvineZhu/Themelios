# 材料摘要任务的维护参考

`document.summary` 联合阅读本次主要材料，用背景材料辅助理解，输出带材料级来源的分节摘要。正式定义见 [document-summary.ts](tasks/document-summary.ts)，模板见 [system.md.liquid](resources/document.summary/system.md.liquid) 和 [user.md.liquid](resources/document.summary/user.md.liquid)。本例是任务文档生成器的内容样式；实施后从实际定义和本地化资源生成同等信息。

## 任务接收明确变量及一组共同理解的材料

| 变量 | 类型与范围 | 默认及省略意义 |
|---|---|---|
| `language` | `zh-CN` 或 `en` | `zh-CN` |
| `maxSections` | 整数，1 至 12 | 6；约束最终分节上限 |
| `focus` | 至多 2000 字符的字符串或 null | null，按材料本身组织 |

原始变量 Schema 在 [summary-input.schema.json](summary-input.schema.json)。Schema 的默认值由 Zod 解析填入，JSON Schema 文档中的 default 只描述此行为。SDK 的 `TaskDefinition` 同时保留 `z.input` 和 `z.output` 类型，调用者可以省略具有默认值的字段。

本例字符串长度上限按 JavaScript 字符串长度计算，正式材料选区使用 UTF-8 字节。

材料数量为 1 至 64，每项有 source 与可选 role，role 缺省 primary。context 是辅助背景。文本、Markdown、JSON、PDF 需要 text；图像需要 visual。来源为已保存选区、当前内存 bytes 或上一完成结果的值/文件。PDF 由已安装扩展准备；图像需所选模型原生支持，或任务配置明确启用描述准备。

所选最终模型必须支持生成和结构化对象。流接口额外要求 streaming。实际模型名称和连接来自 `models.tasks['document.summary']`，本例不写死供应商模型名称。

完整配置样例见 [themelios.toml](themelios.toml)。填入真实模型 ID 并提供其引用的环境凭据后，将内容合并到安装或实例的人工配置文件。可选的图像描述路线在样例中整段注释，按实际需要明确启用。

## sources 由程序注入模板

| 字段 | 含义 |
|---|---|
| `sources` | 与 InputUse 同序的数组 |
| `key` | 本次程序生成的 `S1`、`S2` 等来源键 |
| `mediaType` | 原始材料媒体类型 |
| `name` | 可选可读名称 |
| `role` | primary 或 context |
| `originalExtent` | 原件已知范围的可读说明 |
| `deliveredExtent` | 实际交付的页、区域、文字或时间范围说明列表 |

实际文字和媒体 bytes 都由程序在 user 模板后按来源顺序追加，每个来源带 `[S1]` 一类短标记。模板只引用目录说明，因此修改模板不会重复发送或遗漏材料正文。模型生成的 source key 由程序与本次目录核对。正式材料引用和精确坐标来自 InputUse。TaskExample 中可附 `text` 帮助展示示例正文，它不进入模板变量。

## 输出结构固定，正文保持自由表达

完整结构见 [summary-output.schema.json](summary-output.schema.json)。对象全部字段必填，未知字段拒绝。

| 字段 | 约束与使用方式 |
|---|---|
| `title` | 1 至 200 字符，作为摘要标题 |
| `sections` | 0 至 12 项，实际数量还必须不超过本次 maxSections |
| `sections[].heading` | 1 至 160 字符，作为分节标题 |
| `sections[].markdown` | 1 至 20000 字符的 Markdown，自由正文 |
| `sections[].sourceKeys` | 1 至 64 个 `S[1-9][0-9]*` 形式的键；必须来自本次目录；同节无重复 |
| `notes` | 至多 4000 字符；普通成功摘要为空字符串；记录对读者有用的材料缺失或原始分歧 |

没有足够可总结的内容时 sections 可以为空，在 notes 中说明实际原因。程序在 Zod 校验后检查本次 maxSections、来源存在性和同节重复。正文中的普通链接仅属于正文，程序生成的来源展示以 `sourceKeys` 和 InputUse 为准。

`present` 根据结构生成标题、正文和 `source:S1` 形式的链接。调用方可以直接使用结构化值构建 UI，也可使用这份展示文字。保存结果时将来源绑定到正式材料，读取结果不需要模型服务仍然在线。

## 示例覆盖完整输入和输出

输入变量：

```json
{"language":"zh-CN","maxSections":3,"focus":null}
```

本次材料 S1，名称 `progress.txt`，范围为全文：

> 本周完成资料目录迁移。已保存的文本材料可以离线读取。下一步接入真实模型。

合法输出见 [summary-output.example.json](summary-output.example.json)，其中一个分节为：

```json
{
  "heading": "当前进度",
  "markdown": "资料目录迁移已经完成，已保存文本支持离线读取。下一步工作是接入真实模型。",
  "sourceKeys": ["S1"]
}
```

本例的完整 wire 请求在 [summary-request.json](summary-request.json)，其中 bytesBase64 编码的正文对应 [summary-material.txt](summary-material.txt)。它可直接作为 CLI `--input` 的文件，所选工作台需已配置任务模型。

## 编辑和预览有直接可执行的入口

从解压后的 examples 目录运行，实例选择按 CLI 的全局参数提供：

```bash
themelios task describe document.summary --json
themelios task preview --input summary-request.json --json
themelios prompt read document.summary --part user > edited.liquid
# 编辑 edited.liquid 后：
themelios prompt edit document.summary --part user --file edited.liquid
themelios prompt diff document.summary
themelios task preview --input summary-request.json --json
themelios task run --input summary-request.json --save --json
```

实际 CLI 的命令组和 JSON 规则由 [协议规范](../spec/application-transports.md) 定义。实例覆盖文件位于 `config/prompts/document.summary/`。一次 `prompt edit` 修改一个角色，语法解析成功才替换现有文件；新调用使用新模板，在途生成保持已编译文本。直接修改覆盖文件后，下次编译重新读取变化；不需要重启整个实例。恢复 user 模板：

```bash
themelios prompt reset document.summary --part user
```

模板可使用 LiquidJS 标准过滤器，已启用严格变量、严格过滤器和明确的可选字段分支。输入字段改动以任务定义为入口；纯措辞改动只编辑模板。输入/输出结构的说明、翻译与示例存放在任务资源内，随生成文档一起更新。

## 独立 SDK 示例只需配置模型服务

[embedded-summary.ts](embedded-summary.ts) 展示 createModels、createPrompts、createPreparation 和 createTasks 的组合。它使用实际文本文件直接执行此任务，输出 `Completed.value`，无需安装实例或数据库。

执行环境提供 `THEMELIOS_MODEL_URL`、`THEMELIOS_MODEL_ID` 和 `THEMELIOS_MODEL_KEY`。本例使用 OpenAI-compatible 结构化生成；无认证的本地服务可在连接配置中省略 credential。安装实际发布包后执行：

```bash
bun run embedded-summary.ts
```

完成一次真实调用后，可以把返回的整个完成值通过 ResultOutput 作为另一任务材料；跨会话保留时再调用结果保存能力。
