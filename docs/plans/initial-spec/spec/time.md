# 时间坐标、运行期限和提交切面分别保持准确含义

Themelios 提供真实 UTC、单调计时、其他时间域的坐标与映射，以及数据库已知事实的提交切面。Nous 的发生、观察、形成、适用、记录等认知时间轴由 Nous 在这些原语上定义。时间域公共声明见 [time.ts](../contracts/time.ts)，DDL 见 [storage.sql](../schema/storage.sql)。

## 三种时钟回答三个不同问题

| 能力 | 值 | 用途 |
| --- | --- | --- |
| `Clock.now()` | UTC RFC 3339 毫秒字符串 | 捕获时间、日志、真实记录时间 |
| `Clock.monotonicMs()` | 进程内单调 number | 超时、排队、耗时、关闭期限 |
| `TimePoint` | domain + 十进制 ticks | 世界、媒体之外的应用自定义时间坐标 |

UTC 输入使用 Temporal 校验并规范化为 `YYYY-MM-DDTHH:mm:ss.sssZ`；接受含时区偏移的时间后统一转 UTC，精度约定为毫秒。高于毫秒且含非零部分的输入报 `time.precision_unsupported`。使用当前运行时的 Temporal，缺失时在模块内部导入 `@js-temporal/polyfill`；对象对外仍是 JSON 可表达的字符串。显示时区只影响呈现。

`performance.now()` 提供单调毫秒。网络总期限、任务预算与重试等待始终使用它，即使系统时间回拨、世界暂停或世界加速，运行期限仍按真实经过时间结束。独立算法测试可注入 Clock；正式程序只有 Runtime 创建的真实 Clock。

## 应用时间域定义精度，映射定义与 UTC 的关系

TimeDomain.id 使用应用控制的稳定标识，格式 `[a-z][a-z0-9._-]{0,63}`；label 为显示名称；ticksPerSecond 为 1..1,000,000,000 的整数。ticks 是有符号 64 位整数，以十进制字符串跨接口、以 bigint 计算。define 对完全相同定义返回原值；相同 ID 的不同单位报 `time.domain_conflict`。

映射在真实时间窗口 `[from,until)` 生效，省略 until 表示正无穷。originUtc/originTicks 固定坐标原点；rate 表示“领域秒/真实秒”的非负有理数。numerator≥0、denominator>0，二者为十进制整数，保存前约成最简分数。rate=0 表示领域时间暂停。

令 `u` 为 UTC epoch 毫秒，`u0` 为 originUtc，`t0` 为 originTicks，`s` 为 ticksPerSecond，`p/q` 为 rate：

```text
ticks = t0 + floorDiv((u - u0) * s * p, 1000 * q)
```

所有乘除使用 bigint；floorDiv 向负无穷取整，处理原点之前的坐标。结果超出有符号 64 位范围时报 `time.overflow`。映射计算可以用单一模块内的 floorDiv/ceilDiv/gcd 函数完成，无需时间调度框架。

例如 domain=`world.school`、ticksPerSecond=1000、originTicks=`0`、rate=2/1：真实经过1000ms得到领域ticks=`2000`。rate=0/1 时，整个有效窗口都映射到同一个领域坐标。

## 修改映射保持旧提交切面可解释

time_mappings 的 created_seq/retired_seq 表达数据库何时采用某份映射；effective_from/until 表达映射适用于哪段真实 UTC。它们是两组不同坐标。

setMapping 在一个 Database.write 内完成：

1. 检查 domain 存在，输入窗口、rate 与原点有效。
2. 找出同 domain 当前活动、与新窗口重叠的行。重叠条件为 `old.from < new.until && new.from < old.until`，空 until 当正无穷。
3. 将重叠旧行的 retired_seq 设为当前 seq。旧行左侧或右侧仍有未被覆盖区间时，插入相同原点/rate 的区间副本，created_seq 为当前 seq。
4. 插入新窗口映射。每个新行产生 `map_` + UUID v4；旧行原内容保持不变。

因此在任意提交 cut 下，同一个 domain 的活动 UTC 窗口相互不重叠。改变速率同时保持连续时，调用方先取得切换时的领域坐标，再把它作为新 originTicks；显式跳时则直接提供目标原点。业务选择属于应用。

removeMapping 结束指定活动行的采用区间，会留下明确的无映射窗口。toDomain 找不到指定 cut 下覆盖该 UTC 的映射时，报 `time.unmapped`，包含 domain、utc 与 cut。

## 逆映射返回真实的可能区间

toUtc(point,{at}) 可以返回多个 UTC 区间：暂停、跳时或历史上的重复坐标都可能使一个领域点对应多段真实时间。调用方根据自身业务上下文选择，通用层保留这些结果。

对每个 cut 下活动的映射，令 `d=ticks-t0`、`A=s*p`、`B=1000*q`。A>0 时，UTC 毫秒候选区间为：

```text
[u0 + ceilDiv(d * B, A), u0 + ceilDiv((d + 1) * B, A))
```

将它与该映射的有效窗口相交，丢弃空交集。A=0 时，d=0 返回整段有效窗口，其他点不产生候选。最后按 start 排序并合并相邻、连续的相同候选区间。返回 [] 表示在该 cut 下无对应 UTC。

TimeInterval 表达实际覆盖的 `[start,end)`；UncertainTime 的 earliest/latest 表达一个未知时刻的闭合可能范围。二者分别校验，程序不会把“可能发生在这个范围”解释为“持续了整个范围”。compareTime 只比较相同 domain 的 ticks；跨域比较由应用先选定映射和相同已知切面。

## 记录切面从 Database 的真实提交产生

历史查询选择 cut 时检查 `history_floor <= cut <= currentCut`。通用版本表使用 `created_seq<=cut AND (retired_seq IS NULL OR retired_seq>cut)`；Content 的根保留区间使用同样的半开语义。一次多表操作共享同一个 WriteTransaction.seq。

SDK 查询时显式传入 cut；普通调用省略时在一次 read 事务开始处捕获当前 cut。一个查询中的多个表使用该值，避免把两个不同提交的状态拼在一起。映射历史与材料历史各自按同一数据库 cut 可见，应用由此建立完整历史视图。

## 实施与验收落到实际时间操作

在 `packages/core/src/time.ts` 实现值 Schema、UTC 规范化和整数计算；`packages/storage/src/time-domains.ts` 实现上述 DAO 与映射替换；公开入口为 `@themelios/core/time`、`@themelios/storage/time`。timeSchemaSql 由该存储子入口提供，应用按需要纳入 Database.init。

必要验证是：2倍速、暂停、原点之前的负坐标、窗口替换、跨窗口逆映射，以及替换前后两个 cut 的不同结果。用例如 `from=2026-01-01T00:00:00.000Z` 的固定输入计算精确期望值；另把真实 Clock 调整模拟与单调 deadline 分开验证。整套验证集中在时间模块，用整数等式检查边界，其他业务测试通过公共 API 消费它。

依据：[Temporal.Instant](https://tc39.es/proposal-temporal/docs/instant.html)、[Temporal polyfill](https://github.com/js-temporal/temporal-polyfill)、[W3C High Resolution Time](https://www.w3.org/TR/hr-time-3/)。
