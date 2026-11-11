import {
  QUERY,
  type ResolvedRange,
  type TrendResult,
  type TrendSeries,
  type TrendSpec,
} from "@cfanalytics/shared";
import { dimensionSql } from "./filters.ts";
import type { Bucket } from "./range.ts";
import { compareKeys, fragment, joined, VISITOR } from "./sql.ts";
import type { CompiledQuery, Fold, Folder, SqlValue, Statement, StoreRows } from "./types.ts";

// Trends: events, visitors or sessions per bucket, with an optional
// breakdown and an optional previous period (query-15, query-16, query-20,
// query-41 to query-46, query-72). Pure.

/** A period and its buckets. */
export interface Period {
  range: ResolvedRange;
  buckets: Bucket[];
}

/** What compiling a trend needs besides the spec: the period, and the previous one when `compare`. */
export interface TrendFrame {
  current: Period;
  previous: Period | null;
}

/**
 * One statement for a trend (D-26): the current period's buckets, then the
 * previous period's when `compare`, in one bucket table, joined to events in
 * them that match `scope` (the exclusions and the spec's filter, compile.ts),
 * spec.event when given, and the breakdown's own condition. Events are read
 * once, through the index eventsOf names. Its rows, per bucket number and
 * key (the breakdown's value, dimensionSql, or null without one):
 * - events: their count;
 * - visitors: one row per visitor, the person else the distinct id
 *   (query-72, D-25), each counted once per bucket;
 * - sessions: their count, each session_id once per period, in the bucket of
 *   its first event in the period, events with no session counting for none
 *   (query-42).
 * The buckets are bound as one JSON array of [start, end] pairs, so the SQL
 * text does not grow with their number; an event falls in the bucket with
 * start <= ts < end, and a bucket number in SQL is compared as
 * CAST(? AS INTEGER) (query-15, query-20, spike S1 finding 5).
 * The store folds the rows with trendFolder: totals per key, ranking, the
 * kept keys and "Other".
 */
export function compileTrend(spec: TrendSpec, frame: TrendFrame, scope: Statement): CompiledQuery {
  const breakdown = breakdownOf(spec);
  const current = frame.current.buckets.length;
  const buckets = [...frame.current.buckets, ...(frame.previous?.buckets ?? [])];
  const key = breakdown?.value ?? fragment("NULL");
  const at = conditions(spec, null, scope, breakdown);
  const from = fragment(
    `FROM buckets b CROSS JOIN ${eventsOf(spec)} WHERE e.ts >= b.start AND e.ts < b.end AND `,
  );

  let body: Statement;
  if (spec.measure === "sessions") {
    body = joined(
      [
        fragment("SELECT f.number, f.key, COUNT(*), NULL FROM (SELECT b.number AS number, "),
        key,
        fragment(
          ` AS key, ROW_NUMBER() OVER (PARTITION BY (b.number >= CAST(? AS INTEGER)), e.session_id ORDER BY e.ts, e.id) AS stored `,
          current,
        ),
        from,
        fragment("e.session_id IS NOT NULL AND "),
        at,
        fragment(") AS f WHERE f.stored = 1 GROUP BY 1, 2"),
      ],
      "",
    );
  } else if (spec.measure === "visitors") {
    body = joined(
      [fragment("SELECT DISTINCT b.number, "), key, fragment(`, 1, ${VISITOR} `), from, at],
      "",
    );
  } else {
    body = joined(
      [
        fragment("SELECT b.number, "),
        key,
        fragment(", COUNT(*), NULL "),
        from,
        at,
        fragment(" GROUP BY 1, 2"),
      ],
      "",
    );
  }

  return {
    statements: [
      joined([fragment("WITH RECURSIVE"), joined(bucketCtes(buckets), ", "), body], " "),
    ],
    fold: {
      kind: "trend",
      measure: spec.measure,
      current,
      previous: frame.previous?.buckets.length ?? null,
      limit: breakdown === null ? 1 : (spec.breakdownLimit ?? QUERY.breakdownLimit.default),
      breakdown: breakdown !== null,
    },
  };
}

/**
 * The trend from compileTrend's rows: `buckets` the current period's labels;
 * one series per key, with a value for every bucket in order, 0 where no
 * event fell (query-16), and its total; the "Other" series last with
 * `other: true`; series in the rank compileTrend used. With `compare`,
 * `previous` holds the previous period's labels and series by the same keys,
 * and each current series has `change` from relativeChange (query-43).
 */
export function answerTrend(spec: TrendSpec, frame: TrendFrame, rows: StoreRows): TrendResult {
  const current = seriesOf(frame.current, rows.results[0], rows.results[1]);
  if (frame.previous === null) return { buckets: labelsOf(frame.current), series: current };
  const previous = alignedTo(current, frame.previous, rows.results[2], rows.results[3]);
  return {
    buckets: labelsOf(frame.current),
    series: current.map((entry, position) => ({
      ...entry,
      change: relativeChange(previous[position]?.total ?? 0, entry.total),
    })),
    previous: { buckets: labelsOf(frame.previous), series: previous },
  };
}

