import type { CommitPoint } from "@themelios/core";
import {
  ceilDiv,
  floorDiv,
  gcd,
  rateSchema,
  ticksSchema,
  timeDomainIdSchema,
  timeDomainSchema,
  timePointSchema,
  toInstant,
  type Instant,
  type Rate,
  type TimeDomain,
  type TimePoint,
  type UtcInterval,
} from "@themelios/core/time";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "./database.js";
import { storageError } from "./errors.js";
import {
  resolveCut,
  type ReadTransaction,
  type WriteTransaction,
} from "./transaction.js";

export interface MappingInput {
  domain: string;
  from: Instant;
  until?: Instant;
  originUtc: Instant;
  originTicks: string;
  rate: Rate;
}
export interface TimeMapping extends MappingInput {
  ref: string;
  createdAtCut: CommitPoint;
}

export interface TimeDomains {
  define(domain: TimeDomain): TimeDomain;
  list(): readonly TimeDomain[];
  setMapping(input: MappingInput): TimeMapping;
  removeMapping(ref: string): void;
  mappings(
    domain: string,
    options?: { at?: CommitPoint },
  ): readonly TimeMapping[];
  toDomain(
    domain: string,
    utc: Instant,
    options?: { at?: CommitPoint },
  ): TimePoint;
  toUtc(
    point: TimePoint,
    options?: { at?: CommitPoint },
  ): readonly UtcInterval[];
}

interface DomainRow {
  id: string;
  label: string;
  ticks_per_second: bigint;
  created_seq: bigint;
}
interface MappingRow {
  ref: string;
  domain_id: string;
  effective_from_utc_ms: bigint;
  effective_until_utc_ms: bigint | null;
  origin_utc_ms: bigint;
  origin_ticks: string;
  rate_numerator: string;
  rate_denominator: string;
  created_seq: bigint;
}

const mappingInputSchema = z.strictObject({
  domain: timeDomainIdSchema,
  from: z.string(),
  until: z.string().optional(),
  originUtc: z.string(),
  originTicks: ticksSchema,
  rate: rateSchema,
});
const mappingRefSchema = z
  .string()
  .regex(
    /^map_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
const earliestUtc = BigInt(Date.parse("0000-01-01T00:00:00.000Z"));
const exclusiveLatestUtc = BigInt(Date.parse("9999-12-31T23:59:59.999Z")) + 1n;
type Sql = ReadTransaction["sql"];

function timeValue<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw storageError("time.invalid", {
    issues: parsed.error.issues.map((issue) => ({
      field: issue.path.map(String).join("."),
      constraint: issue.message,
    })),
  });
}

function epoch(utc: Instant): bigint {
  return BigInt(Date.parse(toInstant(utc)));
}
function instant(ms: bigint): Instant {
  return new Date(Number(ms)).toISOString();
}

function domainRow(sql: Sql, domain: string) {
  return sql
    .query<DomainRow, [string]>("SELECT * FROM time_domains WHERE id = ?")
    .get(domain);
}
function presentDomain({ id, label, ticks_per_second }: DomainRow): TimeDomain {
  return { id, label, ticksPerSecond: Number(ticks_per_second) };
}

function presentMapping(row: MappingRow): TimeMapping {
  return {
    ref: row.ref,
    domain: row.domain_id,
    from: instant(row.effective_from_utc_ms),
    originUtc: instant(row.origin_utc_ms),
    originTicks: row.origin_ticks,
    rate: { numerator: row.rate_numerator, denominator: row.rate_denominator },
    createdAtCut: row.created_seq.toString(),
    ...(row.effective_until_utc_ms === null
      ? {}
      : { until: instant(row.effective_until_utc_ms) }),
  };
}

