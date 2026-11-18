export const locales = {
  en: {
    "storage.already_exists": "The destination already exists.",
    "storage.format_mismatch": "The database uses a different storage format.",
    "storage.transaction_closed": "The database transaction has ended.",
    "storage.transaction_nested":
      "Pass the active transaction to the operation.",
    "storage.async_transaction":
      "A database transaction callback must return synchronously.",
    "storage.write_failed": "Could not write the storage data.",
    "storage.read_failed": "Could not read the storage data.",
    "storage.blob_missing": "The stored byte object is missing.",
    "storage.blob_corrupt": "The stored byte object is damaged.",
    "storage.history_unavailable": "The requested history was collected.",
    "storage.cut_invalid": "The requested commit position is invalid.",
    "storage.limit_exceeded": "The material exceeds the byte limit.",
    "time.domain_conflict":
      "The time domain already has a different definition.",
    "time.domain_not_found": "The time domain does not exist.",
    "time.overflow":
      "The time coordinate is outside the supported integer range.",
    "time.unmapped": "No mapping covers the requested instant at that commit.",
  },
  "zh-CN": {
    "storage.already_exists": "目标已存在。",
    "storage.format_mismatch": "数据库的存储格式与当前应用不同。",
    "storage.transaction_closed": "数据库事务已结束。",
    "storage.transaction_nested": "请向操作传入当前事务。",
    "storage.async_transaction": "数据库事务回调必须同步返回。",
    "storage.write_failed": "无法写入存储数据。",
    "storage.read_failed": "无法读取存储数据。",
    "storage.blob_missing": "存储中的字节对象缺失。",
    "storage.blob_corrupt": "存储中的字节对象已损坏。",
    "storage.history_unavailable": "请求的历史已回收。",
    "storage.cut_invalid": "请求的提交位置无效。",
    "storage.limit_exceeded": "材料超出字节数上限。",
    "time.domain_conflict": "时间域已有不同的定义。",
    "time.domain_not_found": "时间域不存在。",
    "time.overflow": "时间坐标超出支持的整数范围。",
    "time.unmapped": "该提交下没有覆盖此时刻的映射。",
  },
} as const;
