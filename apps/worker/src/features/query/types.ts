import type { InternalRule, ResolvedRange } from "@cfanalytics/shared";

// Shapes the query slice's files share. Types only.

/** A value bound to a statement, or read back from one. The events tables hold no BLOB. */
export type SqlValue = string | number | null;

/** One statement and its bound parameters, one `?` per parameter (query-02). */
export interface Statement {
  sql: string;
  params: SqlValue[];
}

/** One or more statements run in order in one ProjectStore call. Their rowsRead are summed (query-12). */
export interface CompiledQuery {
  statements: Statement[];
  /**
   * A fold the store runs over the last statement's rows, in their order,
   * before they leave the object (D-26). Its few result sets take that
   * statement's place in StoreRows, so a scan of every visitor's events never
   * crosses RPC and never sits in memory whole.
   */
  fold?: Fold;
}

/**
 * The folds the store knows. The funnel's and retention's read rows ordered
 * by visitor, so they hold one visitor's events at a time.
 * - funnel: rows [visitor, ts, id, mask, key], mask bit k set when the event
 *   matches step k, key its breakdown value; answers [step, visitors], and
 *   with a breakdown [key, other, step, visitors] (funnel.ts).
 * - retention: rows [visitor, ts, start, return], start and return 1 or 0;
 *   answers [cohort, size] and [cohort, period, visitors] (retention.ts).
 * - trend: rows [bucket, key, value, visitor], in no order; answers the
 *   bucket rows and total rows of each period (trend.ts).
 */
export type Fold =
  | {
      kind: "funnel";
      steps: number;
      windowMs: number;
      /** With a breakdown, how many groups are kept before "Other"; null without one (query-128). */
      breakdownLimit: number | null;
    }
  | { kind: "retention"; buckets: readonly (readonly [number, number])[] }
  | {
      kind: "trend";
      measure: "events" | "visitors" | "sessions";
      /** How many buckets the current period has; bucket numbers from here on are the previous period's. */
      current: number;
      /** How many buckets the previous period has, or null without `compare`. */
      previous: number | null;
      /** How many keys are kept before the rest go into "Other". */
      limit: number;
      breakdown: boolean;
    };

/** A fold's running state: rows go in one at a time, then its result sets come out. */
export interface Folder {
  add(row: readonly SqlValue[]): void;
  finish(): SqlValue[][][];
}

/**
 * What compiling needs besides the spec, read from the project's settings by
 * http.ts. The clock is a value, so "today" resolves the same twice in one
 * run (query-37).
 */
export interface QueryContext {
  now: number;
  /** The project's time zone, used when the spec names none (query-14). */
  projectTimeZone: string;
  /** The earliest event time the project keeps: now minus events_retention_days (query-40). */
  retentionStart: number;
  /** The project's internal-traffic rules, in their stored order (query-08). */
  internalRules: readonly InternalRule[];
}

/** Rows as the store returns them: one array of rows per statement, each row its columns in SELECT order. */
export interface StoreRows {
  results: SqlValue[][][];
  /** The sum of every statement's rows read; null when a statement did not report (query-12). */
  rowsRead: number | null;
}

/** A failed statement: its index in the CompiledQuery and SQLite's message. The Worker answers 503. */
export type RunError = { kind: "query failed"; statement: number; message: string };

export type { ResolvedRange };
