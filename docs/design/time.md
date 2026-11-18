# 时间模型

Themelios 把通用时间概念收敛在 `@themelios/core`（值类型、域模型、比较与查询）和 `@themelios/storage`（域注册表 `time_domains`）之中：

## 域模型与精度约定

每个时间值都归属于一个显式声明的时间域（`TimeDomain`），分成三类：

| 类型 | 含义 | 值表示与顺序 |
| --- | --- | --- |
| `utc` | 内建标准墙钟世界时间域（ID 固定为 `"utc"`） | `Instant` 规范为毫秒精度 ISO-8601 UTC（`YYYY-MM-DDTHH:mm:ss.sssZ`）；内部点数以毫秒数作为 64 位整数序 |
| `linear` | 线性可序域（如叙事时间线、自定义虚拟速率轴或逻辑步数） | 使用带域标识与 64 位有符号整数 `ticks` 的 `TimePoint`，可选 `tickSeconds`（有理数 `numerator/denominator`）说明换算比例 |
| `opaque` | 仅可判等、无全局全序的非标定域（如未定序片段或离散事件纪年） | 允许判断两个点是否相等，不定义大小偏序 |

`toInstant` 接受带时区的四位年份并转换为 UTC。非零亚毫秒位会产生 `time.precision_unsupported`。

`Database.defineTimeDomain(domain)` 将域元数据注册并持久化到 `time_domains` 表中，相同定义幂等返回，冲突重定义抛出 `time.domain_conflict`。

## 瞬时、区间与不精确性

`TemporalValue` 支持三种语义形态：

1. `{ kind: "unknown", sourceText? }`：明确未知时间，保留原始表述文本（若存在）。
2. `{ kind: "instant", at: TimePoint, precision?, sourceText? }`：确知时间点。
3. `{ kind: "interval", domain, start, end, meaning, precision?, sourceText? }`：
   - 端点边界（`TimeBoundary`）支持三种状态：`known`（已知 `TimePoint`）、`unbounded`（无界，用于持续半开端）、`unknown`（存在边界但取值未知）。
   - `meaning` 区分两种本质语义：
     - `"duration"`：真实持续跨度（对象确实延续在整个区间中）。
     - `"uncertain_instant"`：不确定单点位置（事件发生在区间内部某处，位置落在 `[start, end]` 之中）。

## 点比较与三值区间匹配

- `comparePoints(a, b, domainKind)`：跨域比较抛出 `time.domain_mismatch`；在 `opaque` 域下对不同刻度点比大小抛出 `time.order_undefined`。
- `matchRange(value, query, domainKind)` 返回三值逻辑 `RangeMatch`（`"matches"` / `"no_match"` / `"unknown"`）：
  - `uncertain_instant` 仅当已知区间完全落入查询范围内才返回 `"matches"`，部分重叠而无法确定瞬时所在位置时准确返回 `"unknown"`；
  - `duration` 与查询区间明显不相交时返回 `"no_match"`，无未知边界或端点已落在查询区间内时返回 `"matches"`，否则返回 `"unknown"`；
  - 对未知值或 `opaque` 非退化区间查询诚实返回 `"unknown"`，避免把证据不足错误归并为肯定匹配或否定排除。
