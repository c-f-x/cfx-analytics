import { DAY_MS } from "./limits.ts";
import type { Range } from "./query.ts";

// The time window of every dashboard answer, the query kinds' and the
// heatmap's (D-20; query-10, query-11, query-37, query-40). Its one home is
// here, so the query and heatmaps slices read the same rules. Pure: the clock
// is an argument, and the answer is the same whatever the process time zone
// (platform-36).

/** Why a range cannot be resolved (query-11). */
export type RangeProblem = "start not before end" | "negative start";

/** A resolved range, or why there is none. The Worker's Result has the same shape. */
export type RangeResult = { ok: true; value: ResolvedRange } | { ok: false; error: RangeProblem };

/** A resolved, half-open range in ms. */
export interface ResolvedRange {
  from: number;
  to: number;
  timeZone: string;
  /** The range asked for, when it was clipped to the retention horizon (query-40). */
  requested: { from: number; to: number } | null;
}

/** A local wall-clock reading. Months and days count from 1. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall clock of `ts` in `timeZone`, to the second. The query slice's buckets read it too. */
export function wallClockAt(ts: number, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ts));
  const partOf = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: partOf("year"),
    month: partOf("month"),
    day: partOf("day"),
    hour: partOf("hour"),
    minute: partOf("minute"),
    second: partOf("second"),
  };
}

/** The wall clock read as if it were UTC ms, so the parts can be compared and shifted. */
export function asUtcMs(wall: WallClock): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

/** How far `timeZone`'s clock runs ahead of UTC at `ts`, read to the second. */
export function offsetAt(ts: number, timeZone: string): number {
  return asUtcMs(wallClockAt(ts, timeZone)) - Math.floor(ts / 1000) * 1000;
}

/**
 * The instant whose local clock reads 00:00 on the given date. Where a
 * daylight-saving change skips midnight, it is the first instant of that day.
 * The date may overflow, as Date.UTC allows: day 32 of January is 1 February.
 */
export function localMidnight(year: number, month: number, day: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day);
  const firstOffset = offsetAt(wall, timeZone);
  const guess = wall - firstOffset;
  const secondOffset = offsetAt(guess, timeZone);
  return firstOffset === secondOffset ? guess : wall - secondOffset;
}

/** The instant `daysBack` local calendar days before the one `ts` falls in begins. */
function startOfLocalDay(ts: number, timeZone: string, daysBack: number): number {
  const today = wallClockAt(ts, timeZone);
  const shifted = new Date(Date.UTC(today.year, today.month - 1, today.day) - daysBack * DAY_MS);
  return localMidnight(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    timeZone,
  );
}

/** The unclipped range the ask names. */
function askedRange(range: Range, timeZone: string, now: number): { from: number; to: number } {
  if (range.kind === "between") {
    return { from: Date.parse(range.from), to: Date.parse(range.to) };
  }
  if (range.kind === "last_24_hours") return { from: now - DAY_MS, to: now };
  if (range.kind === "last_days") {
    return { from: startOfLocalDay(now, timeZone, range.days - 1), to: now };
  }
  if (range.kind === "yesterday") {
    return { from: startOfLocalDay(now, timeZone, 1), to: startOfLocalDay(now, timeZone, 0) };
  }
  return { from: startOfLocalDay(now, timeZone, 0), to: now };
}

/**
 * Resolves `range` in `timeZone`, a valid IANA name, at `now`, every range
 * half-open [from, to):
 * - "today": from local midnight to now; "yesterday": the local day before,
 *   midnight to midnight (query-10);
 * - "last_24_hours": now - 24 h to now;
 * - "last_days" N: from local midnight N - 1 days before today to now, so N
 *   calendar days including today (query-10, D-20);
 * - "between": its ISO instants as UTC ms (query-11).
 * Local days follow the zone's calendar, so a daylight-saving day is 23 or
 * 25 hours. A start not before its end is "start not before end", and a
 * negative start "negative start" (query-11). A start before
 * `retentionStart` becomes retentionStart, with `requested` holding the
 * range asked for (query-40); else `requested` is null. When the whole range
 * ends before retentionStart, the clipped range is empty, from = to =
 * retentionStart.
 */
export function resolveRange(
  range: Range,
  timeZone: string,
  now: number,
  retentionStart: number,
): RangeResult {
  const asked = askedRange(range, timeZone, now);
  if (asked.from < 0) return { ok: false, error: "negative start" };
  if (asked.from >= asked.to) return { ok: false, error: "start not before end" };

  return {
    ok: true,
    value: {
      from: Math.max(asked.from, retentionStart),
      to: Math.max(asked.to, retentionStart),
      timeZone,
      requested: asked.from < retentionStart ? asked : null,
    },
  };
}
