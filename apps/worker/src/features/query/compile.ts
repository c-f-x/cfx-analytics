import {
  type Answer,
  type ApiIssue,
  type Filter,
  QUERY,
  type QuerySpec,
  type ResolvedRange,
  type ResultOf,
  resolveRange,
} from "@cfanalytics/shared";
import { err, ok, type Result } from "../../platform/result.ts";
import { checkBudget } from "./budget.ts";
import { answerEvents, compileEvents } from "./events-list.ts";
import { exclusionsSql, filterSql } from "./filters.ts";
import { answerFunnel, compileFunnel } from "./funnel.ts";
import { answerProperties, compileProperties } from "./properties.ts";
import { type Bucket, bucketsOf, previousPeriod } from "./range.ts";
import { answerRetention, compileRetention } from "./retention.ts";
import { answerScrollDepth, compileScrollDepth } from "./scroll.ts";
import { answerTop, compileTop } from "./top.ts";
import { answerTrend, compileTrend, type Period } from "./trend.ts";
import type { CompiledQuery, QueryContext, Statement, StoreRows } from "./types.ts";

// One door for every kind (query-12, query-13, query-17): prepareQuery turns a
// valid spec into statements before anything is read, and answerQuery shapes
// the store's rows into the kind's answer with its meta. Pure.

export type QueryResult = ResultOf[QuerySpec["kind"]];

/** A spec ready to run: its range, buckets where the kind has them, statements and exclusions. */
export interface Prepared {
  range: ResolvedRange;
  /** The current period's buckets, for trend and retention; null for the other kinds. */
  buckets: Bucket[] | null;
  /** A trend's previous period with `compare`; else null. */
  previous: { range: ResolvedRange; buckets: Bucket[] } | null;
  compiled: CompiledQuery;
  includeBots: boolean;
  /** The internal rules applied, by index in the project's list (query-08). */
  applied: number[];
}

const ISSUE = (path: string, message: string, code = "validation_failed"): ApiIssue => ({
  path,
  code,
  message,
});

/** Why a range cannot be resolved, as one sentence (query-11). */
const rangeMessage = (problem: "start not before end" | "negative start"): string =>
  problem === "negative start"
    ? "The range starts before 1970."
    : "The range must start before it ends.";

/** The scope of every kind: the exclusions, joined by AND with the spec's filter (query-60). */
function scopedBy(exclusions: Statement, filter: Filter | undefined): Statement {
  if (filter === undefined) return exclusions;
  const own = filterSql(filter);
  return {
    sql: `(${exclusions.sql}) AND (${own.sql})`,
    params: [...exclusions.params, ...own.params],
  };
}

/** The kind's compiler, given the period and previous period it reads. */
function compileKind(
  spec: QuerySpec,
  period: Period,
  previous: Period | null,
  scope: Statement,
): Result<CompiledQuery, "invalid cursor"> {
  if (spec.kind === "trend") return ok(compileTrend(spec, { current: period, previous }, scope));
  if (spec.kind === "top") return compileTop(spec, period.range, scope);
  if (spec.kind === "funnel") return ok(compileFunnel(spec, period.range, scope));
  if (spec.kind === "retention") return ok(compileRetention(spec, period, scope));
  if (spec.kind === "scroll_depth") return ok(compileScrollDepth(spec, period.range, scope));
  if (spec.kind === "events") return compileEvents(spec, period.range, scope);
  return ok(compileProperties(spec, period.range, scope));
}

/**
 * Prepares a spec parseSpec accepted, reading nothing:
 * 1. resolveRange (packages/shared) of spec.range in spec.timeZone, else the
 *    project's (query-14), at context.now, clipped at context.retentionStart
 *    (query-40). An error is an issue at "/range" (query-11).
 * 2. For trend and retention, bucketsOf the range in the spec's granularity;
 *    with a trend's `compare`, previousPeriod and its buckets, and the two
 *    bucket counts must be equal, else an issue at "/compare" (query-38,
 *    query-39). Too many buckets is an issue at "/granularity" with code
 *    "too_many_buckets" (query-39).
 * 3. The scope every kind's compiler is given: exclusionsSql of the
 *    project's rules with spec.includeBots and spec.includeInternal (false
 *    when absent), joined by AND with filterSql of spec.filter when given
 *    (query-07, query-08, query-60).
 * 4. The kind's compiler. An invalid cursor is an issue at "/cursor" with
 *    code "invalid_cursor" (query-49).
 * 5. checkBudget: over either limit is an issue at "" with code
 *    "too_many_parameters" (query-31).
 * An issue's code is "validation_failed" unless named above. The compiled
 * SQL holds no property name, event name, value or time as text: every one
 * is a bound parameter, one per `?` (query-02).
 */
