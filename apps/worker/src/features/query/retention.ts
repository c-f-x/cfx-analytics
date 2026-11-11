import type { RetentionResult, RetentionSpec } from "@cfanalytics/shared";
import { fragment, joined, VISITOR } from "./sql.ts";
import type { Period } from "./trend.ts";
import type { CompiledQuery, Fold, Folder, SqlValue, Statement, StoreRows } from "./types.ts";

// Retention cohorts (D-20; query-62, query-63). SQL reads each visitor's
// counted events in order, and the store folds them into cohort sizes and
// returns (D-26). Pure.

/** 1 when the event is the named one, or any event when the spec names none; else 0. */
const isEvent = (name: string | undefined): Statement =>
  name === undefined ? fragment("1") : fragment("(e.event = ?)", name);

/**
 * One statement over every counted event before the range's end, those that
 * match `scope`, so bots and internal traffic are left out of both the start
 * and the return event (query-63): per event its visitor, the person else
 * the distinct id (D-25), its ts, and whether it is a start event
 * (spec.startEvent, any event when absent) and a return event
 * (spec.returnEvent, likewise). Events before the range are read too, since
 * a visitor's cohort is the bucket of their first counted start event ever
 * (query-62). Rows ordered by visitor, then ts, which retentionFolder needs.
 * The fold carries the period's buckets.
 */
export function compileRetention(
  spec: RetentionSpec,
  period: Period,
  scope: Statement,
): CompiledQuery {
  const start = isEvent(spec.startEvent);
  const returns = isEvent(spec.returnEvent);
  const named =
    spec.startEvent !== undefined && spec.returnEvent !== undefined
      ? [fragment(" AND e.event IN (?, ?)", spec.startEvent, spec.returnEvent)]
      : [];
  const statement = joined(
    [
      fragment(`SELECT ${VISITOR} AS visitor, e.ts, `),
      start,
      fragment(" AS start, "),
      returns,
      fragment(" AS return\n  FROM events e\n WHERE e.ts < ?", period.range.to),
      fragment(` AND (${scope.sql})`, ...scope.params),
      ...named,
      fragment(" ORDER BY 1, e.ts"),
    ],
    "",
  );
  return {
    statements: [statement],
    fold: {
      kind: "retention",
      buckets: period.buckets.map((bucket) => [bucket.start, bucket.end] as const),
    },
  };
}

/** The index of the bucket holding `ts`, or -1 outside them. Buckets are in order and touch. */
function bucketOf(buckets: readonly (readonly [number, number])[], ts: number): number {
  let low = 0;
  let high = buckets.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const bucket = buckets[middle];
    if (bucket === undefined) return -1;
    if (ts < bucket[0]) high = middle - 1;
    else if (ts >= bucket[1]) low = middle + 1;
    else return middle;
  }
  return -1;
}

/**
 * Retention's fold (D-26). Per visitor, the cohort is the bucket of their
 * first start event, or none when it falls outside the buckets; the visitor
 * is in period n of it when a return event falls in the n-th bucket after
 * the cohort's, n from 0. Answers [cohort, size] and [cohort, period,
 * visitors], each in ascending order.
 */
export function retentionFolder(fold: Extract<Fold, { kind: "retention" }>): Folder {
  const sizes = new Map<number, number>();
  const returned = new Map<string, number>();
  let visitor: SqlValue | undefined;
  let seen = false;
  let cohort = -1;
  let periods = new Set<number>();
  const close = (): void => {
    if (cohort >= 0) {
      sizes.set(cohort, (sizes.get(cohort) ?? 0) + 1);
      for (const period of periods) {
        const key = `${cohort}:${period}`;
        returned.set(key, (returned.get(key) ?? 0) + 1);
      }
    }
    seen = false;
    cohort = -1;
    periods = new Set();
  };
  return {
    add(row) {
      const [key, ts, start, back] = row;
      if (typeof ts !== "number") return;
      if (key !== visitor) {
        if (visitor !== undefined) close();
        visitor = key;
      }
      if (!seen && start === 1) {
        seen = true;
        cohort = bucketOf(fold.buckets, ts);
        return;
      }
      if (cohort < 0 || back !== 1) return;
      const bucket = bucketOf(fold.buckets, ts);
      if (bucket > cohort) periods.add(bucket - cohort - 1);
    },
    finish() {
      if (visitor !== undefined) close();
      const sizeRows: SqlValue[][] = [...sizes.entries()]
        .toSorted(([left], [right]) => left - right)
        .map(([at, size]) => [at, size]);
      const returnRows: SqlValue[][] = [...returned.entries()]
        .map(([key, visitors]) => {
          const [at, period] = key.split(":").map(Number);
          return [at ?? 0, period ?? 0, visitors];
        })
        .toSorted(
          (left, right) => Number(left[0]) - Number(right[0]) || Number(left[1]) - Number(right[1]),
        );
      return [sizeRows, returnRows];
    },
  };
}

/**
 * One cohort per bucket of the period that has a possible return period
 * after it, the trailing bucket with none left out (query-63); each with its
 * bucket's label as `start`, its size, and every period from 0 to the last
 * the range allows, with zero people and a rate of 0 where none returned; a
 * rate is people over cohort size, null for an empty cohort, since a ratio
 * with a zero denominator is null (query-62, D-20).
 */
export function answerRetention(
  spec: RetentionSpec,
  period: Period,
  rows: StoreRows,
): RetentionResult {
  const sizes = new Map<number, number>();
  for (const row of rows.results[0] ?? []) {
    const [cohort, size] = row;
    if (typeof cohort === "number" && typeof size === "number") sizes.set(cohort, size);
  }

  const returns = new Map<string, number>();
  for (const row of rows.results[1] ?? []) {
    const [cohort, index, people] = row;
    if (typeof cohort === "number" && typeof index === "number" && typeof people === "number") {
      returns.set(`${cohort}:${index}`, people);
    }
  }

  const result: RetentionResult["cohorts"] = [];
  for (let index = 0; index + 1 < period.buckets.length; index += 1) {
    const bucket = period.buckets[index];
    if (bucket === undefined) continue;
    const size = sizes.get(index) ?? 0;
    const periods: RetentionResult["cohorts"][number]["periods"] = [];
    for (let n = 0; index + 1 + n < period.buckets.length; n += 1) {
      const people = returns.get(`${index}:${n}`) ?? 0;
      periods.push({ people, rate: size === 0 ? null : people / size });
    }
    result.push({ start: bucket.label, size, periods });
  }

  return { cohorts: result };
}
