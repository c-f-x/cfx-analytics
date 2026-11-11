import { type Range, type ResolvedRange, resolveRange } from "@cfanalytics/shared";
import type { CompiledQuery, StoreRows } from "../../src/features/query/index.ts";
import type { QueryContext, Statement } from "../../src/features/query/types.ts";
import { DAY_MS, storeOf, T0 } from "./capture.ts";

// What the query tests share: a context, a range resolved as the route
// resolves it, a scope that selects every event, and compiled statements run
// through the ProjectStore's own RPC call.

/** The time zone the tests use unless they name another. */
export const OSLO = "Europe/Oslo";

/** A QueryContext at T0 in Europe/Oslo, keeping 395 days, with no internal rules. Overrides win. */
export function queryContext(overrides: Partial<QueryContext> = {}): QueryContext {
  return {
    now: T0,
    projectTimeZone: OSLO,
    retentionStart: T0 - 395 * DAY_MS,
    internalRules: [],
    ...overrides,
  };
}

/** `range` resolved by the shared rules, at `now` in `timeZone`, clipped at nothing unless `retentionStart` says. */
export function resolved(
  range: Range,
  timeZone: string = OSLO,
  now: number = T0,
  retentionStart = 0,
): ResolvedRange {
  const result = resolveRange(range, timeZone, now, retentionStart);
  if (!result.ok) throw new Error(`the test's range does not resolve: ${result.error}`);
  return result.value;
}

/** A scope that selects every event: no exclusion and no filter. */
export const EVERY_EVENT: Statement = { sql: "1", params: [] };

/**
 * `query` through the project's ProjectStore RPC call runQuery, as the query
 * route runs it, and its rows. A SchemaError or a failed statement fails the
 * test with its own message.
 */
export async function runStatements(projectId: string, query: CompiledQuery): Promise<StoreRows> {
  const answer = await storeOf(projectId).runQuery(query);
  if (!answer.ok) throw new Error(`runQuery refused: ${JSON.stringify(answer.error)}`);
  return answer.value;
}
