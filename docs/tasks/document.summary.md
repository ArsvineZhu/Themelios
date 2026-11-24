# 材料摘要

联合阅读本次主要材料，使用背景材料辅助理解，输出带材料级来源的分节摘要。

## 输入与材料

任务 ID 为 `document.summary`。每次调用接收 1 至 任意多 份材料。

- `text/*`：text。
- `application/json`：text。
- `application/pdf`：text。
- `image/*`：visual。
- `audio/*`：speech。
- `video/*`：visual。

变量 Schema 见 [输入合同](document.summary.input.schema.json)。本次来源以 `S1`、`S2` 等键按输入排序。模板能读取名称、类型、角色、原件范围、请求选区和实际交付，程序随后追加正文或媒体。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "originalExtent": {
        "oneOf": [
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "text"
              },
              "bytes": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "kind",
              "bytes"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "image"
              },
              "width": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991
              },
              "height": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991
              },
              "frames": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "kind",
              "width",
              "height",
              "frames"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "pages"
              },
              "pages": {
                "type": "integer",
                "minimum": 0,
                "maximum": 9007199254740991
              }
            },
            "required": [
              "kind",
              "pages"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "time"
              },
              "durationMs": {
                "type": "number",
                "minimum": 0
              }
            },
            "required": [
              "kind",
              "durationMs"
            ],
            "additionalProperties": false
          },
          {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "const": "unknown"
              }
            },
            "required": [
              "kind"
            ],
            "additionalProperties": false
          }
        ]
      },
      "requestedRange": {
        "anyOf": [
          {
            "oneOf": [
              {
                "type": "object",
                "properties": {
                  "start": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "end": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "kind": {
                    "type": "string",
                    "const": "text"
                  }
                },
                "required": [
                  "start",
                  "end",
                  "kind"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "pages"
                  },
                  "start": {
                    "type": "integer",
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991
                  },
                  "end": {
                    "type": "integer",
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991
                  }
                },
                "required": [
                  "kind",
                  "start",
                  "end"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "time"
                  },
                  "startMs": {
                    "type": "number",
                    "minimum": 0
                  },
                  "endMs": {
                    "type": "number",
                    "exclusiveMinimum": 0
                  }
                },
                "required": [
                  "kind",
                  "startMs",
                  "endMs"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "image"
                  },
                  "x": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "y": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 9007199254740991
                  },
                  "width": {
                    "type": "integer",
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991
                  },
                  "height": {
                    "type": "integer",
                    "exclusiveMinimum": 0,
                    "maximum": 9007199254740991
                  }
                },
                "required": [
                  "kind",
                  "x",
                  "y",
                  "width",
                  "height"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "json"
                  },
                  "pointer": {
                    "type": "string",
                    "pattern": "^(?:\\/(?:[^~/]|~[01])*)*$"
                  }
                },
                "required": [
                  "kind",
                  "pointer"
                ],
                "additionalProperties": false
              }
            ]
          },
          {
            "type": "null"
          }
        ]
      },
      "delivered": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "sourceRange": {
              "anyOf": [
                {
                  "anyOf": [
                    {
                      "oneOf": [
                        {
                          "type": "object",
                          "properties": {
                            "start": {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            },
                            "end": {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            },
                            "kind": {
                              "type": "string",
                              "const": "text"
                            }
                          },
                          "required": [
                            "start",
                            "end",
                            "kind"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "pages"
                            },
                            "start": {
                              "type": "integer",
                              "exclusiveMinimum": 0,
                              "maximum": 9007199254740991
                            },
                            "end": {
                              "type": "integer",
                              "exclusiveMinimum": 0,
                              "maximum": 9007199254740991
                            }
                          },
                          "required": [
                            "kind",
                            "start",
                            "end"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "time"
                            },
                            "startMs": {
                              "type": "number",
                              "minimum": 0
                            },
                            "endMs": {
                              "type": "number",
                              "exclusiveMinimum": 0
                            }
                          },
                          "required": [
                            "kind",
                            "startMs",
                            "endMs"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "image"
                            },
                            "x": {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            },
                            "y": {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 9007199254740991
                            },
                            "width": {
                              "type": "integer",
                              "exclusiveMinimum": 0,
                              "maximum": 9007199254740991
                            },
                            "height": {
                              "type": "integer",
                              "exclusiveMinimum": 0,
                              "maximum": 9007199254740991
                            }
                          },
                          "required": [
                            "kind",
                            "x",
                            "y",
                            "width",
                            "height"
                          ],
                          "additionalProperties": false
                        },
                        {
                          "type": "object",
                          "properties": {
                            "kind": {
                              "type": "string",
                              "const": "json"
                            },
                            "pointer": {
                              "type": "string",
                              "pattern": "^(?:\\/(?:[^~/]|~[01])*)*$"
                            }
                          },
                          "required": [
                            "kind",
                            "pointer"
                          ],
                          "additionalProperties": false
                        }
                      ]
                    },
                    {
                      "type": "object",
                      "properties": {
                        "kind": {
                          "type": "string",
                          "const": "timePoint"
                        },
                        "atMs": {
                          "type": "number",
                          "minimum": 0
                        }
                      },
                      "required": [
                        "kind",
                        "atMs"
                      ],
                      "additionalProperties": false
                    }
                  ]
                },
                {
                  "type": "null"
                }
              ]
            },
            "extent": {
              "oneOf": [
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "text"
                    },
                    "bytes": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    }
                  },
                  "required": [
                    "kind",
                    "bytes"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "image"
                    },
                    "width": {
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
                    },
                    "height": {
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
                    },
                    "frames": {
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
                    }
                  },
                  "required": [
                    "kind",
                    "width",
                    "height",
                    "frames"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "pages"
                    },
                    "pages": {
                      "type": "integer",
                      "minimum": 0,
                      "maximum": 9007199254740991
                    }
                  },
                  "required": [
                    "kind",
                    "pages"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "time"
                    },
                    "durationMs": {
                      "type": "number",
                      "minimum": 0
                    }
                  },
                  "required": [
                    "kind",
                    "durationMs"
                  ],
                  "additionalProperties": false
                },
                {
                  "type": "object",
                  "properties": {
                    "kind": {
                      "type": "string",
                      "const": "unknown"
                    }
                  },
                  "required": [
                    "kind"
                  ],
                  "additionalProperties": false
                }
              ]
            },
            "mediaType": {
              "type": "string",
              "minLength": 1
            },
            "name": {
              "type": "string",
              "minLength": 1
            }
          },
          "required": [
            "sourceRange",
            "extent",
            "mediaType"
          ],
          "additionalProperties": false
        }
      },
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
      "originalExtent",
      "requestedRange",
      "delivered",
      "key",
      "mediaType",
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

导出当前用户模板，编辑后写入实例覆盖。`request.json` 使用工作台指南中的任务请求格式。

```sh
themelios prompt read document.summary --part user > edited.liquid
themelios prompt edit document.summary --part user --file edited.liquid
themelios task preview --input request.json --json
themelios task run --input request.json --save
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
    "originalExtent": {
      "kind": "text",
      "bytes": 108
    },
    "requestedRange": null,
    "delivered": [
      {
        "mediaType": "text/plain",
        "sourceRange": null,
        "extent": {
          "kind": "text",
          "bytes": 108
        }
      }
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
