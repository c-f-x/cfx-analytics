import { type FunnelResult, type FunnelSpec, QUERY, type ResolvedRange } from "@cfanalytics/shared";
import { dimensionSql, filterSql } from "./filters.ts";
import { compareKeys, fragment, joined, placeholders, VISITOR } from "./sql.ts";
import type { CompiledQuery, Fold, Folder, SqlValue, Statement, StoreRows } from "./types.ts";

// Ordered funnels (D-20; query-03, query-04, query-21 to query-32), ported in
// idea from InsightFlare's funnel planner (docs/donors.md) onto our events
// table. SQL reads each visitor's matching events in order, and the store
// folds them into one row per step (D-26). Pure.

/** One step's own events: its name and every condition of its `where` (query-27). */
function stepMatch(step: FunnelSpec["steps"][number]): Statement {
  const parts = [fragment("e.event = ?", step.event)];
  for (const condition of step.where ?? []) parts.push(filterSql(condition));
  return joined(parts, " AND ");
}

/**
 * One statement in one call (query-32), over events in [range.from,
 * range.to) that match `scope` and the name of some step: per event its
 * visitor, the person else the distinct id (query-30, D-25), its ts and id,
 * and a mask with bit k set when it matches step k, its name and every
 * condition of its `where` (filterSql, query-27). Rows ordered by visitor,
 * then ts, then id, which funnelFolder needs. The fold is the funnel's.
 */
export function compileFunnel(
  spec: FunnelSpec,
  range: ResolvedRange,
  scope: Statement,
): CompiledQuery {
  const names = [...new Set(spec.steps.map((step) => step.event))];
  const mask = joined(
    spec.steps.map((step, index) => {
      const match = stepMatch(step);
      return fragment(`(CASE WHEN ${match.sql} THEN ${2 ** index} ELSE 0 END)`, ...match.params);
    }),
    " + ",
  );
  // With a breakdown, each event's value of the dimension: the group of the
  // visitor's first entry is read from it (query-128).
  const dimension = spec.breakdown === undefined ? null : dimensionSql(spec.breakdown);
  const key =
    dimension === null
      ? fragment("NULL")
      : joined(
          [
            fragment("CASE WHEN "),
            dimension.where,
            fragment(" THEN "),
            dimension.value,
            fragment(" END"),
          ],
          "",
        );
  const statement = joined(
    [
      fragment(`SELECT ${VISITOR} AS visitor, e.ts, e.id, `),
      mask,
      fragment(" AS mask, "),
      key,
      fragment(
        ` AS key
  FROM events e
 WHERE e.event IN (${placeholders(names.length)})`,
        ...names,
      ),
      fragment(" AND e.ts >= ? AND e.ts < ?", range.from, range.to),
      fragment(` AND (${scope.sql})`, ...scope.params),
      fragment(" ORDER BY 1, e.ts, e.id"),
    ],
    "",
  );
  return {
    statements: [statement],
    fold: {
      kind: "funnel",
      steps: spec.steps.length,
      windowMs: spec.windowMs,
      breakdownLimit:
        spec.breakdown === undefined ? null : (spec.breakdownLimit ?? QUERY.breakdownLimit.default),
    },
  };
}

/**
 * The furthest step one visitor reaches, or -1 with no entry: for each entry
 * (an event matching step 0), each later step takes the earliest matching
 * event after the previous step's event, so an unused earlier event never
 * blocks a later one (query-22). "After" is the rows' order, ts then id, so
 * of two events at the same time the earlier stored comes first (query-23),
 * and one event never fills two steps (query-21). Every step falls within
 * windowMs of the entry, the end inclusive (query-04), the window running
 * across the whole funnel (query-24). A visitor reaches step k when any of
 * their entries reaches it (D-20).
 */
export function furthestStep(
  events: readonly { ts: number; mask: number }[],
  steps: number,
  windowMs: number,
): number {
  const count = events.length;
  // next[k][i]: the first event at or after i matching step k, else count.
  const next: Int32Array[] = [];
  for (let step = 0; step < steps; step += 1) {
    const column = new Int32Array(count + 1).fill(count);
    const bit = 2 ** step;
    for (let index = count - 1; index >= 0; index -= 1) {
      const event = events[index];
      column[index] =
        event !== undefined && (event.mask & bit) !== 0 ? index : (column[index + 1] ?? count);
    }
    next.push(column);
  }

  let furthest = -1;
  for (const [index, entry] of events.entries()) {
    if ((entry.mask & 1) === 0) continue;
    const deadline = entry.ts + windowMs;
    let at = index;
    let reached = 0;
    for (let step = 1; step < steps; step += 1) {
      const found = next[step]?.[at + 1] ?? count;
      const event = events[found];
      if (event === undefined || event.ts > deadline) break;
      at = found;
      reached = step;
    }
    furthest = Math.max(furthest, reached);
    if (furthest === steps - 1) break;
  }
  return furthest;
}

/**
 * The funnel's fold (D-26): per visitor, furthestStep. Answers [step,
 * visitors] for every step. With a breakdown, a second result set of [key,
 * other, step, visitors] per group: a visitor counts in the group of their
 * first entry event's value; groups rank by how many entered, ties by key,
 * the top breakdownLimit kept and the rest summed into "Other" (query-128).
 */
