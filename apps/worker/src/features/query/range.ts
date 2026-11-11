import {
  asUtcMs,
  DAY_MS,
  type Granularity,
  localMidnight,
  offsetAt,
  QUERY,
  type ResolvedRange,
  type WallClock,
  wallClockAt,
} from "@cfanalytics/shared";
import { err, ok, type Result } from "../../platform/result.ts";

// Buckets and the previous period of a resolved range (D-20; query-05,
// query-15, query-16, query-33 to query-35, query-38, query-39). Resolving the
// range itself is resolveRange in packages/shared, the one home every
// dashboard answer reads; the calendar maths behind both is there too
// (wallClockAt, localMidnight). Pure: the answer is the same whatever the
// process time zone (platform-36).

/** One bucket: [start, end) in UTC ms, and its local label. */
export interface Bucket {
  start: number;
  end: number;
  label: string;
}

/** A calendar boundary: where a unit starts, and the local label of that start. */
interface Boundary {
  start: number;
  label: string;
}

/**
 * Boundaries built before the count is known to be over the limit. One more
 * than the limit proves the failure, and one extra closes the last bucket.
 */
const BUILD_LIMIT = QUERY.maxBuckets + 2;

/**
 * The instants whose local clock reads `wall` in `timeZone`: none for a
 * reading the clock skips, two for one it repeats (query-05's 23 and 25 hour
 * days, and query-33's repeated autumn hour). The offset a day either side of
 * the reading finds both halves of a repeated hour.
 */
function instantsAt(wall: number, timeZone: string): number[] {
  const offsets = [
    offsetAt(wall - DAY_MS, timeZone),
    offsetAt(wall, timeZone),
    offsetAt(wall + DAY_MS, timeZone),
  ];
  const instants = new Set<number>();
  for (const offset of offsets) {
    const candidate = wall - offset;
    if (asUtcMs(wallClockAt(candidate, timeZone)) === wall) instants.add(candidate);
  }
  return [...instants].toSorted((left, right) => left - right);
}

/**
 * The instant a local wall-clock reading names. For a reading the clock skips,
 * the reading is taken with the offset in force, which lands after the skip.
 */
function instantAt(wall: number, timeZone: string): number {
  const [first] = instantsAt(wall, timeZone);
  return first ?? wall - offsetAt(wall, timeZone);
}

const pad = (value: number, width: number): string => String(value).padStart(width, "0");

