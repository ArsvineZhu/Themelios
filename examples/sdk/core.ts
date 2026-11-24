import {
  appError,
  artifactRefSchema,
  attachTraceId,
  completedSchema,
  createAgentRefBook,
  createFlow,
  decodeReadable60,
  decodeUtf8,
  encodeReadable60,
  openCall,
  parseJson,
  rangeSchema,
  selectUtf8,
  toErrorInfo,
} from "@themelios/core";
import {
  comparePoints,
  matchRange,
  pointToUtcIso,
  systemClock,
  toInstant,
  utcPoint,
} from "@themelios/core/time";

const canonical = artifactRefSchema.parse(
  "art_12345678-1234-4123-8123-123456789abc",
);
const refs = createAgentRefBook();
const external = refs.toAgent(canonical);
const readable = encodeReadable60(12345n);
console.log(
  "身份往返",
  refs.toCanonical(external) === canonical,
  decodeReadable60(readable).toString(),
);

const text = new TextEncoder().encode("A茶B");
const source = { bytes: text, mediaType: "text/plain" };
const range = { kind: "text" as const, start: 1, end: 4 };
const chosen = decodeUtf8(selectUtf8(text, range));
const completed = completedSchema.parse({
  value: parseJson({ selected: chosen }),
  inputs: [
    {
      source,
      delivered: [{ bytes: selectUtf8(text, range), mediaType: "text/plain" }],
      role: "primary",
    },
  ],
  files: [],
  producer: { kind: "application", name: "tea.extract" },
});
console.log("保留原件与交付部分", completed.value, completed.inputs.length);
console.log(
  "其他坐标",
  [
    { kind: "pages", start: 2, end: 3 },
    { kind: "time", startMs: 10, endMs: 30 },
    { kind: "image", x: 0, y: 0, width: 8, height: 8 },
    { kind: "json", pointer: "/title" },
  ].map((value) => rangeSchema.parse(value).kind),
);

const local = "2026-11-18T20:00:00+08:00";
const point = (ticks: string) => ({ domain: "scene", ticks });
const boundary = (n: string) => ({ kind: "known" as const, point: point(n) });
const query = { domain: "scene", start: boundary("3"), end: boundary("5") };
const span = {
  kind: "interval" as const,
  domain: "scene",
  start: boundary("2"),
  end: boundary("4"),
};
console.log("墙钟", toInstant(local), pointToUtcIso(utcPoint(local)));
console.log("有序时域", comparePoints(point("3"), point("4"), "linear"));
console.log(
  "时域匹配",
  matchRange({ ...span, meaning: "duration" }, query, "linear"),
  matchRange({ ...span, meaning: "uncertain_instant" }, query, "linear"),
  matchRange({ kind: "unknown", sourceText: "某个傍晚" }, query, "linear"),
);
try {
  comparePoints(point("3"), point("4"), "opaque");
} catch (err) {
  console.log("无序域", toErrorInfo(err).code);
}
console.log("时钟实现", typeof systemClock.now() === "string");

const flow = createFlow("tea.render", async function* (call) {
  yield { type: "progress", progress: { stage: "reading" } };
  call.throwIfAborted();
  yield { type: "text-delta", text: chosen };
  return completed.value;
});
for await (const event of flow) console.log("事件", event);
const controller = new AbortController();
const call = openCall("tea.cancel", {
  signal: controller.signal,
  timeoutMs: 1500,
});
try {
  controller.abort("用户取消");
  call.throwIfAborted("read");
} catch (err) {
  console.log("取消", toErrorInfo(err).code);
} finally {
  call.close();
}
const error = appError("tea.missing", { details: { sku: "T01" } });
attachTraceId(error, "trace-for-sample");
console.log(
  "可展示错误",
  toErrorInfo(error, () => "未找到茶品"),
);
