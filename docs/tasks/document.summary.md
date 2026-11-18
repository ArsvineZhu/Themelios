# 材料摘要

联合阅读本次主要材料，使用背景材料辅助理解，输出带材料级来源的分节摘要。

## 输入与材料

任务 ID 为 `document.summary`。每次调用接收 1 至 64 份材料。

- `text/plain`：text。
- `text/markdown`：text。
- `application/json`：text。
- `application/pdf`：text。
- `image/*`：visual。

变量 Schema 见 [输入合同](document.summary.input.schema.json)。本次来源以 `S1`、`S2` 等键按输入排序。模板能读取名称、类型、角色和实际交付范围，程序随后追加正文或媒体。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "key": {
        "type": "string",
        "pattern": "^S[1-9]\\d*$",
        "description": "Short key for a material in this call."
      },
      "mediaType": {
        "type": "string",
        "pattern": "^[\\w!#$&^.+-]+\\/(?:[\\w!#$&^.+-]+|\\*)$",
        "description": "Media type of the original material."
      },
      "name": {
        "description": "Display name of the original material, when known.",
        "type": "string"
      },
      "originalExtent": {
        "type": "string",
        "description": "Range of the original material selected for this call."
      },
      "deliveredExtent": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "Actual representations or ranges passed to the task."
      },
      "role": {
        "type": "string",
        "enum": [
          "primary",
          "context"
        ],
        "description": "Material being processed or auxiliary context."
      }
    },
    "required": [
      "key",
      "mediaType",
      "originalExtent",
      "deliveredExtent",
      "role"
    ],
    "additionalProperties": false
  }
}
```

## 输出

返回 [结构化对象](document.summary.output.schema.json)。

- sections 数量不超过本次 maxSections。
- 每个 sourceKeys 值都存在于本次来源目录。

## 编辑和预览

- `system`：`system.md.liquid`。
- `user`：`user.md.liquid`。

内置模板位于工作台 `resources/tasks/document.summary/`。用下列命令编辑当前实例的用户模板。

```sh
themelios prompt read document.summary --part user > edited.liquid
themelios prompt edit document.summary --part user --file edited.liquid
themelios task preview document.summary --input request.json
themelios task run document.summary --input request.json --save
```

## 示例 project-progress

变量

```json
{
  "language": "zh-CN",
  "maxSections": 3,
  "focus": null
}
```

来源

```json
[
  {
    "key": "S1",
    "mediaType": "text/plain",
    "name": "progress.txt",
    "text": "本周完成资料目录迁移。已保存的文本材料可以离线读取。下一步接入真实模型。",
    "originalExtent": "全文",
    "deliveredExtent": [
      "全文"
    ],
    "role": "primary"
  }
]
```

结果

```json
{
  "title": "资料工作台进展",
  "sections": [
    {
      "heading": "当前进度",
      "markdown": "资料目录迁移已经完成，已保存文本支持离线读取。下一步工作是接入真实模型。",
      "sourceKeys": [
        "S1"
      ]
    }
  ],
  "notes": ""
}
```
