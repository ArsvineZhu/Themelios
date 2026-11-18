import { z } from "zod";
import { AppError, appError } from "./errors.js";

const timeApi =
  typeof Temporal === "undefined"
    ? (await import("@js-temporal/polyfill")).Temporal
    : Temporal;
const canonicalUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type Instant = string;

export function toInstant(value: string): Instant {
  try {
    const instant = timeApi.Instant.from(value);
    if (instant.epochNanoseconds % 1_000_000n !== 0n) {
      throw appError("time.precision_unsupported", {
        details: { field: "instant", supportedPrecision: "milliseconds" },
      });
    }
    const utc = instant.toString({ smallestUnit: "millisecond" });
    if (!canonicalUtc.test(utc))
      throw new RangeError("Expected a four-digit UTC year");
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
export const ticksSchema = z
  .string()
  .regex(/^(?:0|-?[1-9][0-9]{0,18})$/)
  .refine((value) => {
    if (!/^-?\d{1,19}$/.test(value)) return false;
    const ticks = BigInt(value);
    return ticks >= -9223372036854775808n && ticks <= 9223372036854775807n;
  }, "Ticks must fit in a signed 64-bit integer");
export const rateSchema = z.strictObject({
  numerator: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
  denominator: z.string().regex(/^[1-9][0-9]*$/),
});
export const timeDomainSchema = z.strictObject({
  id: timeDomainIdSchema,
  label: z.string().min(1),
  ticksPerSecond: z.int().min(1).max(1_000_000_000),
});
export const timePointSchema = z.strictObject({
  domain: timeDomainIdSchema,
  ticks: ticksSchema,
});
export const timeIntervalSchema = z
  .strictObject({
    domain: timeDomainIdSchema,
    start: ticksSchema,
    end: ticksSchema,
  })
  .refine((value) => BigInt(value.start) <= BigInt(value.end), {
    path: ["end"],
    message: "End must be at or after start",
    when: ({ value }) => tickRangeSchema.safeParse(value).success,
  });
const tickRangeSchema = z.object({ start: ticksSchema, end: ticksSchema });
const uncertainBounds = z.object({
  earliest: ticksSchema,
  latest: ticksSchema,
});
export const uncertainTimeSchema = z
  .strictObject({
    domain: timeDomainIdSchema,
    earliest: ticksSchema,
    latest: ticksSchema,
  })
  .refine((value) => BigInt(value.earliest) <= BigInt(value.latest), {
    path: ["latest"],
    message: "Latest must be at or after earliest",
    when: ({ value }) => uncertainBounds.safeParse(value).success,
  });
export const utcIntervalSchema = z.strictObject({
  start: instantSchema,
  end: instantSchema.nullable(),
});

export type TimeDomain = z.infer<typeof timeDomainSchema>;
export type TimePoint = z.infer<typeof timePointSchema>;
export type TimeInterval = z.infer<typeof timeIntervalSchema>;
export type UncertainTime = z.infer<typeof uncertainTimeSchema>;
export type UtcInterval = z.infer<typeof utcIntervalSchema>;
export type Rate = z.infer<typeof rateSchema>;

export function compareTime(a: TimePoint, b: TimePoint): -1 | 0 | 1 {
  if (
    !timePointSchema.safeParse(a).success ||
    !timePointSchema.safeParse(b).success
  ) {
    throw appError("time.invalid", { details: { a: a.domain, b: b.domain } });
  }
  if (a.domain !== b.domain)
    throw appError("time.domain_mismatch", {
      details: { a: a.domain, b: b.domain },
    });
  const left = BigInt(a.ticks);
  const right = BigInt(b.ticks);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function floorDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder !== 0n && remainder < 0n !== denominator < 0n
    ? quotient - 1n
    : quotient;
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return -floorDiv(-numerator, denominator);
}

export function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a < 0n ? -a : a;
}
