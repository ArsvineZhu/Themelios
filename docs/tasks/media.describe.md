# 材料描述

把实际提供的材料范围描述为可读文字，供后续阅读、检索或结构化任务使用。

## 输入与材料

任务 ID 为 `media.describe`。每次调用接收 1 至 1 份材料。

- `text/*`：text。
- `application/json`：text。
- `image/*`：visual。
- `application/pdf`：text + visual。
- `audio/*`：speech。
- `video/*`：visual + speech + motion。

变量 Schema 见 [输入合同](media.describe.input.schema.json)。本次来源以 `S1`、`S2` 等键按输入排序。模板能读取名称、类型、角色、原件范围、请求选区和实际交付，程序随后追加正文或媒体。

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
        "readOnly": true,
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
        "pattern": "^[\\w!#$&^.+-]+\\/[\\w!#$&^.+-]+$",
        "description": "Media type of the original material."
      },
      "name": {
        "description": "Display name of the original material, when known.",
        "type": "string",
        "minLength": 1
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

返回自由文本。


## 编辑和预览

- `system`：`system.md.liquid`。
- `user`：`user.md.liquid`。

导出当前用户模板，编辑后写入实例覆盖。`request.json` 使用工作台指南中的任务请求格式。

```sh
themelios prompt read media.describe --part user > edited.liquid
themelios prompt edit media.describe --part user --file edited.liquid
themelios task preview --input request.json --json
themelios task run --input request.json --save
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
    "originalExtent": {
      "kind": "text",
      "bytes": 45
    },
    "requestedRange": null,
    "delivered": [
      {
        "mediaType": "text/plain",
        "sourceRange": null,
        "extent": {
          "kind": "text",
          "bytes": 45
        }
      }
    ],
    "text": "下午三点在图书馆讨论接口设计。"
  }
]
```

结果

```json
"这是一条安排讨论的文字通知：时间为下午三点，地点为图书馆，主题为接口设计。"
```
