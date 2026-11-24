import { expect, test } from "bun:test";
import {
  agentArtifactRefSchema,
  comparePoints,
  createAgentRefBook,
  decodeReadable60,
  encodeReadable60,
  formatAgentArtifactRef,
  instantSchema,
  matchRange,
  parseAgentArtifactCode,
  pointToUtcIso,
  timeRangeQuerySchema,
  toInstant,
  utcPoint,
  type ArtifactRef,
  type TemporalValue,
  type TimeRangeQuery,
} from "@themelios/core";

test("multi-domain time values validate precision, ordering, and 3-valued range queries", () => {
  expect(toInstant("0042-01-01T02:00:00+02:00")).toBe(
    "0042-01-01T00:00:00.000Z",
  );
  expect(toInstant("2026-01-01T08:00:00+08:00")).toBe(
    "2026-01-01T00:00:00.000Z",
  );
  expect(() => toInstant("2026-01-01T00:00:00.1234Z")).toThrow(
    expect.objectContaining({ code: "time.precision_unsupported" }),
  );
  expect(instantSchema.safeParse("2026-01-01T00:00:00.1234Z").success).toBe(
    false,
  );

  const u0 = utcPoint("2026-01-01T00:00:00.000Z");
  const u1 = utcPoint("2026-01-01T00:00:05.000Z");
  expect(pointToUtcIso(u0)).toBe("2026-01-01T00:00:00.000Z");
  const outOfCalendar = { domain: "utc", ticks: "9000000000000000" };
  expect(() => pointToUtcIso(outOfCalendar)).toThrow(
    expect.objectContaining({ code: "time.invalid" }),
  );
  expect(
    timeRangeQuerySchema.safeParse({
      domain: "utc",
      start: { kind: "known", point: { domain: "utc", ticks: "unknown" } },
      end: { kind: "known", point: u1 },
    }).success,
  ).toBe(false);
  expect(comparePoints(u0, u1, "utc")).toBe(-1);

  const storyA = { domain: "story.timeline", ticks: "100" };
  const storyB = { domain: "story.timeline", ticks: "200" };
  expect(comparePoints(storyA, storyB, "linear")).toBe(-1);
  expect(() => comparePoints(storyA, u0, "linear")).toThrow(
    expect.objectContaining({ code: "time.domain_mismatch" }),
  );
  expect(comparePoints(storyA, storyA, "opaque")).toBe(0);
  expect(() => comparePoints(storyA, storyB, "opaque")).toThrow(
    expect.objectContaining({ code: "time.order_undefined" }),
  );

  const query: TimeRangeQuery = {
    domain: "story.timeline",
    start: { kind: "known", point: storyA },
    end: { kind: "known", point: storyB },
  };
  const durationWithUnknownEnd: TemporalValue = {
    kind: "interval",
    domain: "story.timeline",
    start: { kind: "known", point: { domain: "story.timeline", ticks: "150" } },
    end: { kind: "unknown" },
    meaning: "duration",
  };
  const uncertainOverlap: TemporalValue = {
    kind: "interval",
    domain: "story.timeline",
    start: { kind: "known", point: { domain: "story.timeline", ticks: "50" } },
    end: { kind: "known", point: { domain: "story.timeline", ticks: "150" } },
    meaning: "uncertain_instant",
  };
  const uncertainContained: TemporalValue = {
    kind: "interval",
    domain: "story.timeline",
    start: { kind: "known", point: { domain: "story.timeline", ticks: "110" } },
    end: { kind: "known", point: { domain: "story.timeline", ticks: "190" } },
    meaning: "uncertain_instant",
  };
  const durationDisjoint: TemporalValue = {
    kind: "interval",
    domain: "story.timeline",
    start: { kind: "unbounded" },
    end: { kind: "known", point: { domain: "story.timeline", ticks: "99" } },
    meaning: "duration",
  };

  expect(matchRange(durationWithUnknownEnd, query, "linear")).toBe("matches");
  expect(matchRange(uncertainOverlap, query, "linear")).toBe("unknown");
  expect(matchRange(uncertainContained, query, "linear")).toBe("matches");
  expect(matchRange(durationDisjoint, query, "linear")).toBe("no_match");
  expect(matchRange({ kind: "unknown" }, query, "linear")).toBe("unknown");
  expect(
    matchRange(
      { kind: "instant", at: storyA },
      {
        domain: "story.timeline",
        start: { kind: "known", point: storyA },
        end: { kind: "known", point: storyA },
      },
      "opaque",
    ),
  ).toBe("matches");
  expect(matchRange({ kind: "instant", at: storyA }, query, "opaque")).toBe(
    "unknown",
  );
});

test("readable60 codes roundtrip 60-bit values and AgentRefBook translates bidirectionally", () => {
  for (const sample of [
    0n,
    1n,
    2n,
    0x123456789abcdef0n & ((1n << 60n) - 1n),
    (1n << 60n) - 1n,
  ]) {
    const code = encodeReadable60(sample);
    expect(decodeReadable60(code)).toBe(sample);
    const formatted = formatAgentArtifactRef(code);
    expect(agentArtifactRefSchema.safeParse(formatted).success).toBe(true);
    expect(parseAgentArtifactCode(formatted)).toBe(code);
  }
  const upperUnit = encodeReadable60(1n);
  const lowerUnit = encodeReadable60(2n);
  expect(upperUnit).toEndWith("File");
  expect(lowerUnit).toBe(upperUnit.toLowerCase());
  expect(decodeReadable60(upperUnit)).not.toBe(decodeReadable60(lowerUnit));
  expect(() => decodeReadable60("zzzzzzzzzzzzzzzzzzzzzzzz")).toThrow(
    expect.objectContaining({ code: "input.invalid" }),
  );

  const book = createAgentRefBook();
  const canonicalA = ("art_" + crypto.randomUUID()) as ArtifactRef;
  const canonicalB = ("art_" + crypto.randomUUID()) as ArtifactRef;
  const agentA = book.toAgent(canonicalA);
  const agentB = book.toAgent(canonicalB);
  expect(agentA).not.toBe(agentB);
  expect(book.toAgent(canonicalA)).toBe(agentA);
  expect(book.toCanonical(agentA)).toBe(canonicalA);
  expect(book.toCanonical(canonicalB)).toBe(canonicalB);
});