export function funnelFolder(fold: Extract<Fold, { kind: "funnel" }>): Folder {
  const zeros = (): number[] => Array.from({ length: fold.steps }, () => 0);
  const reached = zeros();
  const groups = new Map<string, { key: SqlValue; counts: number[] }>();
  let visitor: SqlValue | undefined;
  let events: { ts: number; mask: number }[] = [];
  let entryKey: SqlValue | undefined;
  const close = (): void => {
    const furthest = furthestStep(events, fold.steps, fold.windowMs);
    if (furthest >= 0 && fold.breakdownLimit !== null) {
      const key = entryKey ?? null;
      const text = `${typeof key}:${String(key)}`;
      const group = groups.get(text) ?? { key, counts: zeros() };
      for (let step = 0; step <= furthest; step += 1)
        group.counts[step] = (group.counts[step] ?? 0) + 1;
      groups.set(text, group);
    }
    for (let step = 0; step <= furthest; step += 1) reached[step] = (reached[step] ?? 0) + 1;
    events = [];
    entryKey = undefined;
  };
  return {
    add(row) {
      const [id, ts, , mask, key] = row;
      if (typeof ts !== "number" || typeof mask !== "number") return;
      if (id !== visitor && events.length > 0) close();
      if (id !== visitor) entryKey = undefined;
      visitor = id;
      if (mask === 0) return;
      events.push({ ts, mask });
      if (entryKey === undefined && (mask & 1) !== 0) entryKey = key ?? null;
    },
    finish() {
      if (events.length > 0) close();
      const overall: SqlValue[][] = reached.map((visitors, step) => [step, visitors]);
      if (fold.breakdownLimit === null) return [overall];
      const ranked = [...groups.values()].toSorted(
        (left, right) =>
          (right.counts[0] ?? 0) - (left.counts[0] ?? 0) || compareKeys(left.key, right.key),
      );
      const kept = ranked.slice(0, fold.breakdownLimit);
      const rest = ranked.slice(fold.breakdownLimit);
      const rows: SqlValue[][] = [];
      for (const group of kept) {
        for (const [step, visitors] of group.counts.entries())
          rows.push([group.key, 0, step, visitors]);
      }
      if (rest.length > 0) {
        const other = zeros();
        for (const group of rest) {
          for (const [step, visitors] of group.counts.entries())
            other[step] = (other[step] ?? 0) + visitors;
        }
        for (const [step, visitors] of other.entries()) rows.push(["Other", 1, step, visitors]);
      }
      return [overall, rows];
    },
  };
}

/**
 * Per step its id, count, rate from the start (count / step 1's count),
 * rate from the previous step and drop-off (the previous step's count minus
 * this one's, 0 for step 1); the overall rate (the last step's count / step
 * 1's); and the index of the step with the largest drop-off, the earlier on a
 * tie (query-28). A later count never exceeds an earlier one. With no one at
 * step 1 every count is 0 and every rate and largestDropOff null (query-29).
 */
export function answerFunnel(spec: FunnelSpec, rows: StoreRows): FunnelResult {
  const counted = new Map<number, number>();
  for (const row of rows.results[0] ?? []) {
    const [step, people] = row;
    if (typeof step === "number" && typeof people === "number") counted.set(step, people);
  }
  const whole = funnelOf(
    spec,
    spec.steps.map((_, index) => counted.get(index) ?? 0),
  );
  if (spec.breakdown === undefined) return whole;

  // Groups in the fold's rank order, each with its count per step (query-128).
  const groups = new Map<string, { key: SqlValue; other: boolean; counts: number[] }>();
  for (const row of rows.results[1] ?? []) {
    const [key, other, step, visitors] = row;
    if (key === undefined || typeof step !== "number" || typeof visitors !== "number") continue;
    const text = `${other === 1 ? "other" : typeof key}:${String(key)}`;
    const group = groups.get(text) ?? {
      key,
      other: other === 1,
      counts: spec.steps.map(() => 0),
    };
    group.counts[step] = visitors;
    groups.set(text, group);
  }
  return {
    ...whole,
    groups: [...groups.values()].map((group) => {
      const result = funnelOf(spec, group.counts);
      return {
        key: group.key,
        other: group.other,
        steps: result.steps,
        conversionRate: result.conversionRate,
      };
    }),
  };
}

/** Steps, rates and the largest drop-off from each step's count (query-28, query-29). */
function funnelOf(spec: FunnelSpec, counts: readonly number[]): FunnelResult {
  const entered = counts[0] ?? 0;
  const steps = spec.steps.map((step, index) => {
    const count = counts[index] ?? 0;
    // the first step has no step before it, so its own count is its denominator
    const previous = index === 0 ? entered : (counts[index - 1] ?? 0);
    return {
      id: step.id,
      count,
      rateFromStart: entered === 0 ? null : count / entered,
      rateFromPrevious: previous === 0 ? null : count / previous,
      dropOff: index === 0 ? 0 : previous - count,
    };
  });

  let largestDropOff: number | null = null;
  if (entered > 0) {
    let largest = -1;
    for (const [index, step] of steps.entries()) {
      if (step.dropOff > largest) {
        largest = step.dropOff;
        largestDropOff = index;
      }
    }
  }

  const last = counts.at(-1) ?? 0;
  return {
    steps,
    conversionRate: entered === 0 ? null : last / entered,
    largestDropOff,
  };
}
