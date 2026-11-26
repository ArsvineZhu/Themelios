export const locales = {
  en: {
    "content.not_found": "The material or result was not found.",
    "content.text_unavailable": "This material has no directly readable text.",
    "content.range_invalid":
      "The selection is outside the material or uses an invalid boundary.",
    "content.result_cycle": "The results depend on each other in a cycle.",
    "content.result_corrupt":
      "The stored result and its source records disagree.",
    "content.schema_invalid": "The content does not match the required schema.",
    "content.media_mismatch":
      "The declared media type disagrees with the material bytes.",
    "content.decode_failed": "The material could not be decoded.",
    "content.output_not_found":
      "The result does not have the requested output.",
    "content.representation_mismatch":
      "The saved result does not link the requested output to this source selection.",
  },
  "zh-CN": {
    "content.not_found": "未找到材料或成果。",
    "content.text_unavailable": "此材料没有可直接读取的文本。",
    "content.range_invalid": "选区超出材料范围或边界无效。",
    "content.result_cycle": "成果之间存在循环依赖。",
    "content.result_corrupt": "已保存成果与其来源记录不一致。",
    "content.schema_invalid": "内容不符合要求的结构。",
    "content.media_mismatch": "声明的媒体类型与材料字节不符。",
    "content.decode_failed": "无法解码材料。",
    "content.output_not_found": "成果没有请求的输出。",
    "content.representation_mismatch": "已保存成果的输出与请求的来源选区不符。",
  },
} as const;
