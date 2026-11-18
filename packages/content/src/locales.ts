export const locales = {
  en: {
    "content.transaction_mismatch":
      "The material belongs to another database transaction.",
    "content.prepared_closed": "The prepared content has already closed.",
    "content.not_found": "The material or result was not found.",
    "content.text_unavailable": "This material has no directly readable text.",
    "content.range_invalid":
      "The selection is outside the material or uses an invalid boundary.",
    "content.mapping_invalid":
      "The output and source intervals do not contain the same bytes.",
    "content.result_cycle": "The results depend on each other in a cycle.",
    "content.result_corrupt":
      "The stored result and its source records disagree.",
    "content.schema_invalid": "The content does not match the required schema.",
    "content.media_mismatch":
      "The declared media type disagrees with the material bytes.",
    "content.decode_failed": "The material could not be decoded.",
    "content.output_not_found":
      "The result does not have the requested output.",
  },
  "zh-CN": {
    "content.transaction_mismatch": "材料与当前事务所属数据库不同。",
    "content.prepared_closed": "待采用内容已关闭。",
    "content.not_found": "未找到材料或成果。",
    "content.text_unavailable": "此材料没有可直接读取的文本。",
    "content.range_invalid": "选区超出材料范围或边界无效。",
    "content.mapping_invalid": "输出区间与来源区间的实际字节不同。",
    "content.result_cycle": "成果之间存在循环依赖。",
    "content.result_corrupt": "已保存成果与其来源记录不一致。",
    "content.schema_invalid": "内容不符合要求的结构。",
    "content.media_mismatch": "声明的媒体类型与材料字节不符。",
    "content.decode_failed": "无法解码材料。",
    "content.output_not_found": "成果没有请求的输出。",
  },
} as const;
