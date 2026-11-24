# @themelios/core

共享值类型、选区、正式和短材料引用、错误、可取消调用及单消费者流。按 UTF-8 字节选取一段文字：

```ts
import { decodeUtf8, selectUtf8 } from "@themelios/core";

const bytes = new TextEncoder().encode("A茶B");
console.log(decodeUtf8(selectUtf8(bytes, {kind: "text", start: 1, end: 4})));
```

`@themelios/core/time` 提供 `utcPoint`、`pointToUtcIso`、`comparePoints`、`matchRange` 和时域 Schema。`utcPoint("2026-11-18T20:00:00+08:00")` 对应 UTC `2026-11-18T12:00:00.000Z`。