/** (current - previous) / previous; 0 when both are 0, and null when only previous is 0 (query-43). */
export function relativeChange(previous: number, current: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / previous;
}

/**
 * The events table under the index a trend's read must use (D-26): every
 * statement here bounds e.ts, so events_ts, or events_event_ts when the trend
 * counts one event. Named, because with the default exclusions SQLite would
 * otherwise build an automatic index on bot for each bucket and read every
 * event once per bucket, and Durable Objects refuse the pragma that turns
 * automatic indexes off.
 */
const eventsOf = (spec: TrendSpec): string =>
  spec.event === undefined
    ? "events e INDEXED BY events_ts"
    : "events e INDEXED BY events_event_ts";

/** A series key as text, keeping a number and the text of the same digits apart. */
const keyText = (key: string | number | boolean | null): string => `${typeof key}:${String(key)}`;

/** One value per bucket, 0 until its rows fill them (query-16). */
const zeros = (count: number): number[] => Array.from({ length: count }, () => 0);

/** The buckets' labels in order (query-16). */
const labelsOf = (period: Period): string[] => period.buckets.map((bucket) => bucket.label);

/** The breakdown's value and its own event condition, from dimensionSql; null without a breakdown. */
interface Breakdown {
  value: Statement;
  where: Statement;
}

function breakdownOf(spec: TrendSpec): Breakdown | null {
  if (spec.breakdown === undefined) return null;
  const dimension = dimensionSql(spec.breakdown);
  return { value: dimension.value, where: dimension.where };
}

/**
 * Where an event counts: in `range` when given (the buckets carry the period
 * in the per-bucket statements), in `scope`, and for the breakdown's value
 * when that names one browser (dimensionSql, query-68).
 */
function conditions(
  spec: TrendSpec,
  range: ResolvedRange | null,
  scope: Statement,
  breakdown: Breakdown | null,
): Statement {
  const parts: Statement[] = [];
  if (range !== null) parts.push(fragment("e.ts >= ? AND e.ts < ?", range.from, range.to));
  parts.push(fragment(`(${scope.sql})`, ...scope.params));
  if (spec.event !== undefined) parts.push(fragment("e.event = ?", spec.event));
  if (breakdown !== null)
    parts.push(fragment(`(${breakdown.where.sql})`, ...breakdown.where.params));
  return joined(parts, " AND ");
}

/**
 * The buckets as a table: `numbers` counts them from a bound count, and each
 * row's bounds come from the bound JSON array by its index. Bound numbers
 * arrive as REAL, so the count is CAST to an integer (spike S1 finding 5,
 * query-20).
 */
function bucketCtes(buckets: readonly Bucket[]): Statement[] {
  const bounds = JSON.stringify(buckets.map((bucket) => [bucket.start, bucket.end]));
  return [
    fragment(
      `numbers(number) AS (
         SELECT 0 WHERE CAST(? AS INTEGER) > 0
         UNION ALL
         SELECT number + 1 FROM numbers WHERE number + 1 < CAST(? AS INTEGER)
       )`,
      buckets.length,
      buckets.length,
    ),
    fragment(
      `buckets(number, start, end) AS MATERIALIZED (
         SELECT number,
                json_extract(?, '$[' || number || '][0]'),
                json_extract(?, '$[' || number || '][1]')
         FROM numbers
       )`,
      bounds,
      bounds,
    ),
  ];
}

/** One key's counts in one period. */
interface Tally {
  key: SqlValue;
  values: number[];
  total: number;
  visitors: Set<SqlValue> | null;
}

/**
 * The trend's fold (D-26), over compileTrend's rows [bucket number, key,
 * value, visitor]. Per period and key, the value per bucket and the total:
 * the bucket values' sum for events and sessions, and for visitors the
 * distinct visitors over the whole period, so the buckets need not sum to the
 * total (query-41). With a breakdown, the keys of both periods are merged
 * (query-44) and ranked by their current total, or with `compare` by the
 * absolute change of their totals, ties by key; the top `limit` are kept and
 * the rest summed into one "Other" key, last (query-45). Without one there is
 * one key, null, present even with no event. Answers, per period, the bucket
 * rows [bucket, key, value] and the total rows [key, total, other] in rank
 * order, as answerTrend reads them.
 */
