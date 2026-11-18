import type { CommitPoint, Instant } from './core.js';
import type { Database } from './storage.js';

export interface TimeDomain {
  id: string;
  label: string;
  ticksPerSecond: number;
}
export interface TimePoint { domain: string; ticks: string }
export interface TimeInterval { domain: string; start: string; end: string }
export interface UncertainTime { domain: string; earliest: string; latest: string }
export interface UtcInterval { start: Instant; end: Instant | null }
export interface Rate { numerator: string; denominator: string }

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
  mappings(domain: string, options?: { at?: CommitPoint }): readonly TimeMapping[];
  toDomain(domain: string, utc: Instant, options?: { at?: CommitPoint }): TimePoint;
  toUtc(point: TimePoint, options?: { at?: CommitPoint }): readonly UtcInterval[];
}

/** @themelios/storage/time */
export declare const timeSchemaSql: string;
export declare function createTimeDomains(database: Database): TimeDomains;
/** @themelios/core/time：同域比较，结果为 -1、0 或 1。 */
export declare function compareTime(a: TimePoint, b: TimePoint): -1 | 0 | 1;
