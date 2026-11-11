import { QUERY, type ResolvedRange, type TopResult, type TopSpec } from "@cfanalytics/shared";
import { err, ok, type Result } from "../../platform/result.ts";
import { decodeCursor, encodeCursor, fingerprint } from "./cursor.ts";
import { dimensionSql } from "./filters.ts";
import { countOf } from "./sql.ts";
import type { CompiledQuery, SqlValue, Statement, StoreRows } from "./types.ts";

// Top lists: one dimension's values by count (query-47, query-48, query-64
// to query-72). Pure.

/** A row's key and count, the key typed as SQL gives it. */
interface TopRow {
  key: string | number | boolean | null;
  count: number;
}

/**
 * One statement over events in [range.from, range.to) that match `scope`,
 * spec.event when given, and the dimension's own `where` (dimensionSql):
 * the dimension's value as key, and its count, events or visitors as trend
 * counts them (query-72). Ordered by count descending, then key ascending
 * with NULL first, a key being unique per row, so equal counts keep one
 * stable order (query-48, query-65). Paged by keyset, never OFFSET: with
 * spec.cursor, only rows after the cursor's (count, key) in that order;
 * spec.limit (QUERY.topLimit.default when absent) plus one rows are read, so
 * answerTop can tell whether a page follows (query-70). A top list of pages
 * has no row for an empty path: a missing page key is the null key
 * (query-71). A cursor decodeCursor refuses, or one of another kind or
 * spec, is "invalid cursor" (query-49).
 */
export function compileTop(
  spec: TopSpec,
  range: ResolvedRange,
  scope: Statement,
): Result<CompiledQuery, "invalid cursor"> {
  const dimension = dimensionSql(spec.dimension);
  const where: Statement[] = [
    { sql: "e.ts >= ? AND e.ts < ?", params: [range.from, range.to] },
    { sql: `(${scope.sql})`, params: [...scope.params] },
  ];
  if (spec.event !== undefined) where.push({ sql: "e.event = ?", params: [spec.event] });
  where.push({ sql: `(${dimension.where.sql})`, params: [...dimension.where.params] });

  let after: { count: number; key: SqlValue } | null = null;
  if (spec.cursor !== undefined) {
    const decoded = decodeCursor(spec.cursor, fingerprint({ ...spec }));
    if (!decoded.ok || decoded.value.kind !== "top") return err("invalid cursor");
    const { count, key } = decoded.value;
    // SQL never answers a boolean key; one a forged cursor holds compares as its number.
    after = { count, key: typeof key === "boolean" ? Number(key) : key };
  }

  // The cursor's position in (count desc, key asc): a smaller count, or the
  // same count and a key after it, NULLs first.
  const paging: Statement =
    after === null
      ? { sql: "1", params: [] }
      : {
          sql: "(count < ? OR (count = ? AND key IS NOT NULL AND (? IS NULL OR key > ?)))",
          params: [after.count, after.count, after.key, after.key],
        };

  const limit = spec.limit ?? QUERY.topLimit.default;
  const counted = `SELECT ${dimension.value.sql} AS key, ${countOf(spec.measure)} AS count
                   FROM events e
                   WHERE ${where.map((part) => part.sql).join(" AND ")}
                   GROUP BY 1`;
  return ok({
    statements: [
      {
        sql: `SELECT key, count
              FROM (${counted})
              WHERE ${paging.sql}
              ORDER BY count DESC, key ASC
              LIMIT ?`,
        params: [
          ...dimension.value.params,
          ...where.flatMap((part) => part.params),
          ...paging.params,
          limit + 1,
        ],
      },
    ],
  });
}

/**
 * At most spec.limit rows as {key, count}, and `nextCursor` (encodeCursor of
 * the last row returned, for this spec's fingerprint) when compileTop's rows
 * held one more; absent on the last page (query-70).
 */
export function answerTop(spec: TopSpec, rows: StoreRows): TopResult {
  const limit = spec.limit ?? QUERY.topLimit.default;
  const found: TopRow[] = [];
  for (const row of rows.results[0] ?? []) {
    const [key, count] = row;
    if (key === undefined || typeof count !== "number") continue;
    found.push({ key, count });
  }

  const page = found.slice(0, limit);
  const result: TopResult = { rows: page };
  if (found.length > page.length) {
    const last = page.at(-1);
    if (last !== undefined) {
      result.nextCursor = encodeCursor(
        { kind: "top", count: last.count, key: last.key },
        fingerprint({ ...spec }),
      );
    }
  }
  return result;
}
