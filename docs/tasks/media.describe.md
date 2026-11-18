# 材料描述

把实际提供的材料范围描述为可读文字，供后续阅读、检索或结构化任务使用。

## 输入与材料

任务 ID 为 `media.describe`。每次调用接收 1 至 1 份材料。

- `text/plain`：text。
- `text/markdown`：text。
- `image/*`：visual。
- `application/pdf`：text、visual。
- `audio/*`：speech。
- `video/*`：visual、speech、motion。

变量 Schema 见 [输入合同](media.describe.input.schema.json)。本次来源以 `S1`、`S2` 等键按输入排序。模板能读取名称、类型、角色和实际交付范围，程序随后追加正文或媒体。

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

返回自由文本。


## 编辑和预览

- `system`：`system.md.liquid`。
- `user`：`user.md.liquid`。

内置模板位于工作台 `resources/tasks/media.describe/`。用下列命令编辑当前实例的用户模板。

```sh
themelios prompt read media.describe --part user > edited.liquid
themelios prompt edit media.describe --part user --file edited.liquid
themelios task preview media.describe --input request.json
themelios task run media.describe --input request.json --save
```

## 示例 short-note

变量

```json
{
  "language": "zh-CN",
  "instructions": null
}
```

来源

```json
[
  {
    "key": "S1",
    "mediaType": "text/plain",
    "role": "primary",
    "originalExtent": "全文",
    "deliveredExtent": [
      "全文"
    ],
    "text": "下午三点在图书馆讨论接口设计。"
  }
]
```

结果

```json
"这是一条安排讨论的文字通知：时间为下午三点，地点为图书馆，主题为接口设计。"
```
