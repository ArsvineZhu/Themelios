import { z } from "zod";
import { AppError, appError } from "./errors.js";

const canonicalUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const rfc3339Pattern =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

export type Instant = string;

export interface Clock {
  now(): Instant;
  monotonicMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  monotonicMs: () => performance.now(),
};

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

export function toInstant(value: string): Instant {
  const match = rfc3339Pattern.exec(value);
  if (!match) throw appError("time.invalid", { details: { value } });
  const [
    ,
    yStr,
    mStr,
    dStr,
    hStr,
    minStr,
    sStr,
    frac = "",
    sign,
    ohStr,
    omStr,
  ] = match;
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  const hour = Number(hStr);
  const minute = Number(minStr);
  const second = Number(sStr);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw appError("time.invalid", { details: { value } });
  }
  if (frac.length > 3 && !/^0*$/.test(frac.slice(3))) {
    throw appError("time.precision_unsupported", {
      details: { field: "instant", supportedPrecision: "milliseconds" },
    });
  }
  const ms = Number(frac.slice(0, 3).padEnd(3, "0"));
  let offsetMs = 0;
  if (sign) {
    const offH = Number(ohStr);
    const offM = Number(omStr);
    if (offH > 23 || offM > 59) {
      throw appError("time.invalid", { details: { value } });
    }
    offsetMs = (sign === "+" ? 1 : -1) * (offH * 60 + offM) * 60_000;
  }
  try {
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, ms);
    const epochMs = date.getTime() - offsetMs;
    const utc = new Date(epochMs).toISOString();
    if (!canonicalUtc.test(utc))
      throw new RangeError("Expected four-digit UTC year");
    return utc;
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw appError("time.invalid", { details: { value }, cause });
  }
}

export const instantSchema = z
  .string()
  .regex(canonicalUtc)
  .refine((value) => {
    try {
      return toInstant(value) === value;
    } catch {
      return false;
    }
  }, "Expected canonical UTC with millisecond precision");

export const timeDomainIdSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
const utcDomain = "utc";
export const customTimeDomainIdSchema = timeDomainIdSchema.refine(
  (value) => value !== utcDomain,
  '"utc" is reserved for the built-in UTC domain',
);

export const ticksSchema = z
  .string()
  .regex(/^(?:0|-?[1-9][0-9]{0,18})$/, { abort: true })
  .refine((value) => {
    const ticks = BigInt(value);
    return ticks >= -9223372036854775808n && ticks <= 9223372036854775807n;
  }, "Ticks must fit in a signed 64-bit integer");

export const tickSecondsSchema = z.strictObject({
  numerator: z.string().regex(/^[1-9][0-9]*$/),
  denominator: z.string().regex(/^[1-9][0-9]*$/),
});

const customDomains = [
  z.strictObject({
    id: customTimeDomainIdSchema,
    kind: z.literal("linear"),
    label: z.string().min(1),
    tickSeconds: tickSecondsSchema.optional(),
  }),
  z.strictObject({
    id: customTimeDomainIdSchema,
    kind: z.literal("opaque"),
    label: z.string().min(1),
  }),
] as const;
export const customTimeDomainSchema = z.discriminatedUnion(
  "kind",
  customDomains,
);
export type CustomTimeDomain = z.output<typeof customTimeDomainSchema>;

const utcTimeDomainSchema = z.strictObject({
  id: z.literal(utcDomain),
  kind: z.literal(utcDomain),
  label: z.string().min(1),
});
export const timeDomainSchema = z.discriminatedUnion("kind", [
  utcTimeDomainSchema,
  ...customDomains,
]);

export type TimeDomain = z.infer<typeof timeDomainSchema>;
export type TickSeconds = z.infer<typeof tickSecondsSchema>;

export const UTC_TIME_DOMAIN: z.output<typeof utcTimeDomainSchema> =
  Object.freeze({
    id: utcDomain,
    kind: utcDomain,
    label: "UTC",
  });

export const timePointSchema = z.strictObject({
  domain: timeDomainIdSchema,
  ticks: ticksSchema,
});
export type TimePoint = z.infer<typeof timePointSchema>;