export function prepareQuery(spec: QuerySpec, context: QueryContext): Result<Prepared, ApiIssue[]> {
  const timeZone = spec.timeZone ?? context.projectTimeZone;
  const resolved = resolveRange(spec.range, timeZone, context.now, context.retentionStart);
  if (!resolved.ok) return err([ISSUE("/range", rangeMessage(resolved.error))]);
  const range = resolved.value;

  let buckets: Bucket[] | null = null;
  let previous: Period | null = null;
  if (spec.kind === "trend" || spec.kind === "retention") {
    const current = bucketsOf(range, spec.granularity);
    if (!current.ok) {
      return err([
        ISSUE(
          "/granularity",
          `The range would need more than ${QUERY.maxBuckets} buckets.`,
          "too_many_buckets",
        ),
      ]);
    }
    buckets = current.value;
    if (spec.kind === "trend" && spec.compare === true) {
      const earlier = previousPeriod(range, context.retentionStart);
      const earlierBuckets = bucketsOf(earlier, spec.granularity);
      if (!earlierBuckets.ok) {
        return err([
          ISSUE(
            "/compare",
            `The range would need more than ${QUERY.maxBuckets} buckets.`,
            "too_many_buckets",
          ),
        ]);
      }
      if (earlierBuckets.value.length !== buckets.length) {
        return err([ISSUE("/compare", "The two periods must have the same number of buckets.")]);
      }
      previous = { range: earlier, buckets: earlierBuckets.value };
    }
  }

  const includeBots = spec.includeBots ?? false;
  const exclusions = exclusionsSql(context.internalRules, {
    includeBots,
    includeInternal: spec.includeInternal ?? false,
  });
  const period: Period = { range, buckets: buckets ?? [] };
  const compiled = compileKind(spec, period, previous, scopedBy(exclusions.where, spec.filter));
  if (!compiled.ok) {
    return err([ISSUE("/cursor", "The cursor does not belong to this query.", "invalid_cursor")]);
  }
  const budget = checkBudget(compiled.value);
  if (!budget.ok) {
    return err([
      ISSUE(
        "",
        budget.error === "too many parameters"
          ? `The query binds more than ${QUERY.boundParameters} parameters.`
          : `The query holds more than ${QUERY.sqlBytes} bytes of SQL in one statement.`,
        "too_many_parameters",
      ),
    ]);
  }

  return ok({
    range,
    buckets,
    previous,
    compiled: budget.value,
    includeBots,
    applied: exclusions.applied,
  });
}

/** The kind's answer function over the store's rows (query-12, query-13). */
function answerOf(
  spec: QuerySpec,
  period: Period,
  prepared: Prepared,
  rows: StoreRows,
): QueryResult {
  if (spec.kind === "trend") {
    return answerTrend(spec, { current: period, previous: prepared.previous }, rows);
  }
  if (spec.kind === "top") return answerTop(spec, rows);
  if (spec.kind === "funnel") return answerFunnel(spec, rows);
  if (spec.kind === "retention") return answerRetention(spec, period, rows);
  if (spec.kind === "scroll_depth") return answerScrollDepth(rows);
  if (spec.kind === "events") return answerEvents(spec, rows);
  return answerProperties(rows);
}

/**
 * The answer for the spec's kind from the store's rows, through the kind's
 * answer function, with its meta (query-12): `range` as ISO UTC from and to;
 * `requested` as ISO UTC when the range was clipped (query-40), else absent;
 * the time zone; `excluded` with bots true unless includeBots, internalRules
 * the applied indexes, notApplicable empty; and rowsRead from the store
 * (query-12, query-13). A project with no events answers its kind's empty
 * result with the same meta (query-17).
 */
export function answerQuery(
  spec: QuerySpec,
  prepared: Prepared,
  rows: StoreRows,
): Answer<QueryResult> {
  const { range } = prepared;
  const requested = range.requested;
  const period: Period = { range, buckets: prepared.buckets ?? [] };
  return {
    meta: {
      range: { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() },
      ...(requested === null
        ? {}
        : {
            requested: {
              from: new Date(requested.from).toISOString(),
              to: new Date(requested.to).toISOString(),
            },
          }),
      timeZone: range.timeZone,
      excluded: {
        bots: !prepared.includeBots,
        internalRules: prepared.applied,
        notApplicable: [],
      },
      rowsRead: rows.rowsRead,
    },
    result: answerOf(spec, period, prepared, rows),
  };
}