export function trendFolder(fold: Extract<Fold, { kind: "trend" }>): Folder {
  const sizes = fold.previous === null ? [fold.current] : [fold.current, fold.previous];
  const tallies = sizes.map(() => new Map<string, Tally>());
  const tallyOf = (period: number, key: SqlValue): Tally => {
    const map = tallies[period] ?? new Map<string, Tally>();
    const text = keyText(key);
    let tally = map.get(text);
    if (tally === undefined) {
      tally = {
        key,
        values: zeros(sizes[period] ?? 0),
        total: 0,
        visitors: fold.measure === "visitors" ? new Set() : null,
      };
      map.set(text, tally);
    }
    return tally;
  };
  const totalOf = (period: number, text: string): number => tallies[period]?.get(text)?.total ?? 0;
  return {
    add(row) {
      const [number, key, value, visitor] = row;
      if (typeof number !== "number" || typeof value !== "number" || key === undefined) return;
      const period = number < fold.current ? 0 : 1;
      const tally = tallyOf(period, key);
      const bucket = period === 0 ? number : number - fold.current;
      tally.values[bucket] = (tally.values[bucket] ?? 0) + value;
      if (tally.visitors === null) tally.total += value;
      else tally.visitors.add(visitor ?? null);
    },
    finish() {
      for (const map of tallies) {
        for (const tally of map.values()) {
          if (tally.visitors !== null) tally.total = tally.visitors.size;
        }
      }

      let kept: { text: string; key: SqlValue }[];
      let dropped: string[] = [];
      if (!fold.breakdown) {
        kept = [{ text: keyText(null), key: null }];
      } else {
        const keys = new Map<string, SqlValue>();
        for (const map of tallies) for (const [text, tally] of map) keys.set(text, tally.key);
        const metric = (text: string): number =>
          fold.previous === null ? totalOf(0, text) : Math.abs(totalOf(0, text) - totalOf(1, text));
        const ranked = [...keys.entries()]
          .map(([text, key]) => ({ text, key }))
          .toSorted(
            (left, right) =>
              metric(right.text) - metric(left.text) || compareKeys(left.key, right.key),
          );
        kept = ranked.slice(0, fold.limit);
        dropped = ranked.slice(fold.limit).map((entry) => entry.text);
      }

      const results: SqlValue[][][] = [];
      for (const [period, size] of sizes.entries()) {
        const bucketRows: SqlValue[][] = [];
        const totalRows: SqlValue[][] = [];
        for (const { text, key } of kept) {
          const tally = tallies[period]?.get(text);
          totalRows.push([key, tally?.total ?? 0, 0]);
          for (const [bucket, value] of (tally?.values ?? []).entries()) {
            if (value !== 0) bucketRows.push([bucket, key, value]);
          }
        }
        if (dropped.length > 0) {
          const other = zeros(size);
          let total = 0;
          for (const text of dropped) {
            const tally = tallies[period]?.get(text);
            if (tally === undefined) continue;
            total += tally.total;
            for (const [bucket, value] of tally.values.entries())
              other[bucket] = (other[bucket] ?? 0) + value;
          }
          totalRows.push(["Other", total, 1]);
          for (const [bucket, value] of other.entries()) {
            if (value !== 0) bucketRows.push([bucket, "Other", value]);
          }
        }
        results.push(bucketRows, totalRows);
      }
      return results;
    },
  };
}

/**
 * The series from one period's rows: each totals row is a series, in the
 * order the statement ranked it, with a value per bucket (query-16).
 */
function seriesOf(
  period: Period,
  bucketRows: SqlValue[][] | undefined,
  totalRows: SqlValue[][] | undefined,
): TrendSeries[] {
  const series: TrendSeries[] = [];
  const at = new Map<string, number>();
  for (const row of totalRows ?? []) {
    const [key, total, other] = row;
    if (key === undefined || typeof total !== "number") continue;
    at.set(keyText(key), series.length);
    series.push({ key, other: other === 1, values: zeros(period.buckets.length), total });
  }
  for (const row of bucketRows ?? []) {
    const [bucket, key, value] = row;
    if (typeof bucket !== "number" || key === undefined || typeof value !== "number") continue;
    const position = at.get(keyText(key));
    const entry = position === undefined ? undefined : series[position];
    if (entry === undefined || bucket < 0 || bucket >= entry.values.length) continue;
    entry.values[bucket] = value;
  }
  return series;
}

/** The previous period's series by the current period's keys, a key with no row there being all zeros (query-44). */
function alignedTo(
  current: readonly TrendSeries[],
  period: Period,
  bucketRows: SqlValue[][] | undefined,
  totalRows: SqlValue[][] | undefined,
): TrendSeries[] {
  const own = new Map(
    seriesOf(period, bucketRows, totalRows).map((entry) => [keyText(entry.key), entry]),
  );
  return current.map(
    (entry) =>
      own.get(keyText(entry.key)) ?? {
        key: entry.key,
        other: entry.other,
        values: zeros(period.buckets.length),
        total: 0,
      },
  );
}