export function utcPoint(iso: string): TimePoint {
  const utc = toInstant(iso);
  return { domain: UTC_TIME_DOMAIN.id, ticks: String(Date.parse(utc)) };
}

export function pointToUtcIso(point: TimePoint): Instant {
  if (!timePointSchema.safeParse(point).success) {
    throw appError("time.invalid", { details: { point } });
  }
  if (point.domain !== UTC_TIME_DOMAIN.id) {
    throw appError("time.domain_mismatch", {
      details: { expected: UTC_TIME_DOMAIN.id, actual: point.domain },
    });
  }
  const date = new Date(Number(point.ticks));
  const iso = Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  if (!iso || !canonicalUtc.test(iso)) {
    throw appError("time.invalid", { details: { point } });
  }
  return iso;
}

export const timeBoundarySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("known"), point: timePointSchema }),
  z.strictObject({ kind: z.literal("unbounded") }),
  z.strictObject({ kind: z.literal("unknown") }),
]);
export type TimeBoundary = z.infer<typeof timeBoundarySchema>;

export const temporalValueSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("unknown"),
      sourceText: z.string().min(1).optional(),
    }),
    z.strictObject({
      kind: z.literal("instant"),
      at: timePointSchema,
      precision: z.string().min(1).optional(),
      sourceText: z.string().min(1).optional(),
    }),
    z.strictObject({
      kind: z.literal("interval"),
      domain: timeDomainIdSchema,
      start: timeBoundarySchema,
      end: timeBoundarySchema,
      meaning: z.enum(["duration", "uncertain_instant"]),
      precision: z.string().min(1).optional(),
      sourceText: z.string().min(1).optional(),
    }),
  ])
  .superRefine((value, ctx) => {
    if (value.kind !== "interval") return;
    if (
      value.start.kind === "known" &&
      value.start.point.domain !== value.domain
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["start", "point", "domain"],
        message: "Start boundary domain must match interval domain",
      });
    }
    if (value.end.kind === "known" && value.end.point.domain !== value.domain) {
      ctx.addIssue({
        code: "custom",
        path: ["end", "point", "domain"],
        message: "End boundary domain must match interval domain",
      });
    }
    if (
      value.start.kind === "known" &&
      value.end.kind === "known" &&
      BigInt(value.start.point.ticks) > BigInt(value.end.point.ticks)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["end"],
        message: "End boundary must not precede start boundary",
      });
    }
  });

export type TemporalValue = z.infer<typeof temporalValueSchema>;

export const timeRangeBoundarySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("known"), point: timePointSchema }),
  z.strictObject({ kind: z.literal("unbounded") }),
]);
export type TimeRangeBoundary = z.infer<typeof timeRangeBoundarySchema>;

export const timeRangeQuerySchema = z
  .strictObject({
    domain: timeDomainIdSchema,
    start: timeRangeBoundarySchema,
    end: timeRangeBoundarySchema,
  })
  .superRefine((query, ctx) => {
    if (
      query.start.kind === "known" &&
      query.start.point.domain !== query.domain
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["start", "point", "domain"],
        message: "Start domain must match query domain",
      });
    }
    if (query.end.kind === "known" && query.end.point.domain !== query.domain) {
      ctx.addIssue({
        code: "custom",
        path: ["end", "point", "domain"],
        message: "End domain must match query domain",
      });
    }
    if (
      query.start.kind === "known" &&
      query.end.kind === "known" &&
      BigInt(query.start.point.ticks) > BigInt(query.end.point.ticks)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["end"],
        message: "Query end must not precede start",
      });
    }
  });
export type TimeRangeQuery = z.infer<typeof timeRangeQuerySchema>;
export type RangeMatch = "matches" | "no_match" | "unknown";

export function comparePoints(
  a: TimePoint,
  b: TimePoint,
  domainKind: TimeDomain["kind"] = "linear",
): -1 | 0 | 1 {
  if (
    !timePointSchema.safeParse(a).success ||
    !timePointSchema.safeParse(b).success
  ) {
    throw appError("time.invalid", { details: { a: a.domain, b: b.domain } });
  }
  if (a.domain !== b.domain) {
    throw appError("time.domain_mismatch", {
      details: { a: a.domain, b: b.domain },
    });
  }
  const left = BigInt(a.ticks);
  const right = BigInt(b.ticks);
  if (left === right) return 0;
  if (domainKind === "opaque") {
    throw appError("time.order_undefined", { details: { domain: a.domain } });
  }
  return left < right ? -1 : 1;
}