const dateLabel = (year: number, month: number, day: number): string =>
  `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;

/** The label of an hour boundary: its local start with its offset (query-05, query-33). */
function hourLabel(start: number, timeZone: string): string {
  const wall = wallClockAt(start, timeZone);
  const offsetMinutes = Math.round(offsetAt(start, timeZone) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const clock = `${pad(wall.hour, 2)}:${pad(wall.minute, 2)}`;
  return `${dateLabel(wall.year, wall.month, wall.day)}T${clock}${sign}${pad(Math.floor(absolute / 60), 2)}:${pad(absolute % 60, 2)}`;
}

/** The day boundaries from the day holding `from`, each at local midnight (query-05). */
function dayBoundaries(range: ResolvedRange): Boundary[] {
  const first = wallClockAt(range.from, range.timeZone);
  const cursor = new Date(Date.UTC(first.year, first.month - 1, first.day));
  const boundaries: Boundary[] = [];
  while (boundaries.length < BUILD_LIMIT) {
    const wall = {
      year: cursor.getUTCFullYear(),
      month: cursor.getUTCMonth() + 1,
      day: cursor.getUTCDate(),
    };
    const start = localMidnight(wall.year, wall.month, wall.day, range.timeZone);
    boundaries.push({ start, label: dateLabel(wall.year, wall.month, wall.day) });
    if (start >= range.to) break;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return boundaries;
}

/** The week boundaries from the week holding `from`, each on Monday local midnight (query-34). */
function weekBoundaries(range: ResolvedRange): Boundary[] {
  const first = wallClockAt(range.from, range.timeZone);
  const cursor = new Date(Date.UTC(first.year, first.month - 1, first.day));
  cursor.setUTCDate(cursor.getUTCDate() - ((cursor.getUTCDay() + 6) % 7));
  const boundaries: Boundary[] = [];
  while (boundaries.length < BUILD_LIMIT) {
    const wall = {
      year: cursor.getUTCFullYear(),
      month: cursor.getUTCMonth() + 1,
      day: cursor.getUTCDate(),
    };
    const start = localMidnight(wall.year, wall.month, wall.day, range.timeZone);
    boundaries.push({ start, label: dateLabel(wall.year, wall.month, wall.day) });
    if (start >= range.to) break;
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return boundaries;
}

/** The month boundaries from the month holding `from`, each on the first at local midnight (query-35). */
function monthBoundaries(range: ResolvedRange): Boundary[] {
  const first = wallClockAt(range.from, range.timeZone);
  const cursor = new Date(Date.UTC(first.year, first.month - 1, 1));
  const boundaries: Boundary[] = [];
  while (boundaries.length < BUILD_LIMIT) {
    const wall = {
      year: cursor.getUTCFullYear(),
      month: cursor.getUTCMonth() + 1,
      day: cursor.getUTCDate(),
    };
    const start = localMidnight(wall.year, wall.month, wall.day, range.timeZone);
    boundaries.push({
      start,
      label: `${pad(wall.year, 4)}-${pad(wall.month, 2)}`,
    });
    if (start >= range.to) break;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return boundaries;
}

/**
 * The hour boundaries from the hour holding `from`, each at a local clock hour
 * (query-33). A skipped hour has none, and a repeated one has both.
 */
function hourBoundaries(range: ResolvedRange): Boundary[] {
  const first = wallClockAt(range.from, range.timeZone);
  const cursor = new Date(Date.UTC(first.year, first.month - 1, first.day));
  const boundaries: Boundary[] = [];
  let holding: Boundary | null = null;
  while (boundaries.length < BUILD_LIMIT) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const day = cursor.getUTCDate();
    let reached = false;
    for (let hour = 0; hour < 24 && !reached && boundaries.length < BUILD_LIMIT; hour += 1) {
      for (const start of instantsAt(Date.UTC(year, month - 1, day, hour), range.timeZone)) {
        const boundary = { start, label: hourLabel(start, range.timeZone) };
        if (start <= range.from) {
          holding = boundary;
          continue;
        }
        if (holding !== null) {
          boundaries.push(holding);
          holding = null;
        }
        boundaries.push(boundary);
        reached = start >= range.to;
        if (reached) break;
      }
    }
    if (reached) break;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return boundaries;
}

/** The calendar boundaries of `granularity` from the unit holding the range's start. */
function boundariesOf(range: ResolvedRange, granularity: Granularity): Boundary[] {
  if (granularity === "hour") return hourBoundaries(range);
  if (granularity === "day") return dayBoundaries(range);
  if (granularity === "week") return weekBoundaries(range);
  return monthBoundaries(range);
}

/** The buckets between consecutive boundaries, each cut to the range (query-05, query-33). */
function bucketsFrom(
  boundaries: readonly Boundary[],
  range: ResolvedRange,
): Result<Bucket[], "too many buckets"> {
  const buckets: Bucket[] = [];
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const start = boundaries[index];
    const next = boundaries[index + 1];
    if (start === undefined || next === undefined) break;
    if (start.start >= range.to) break;
    buckets.push({
      start: Math.max(start.start, range.from),
      end: Math.min(next.start, range.to),
      label: start.label,
    });
    if (buckets.length > QUERY.maxBuckets) return err("too many buckets");
  }
  return ok(buckets);
}

/**
 * The buckets that cover the range [from, to) in order, on local calendar
 * boundaries in range.timeZone (query-05, query-33 to query-35):
 * - hour: each local clock hour, so the spring day has 23 and the autumn day
 *   25; label the local start as "YYYY-MM-DDTHH:MM+HH:MM", with its offset,
 *   so the repeated autumn hour has two labels;
 * - day: each local calendar day, 23 or 25 hours on a daylight-saving day;
 *   label "YYYY-MM-DD";
 * - week: Monday 00:00 to the next Monday 00:00, local; label the Monday's
 *   "YYYY-MM-DD";
 * - month: the first of the month 00:00 to the next first, local; label
 *   "YYYY-MM".
 * The first and last buckets are cut to the range, so the buckets together
 * are exactly [from, to) and an instant falls in exactly one (query-15,
 * query-33); a cut bucket keeps its calendar label. An empty range (from =
 * to) has no bucket. More than QUERY.maxBuckets buckets is "too many buckets";
 * exactly QUERY.maxBuckets is accepted (query-39).
 */
export function bucketsOf(
  range: ResolvedRange,
  granularity: Granularity,
): Result<Bucket[], "too many buckets"> {
  if (range.from >= range.to) return ok([]);
  return bucketsFrom(boundariesOf(range, granularity), range);
}

/** The number of whole local calendar days between two readings, both ends counted. */
const daysBetween = (from: WallClock, to: WallClock): number =>
  (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) /
    DAY_MS +
  1;

/**
 * The period to compare a range with (query-38): the same local wall-clock
 * times moved back by N calendar days, where N is the number of local
 * calendar days the range touches, from the day of `from` to the day of the
 * last instant before `to`. So "today" until 10:00 compares with yesterday
 * until 10:00, and "last 7 days" with the 7 days before them. Its time zone
 * is the range's. A start before `retentionStart` is clipped to it with
 * `requested` set, as resolveRange does (query-40); else `requested` is null.
 */
export function previousPeriod(range: ResolvedRange, retentionStart: number): ResolvedRange {
  const timeZone = range.timeZone;
  const fromWall = wallClockAt(range.from, timeZone);
  const lastInstant = range.to > range.from ? range.to - 1 : range.from;
  const days = daysBetween(fromWall, wallClockAt(lastInstant, timeZone));

  // The millisecond within the second carries over: wallClockAt reads whole seconds.
  const shift = (ts: number): number => {
    const wall = wallClockAt(ts, timeZone);
    const earlier = asUtcMs(wall) - days * DAY_MS;
    return instantAt(earlier, timeZone) + (((ts % 1000) + 1000) % 1000);
  };

  const from = shift(range.from);
  const to = shift(range.to);
  return {
    from: Math.max(from, retentionStart),
    to: Math.max(to, retentionStart),
    timeZone,
    requested: from < retentionStart ? { from, to } : null,
  };
}