function insertMapping(
  tx: WriteTransaction,
  mapping: Omit<MappingRow, "ref" | "created_seq">,
): MappingRow {
  const ref = `map_${randomUUID()}`;
  tx.sql.run(
    `INSERT INTO time_mappings (
    ref, domain_id, effective_from_utc_ms, effective_until_utc_ms, origin_utc_ms, origin_ticks,
    rate_numerator, rate_denominator, created_seq
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ref,
    mapping.domain_id,
    mapping.effective_from_utc_ms,
    mapping.effective_until_utc_ms,
    mapping.origin_utc_ms,
    mapping.origin_ticks,
    mapping.rate_numerator,
    mapping.rate_denominator,
    tx.seq,
  );
  return { ...mapping, ref, created_seq: tx.seq };
}

const visible =
  "domain_id = ? AND created_seq <= ? AND (retired_seq IS NULL OR retired_seq > ?)";

function activeMappings(sql: Sql, domain: string, cut: bigint) {
  return sql
    .query<MappingRow>(
      `SELECT * FROM time_mappings WHERE ${visible} ORDER BY effective_from_utc_ms`,
    )
    .all(domain, cut, cut);
}

export function createTimeDomains(database: Database): TimeDomains {
  return {
    define(raw) {
      const domain = timeValue(timeDomainSchema, raw);
      function same(row: DomainRow): TimeDomain {
        const current = presentDomain(row);
        if (
          current.ticksPerSecond !== domain.ticksPerSecond ||
          current.label !== domain.label
        ) {
          throw storageError("time.domain_conflict", {
            domain: domain.id,
            expectedTicksPerSecond: current.ticksPerSecond,
            actualTicksPerSecond: domain.ticksPerSecond,
          });
        }
        return current;
      }
      const current = database.read((tx) => domainRow(tx.sql, domain.id));
      if (current) return same(current);
      return database.write((tx) => {
        const existing = domainRow(tx.sql, domain.id);
        if (existing) return same(existing);
        tx.sql.run(
          "INSERT INTO time_domains (id, label, ticks_per_second, created_seq) VALUES (?, ?, ?, ?)",
          domain.id,
          domain.label,
          domain.ticksPerSecond,
          tx.seq,
        );
        return domain;
      });
    },

    list() {
      return database.read((tx) =>
        tx.sql
          .query<DomainRow>("SELECT * FROM time_domains ORDER BY id")
          .all()
          .map(presentDomain),
      );
    },

    setMapping(raw) {
      const { domain, from, until, originUtc, originTicks, rate } = timeValue(
        mappingInputSchema,
        raw,
      );
      const start = epoch(from);
      const end = until === undefined ? null : epoch(until);
      const origin = epoch(originUtc);
      if (end !== null && end <= start)
        throw storageError("time.invalid", {
          field: "until",
          from,
          until: until!,
        });
      const numerator = BigInt(rate.numerator);
      const denominator = BigInt(rate.denominator);
      const common = gcd(numerator, denominator);
      return database.write((tx) => {
        if (!domainRow(tx.sql, domain))
          throw storageError("time.domain_not_found", { domain });
        const overlaps = tx.sql
          .query<MappingRow>(
            `SELECT * FROM time_mappings WHERE domain_id = ? AND retired_seq IS NULL
          AND (? IS NULL OR effective_from_utc_ms < ?) AND (effective_until_utc_ms IS NULL OR effective_until_utc_ms > ?)`,
          )
          .all(domain, end, end, start);
        for (const old of overlaps) {
          tx.sql.run(
            "UPDATE time_mappings SET retired_seq = ? WHERE ref = ?",
            tx.seq,
            old.ref,
          );
          if (old.effective_from_utc_ms < start)
            insertMapping(tx, { ...old, effective_until_utc_ms: start });
          if (
            end !== null &&
            (old.effective_until_utc_ms === null ||
              end < old.effective_until_utc_ms)
          ) {
            insertMapping(tx, { ...old, effective_from_utc_ms: end });
          }
        }
        return presentMapping(
          insertMapping(tx, {
            domain_id: domain,
            effective_from_utc_ms: start,
            effective_until_utc_ms: end,
            origin_utc_ms: origin,
            origin_ticks: originTicks,
            rate_numerator: String(numerator / common),
            rate_denominator: String(denominator / common),
          }),
        );
      });
    },

    removeMapping(ref) {
      timeValue(mappingRefSchema, ref);
      database.write((tx) =>
        tx.sql.run(
          "UPDATE time_mappings SET retired_seq = ? WHERE ref = ? AND retired_seq IS NULL",
          tx.seq,
          ref,
        ),
      );
    },

    mappings(raw, { at } = {}) {
      const domain = timeValue(timeDomainIdSchema, raw);
      return database.read((tx) =>
        activeMappings(tx.sql, domain, resolveCut(tx, at)).map(presentMapping),
      );
    },

    toDomain(raw, utc, { at } = {}) {
      const domain = timeValue(timeDomainIdSchema, raw);
      const time = epoch(utc);
      return database.read((tx) => {
        const cut = resolveCut(tx, at);
        const mapping = tx.sql
          .query<MappingRow>(
            `SELECT * FROM time_mappings WHERE ${visible}
          AND effective_from_utc_ms <= ? AND (effective_until_utc_ms IS NULL OR effective_until_utc_ms > ?)`,
          )
          .get(domain, cut, cut, time, time);
        if (!mapping)
          throw storageError("time.unmapped", {
            domain,
            utc: instant(time),
            cut: cut.toString(),
          });
        const units = domainRow(tx.sql, domain)!.ticks_per_second;
        const ticks =
          BigInt(mapping.origin_ticks) +
          floorDiv(
            (time - mapping.origin_utc_ms) *
              units *
              BigInt(mapping.rate_numerator),
            1000n * BigInt(mapping.rate_denominator),
          );
        if (ticks < -9223372036854775808n || ticks > 9223372036854775807n) {
          throw storageError("time.overflow", {
            domain,
            value: ticks.toString(),
            minimum: "-9223372036854775808",
            maximum: "9223372036854775807",
          });
        }
        return { domain, ticks: ticks.toString() };
      });
    },

    toUtc(raw, { at } = {}) {
      const { domain, ticks } = timeValue(timePointSchema, raw);
      return database.read((tx) => {
        const cut = resolveCut(tx, at);
        const units = domainRow(tx.sql, domain)?.ticks_per_second;
        if (units === undefined) return [];
        const result: UtcInterval[] = [];
        for (const mapping of activeMappings(tx.sql, domain, cut)) {
          const interval = inverse(mapping, BigInt(ticks), units);
          if (!interval) continue;
          const last = result.at(-1);
          if (last && last.end === interval.start) last.end = interval.end;
          else result.push(interval);
        }
        return result;
      });
    },
  };
}

function inverse(
  mapping: MappingRow,
  ticks: bigint,
  units: bigint,
): UtcInterval | undefined {
  const delta = ticks - BigInt(mapping.origin_ticks);
  const scaled = units * BigInt(mapping.rate_numerator);
  let start = mapping.effective_from_utc_ms;
  let end = mapping.effective_until_utc_ms;
  if (scaled === 0n) {
    if (delta !== 0n) return undefined;
  } else {
    const base = 1000n * BigInt(mapping.rate_denominator);
    const after = mapping.origin_utc_ms + ceilDiv(delta * base, scaled);
    const before = mapping.origin_utc_ms + ceilDiv((delta + 1n) * base, scaled);
    if (after > start) start = after;
    if (end === null || before < end) end = before;
  }
  if (
    start >= exclusiveLatestUtc ||
    (end !== null && (end <= start || end <= earliestUtc))
  )
    return undefined;
  return {
    start: instant(start),
    end: end === null || end >= exclusiveLatestUtc ? null : instant(end),
  };
}