function knownTicks(boundary: TimeBoundary): bigint | undefined {
  return boundary.kind === "known" ? BigInt(boundary.point.ticks) : undefined;
}

function before(left: bigint | undefined, right: bigint | undefined): boolean {
  return left !== undefined && right !== undefined && left < right;
}

function inQueryRange(
  ticks: bigint,
  qStart: bigint | undefined,
  qEnd: bigint | undefined,
): boolean {
  return !before(ticks, qStart) && !before(qEnd, ticks);
}

function opaquePoint(
  start: TimeBoundary,
  end: TimeBoundary,
): string | undefined {
  if (
    start.kind === "known" &&
    end.kind === "known" &&
    start.point.ticks === end.point.ticks
  ) {
    return start.point.ticks;
  }
}

function matchOpaque(value: TemporalValue, query: TimeRangeQuery): RangeMatch {
  if (query.start.kind === "unbounded" && query.end.kind === "unbounded")
    return "matches";
  const target = opaquePoint(query.start, query.end);
  if (target === undefined || value.kind === "unknown") return "unknown";
  const actual =
    value.kind === "instant"
      ? value.at.ticks
      : opaquePoint(value.start, value.end);
  if (actual === undefined) return "unknown";
  return actual === target ? "matches" : "no_match";
}

function matchOrderedInterval(
  value: Extract<TemporalValue, { kind: "interval" }>,
  qStart: bigint | undefined,
  qEnd: bigint | undefined,
): RangeMatch {
  const knownStart = knownTicks(value.start);
  const knownEnd = knownTicks(value.end);
  if (before(knownEnd, qStart) || before(qEnd, knownStart)) {
    return "no_match";
  }
  if (qStart === undefined && qEnd === undefined) return "matches";
  if (value.meaning === "uncertain_instant")
    return matchUncertain(knownStart, knownEnd, qStart, qEnd);
  return matchDuration(value, knownStart, knownEnd, qStart, qEnd);
}

function matchUncertain(
  start: bigint | undefined,
  end: bigint | undefined,
  queryStart: bigint | undefined,
  queryEnd: bigint | undefined,
): RangeMatch {
  const startContained =
    queryStart === undefined || (start !== undefined && start >= queryStart);
  const endContained =
    queryEnd === undefined || (end !== undefined && end <= queryEnd);
  return startContained && endContained ? "matches" : "unknown";
}

function matchDuration(
  value: Extract<TemporalValue, { kind: "interval" }>,
  knownStart: bigint | undefined,
  knownEnd: bigint | undefined,
  qStart: bigint | undefined,
  qEnd: bigint | undefined,
): RangeMatch {
  // A non-disjoint duration with non-unknown endpoints always overlaps the query interval.
  if (value.start.kind !== "unknown" && value.end.kind !== "unknown")
    return "matches";
  if (knownStart !== undefined && inQueryRange(knownStart, qStart, qEnd))
    return "matches";
  if (knownEnd !== undefined && inQueryRange(knownEnd, qStart, qEnd))
    return "matches";
  return "unknown";
}

export function matchRange(
  value: TemporalValue,
  query: TimeRangeQuery,
  domainKind: TimeDomain["kind"] = "linear",
): RangeMatch {
  if (
    !temporalValueSchema.safeParse(value).success ||
    !timeRangeQuerySchema.safeParse(query).success
  ) {
    throw appError("time.invalid");
  }
  if (value.kind === "unknown") return "unknown";
  const domain = value.kind === "instant" ? value.at.domain : value.domain;
  if (domain !== query.domain) return "no_match";
  if (domainKind === "opaque") return matchOpaque(value, query);
  const qStart = knownTicks(query.start);
  const qEnd = knownTicks(query.end);
  if (value.kind === "instant") {
    return inQueryRange(BigInt(value.at.ticks), qStart, qEnd)
      ? "matches"
      : "no_match";
  }
  return matchOrderedInterval(value, qStart, qEnd);
}
