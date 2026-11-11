import type { ResolvedRange, ScrollDepthResult, ScrollDepthSpec } from "@cfanalytics/shared";
import {
  fragment,
  joined,
  eventPropertyType as jsonType,
  eventPropertyValue as jsonValue,
} from "./sql.ts";
import type { CompiledQuery, Statement, StoreRows } from "./types.ts";

// Scroll depth of one page (D-20; heatmaps-03, heatmaps-16 to heatmaps-18;
// posthog-protocol.md §8.2). Pure.

/** The tenth of the page each of reached[0] to reached[9] names. */
const TENTHS = Array.from({ length: 10 }, (_, index) => (index + 1) / 10);

/**
 * One statement over $pageleave and $pageview events in [range.from,
 * range.to) that match `scope`, so bots and internal traffic are left out
 * (heatmaps-18), and whose $prev_pageview_pathname equals spec.path: a
 * $pageview's $prev_pageview_* properties describe the view before it, so
 * they count for that path, never the new page's (heatmaps-16). Each
 * $prev_pageview_id counts once, its greatest
 * $prev_pageview_max_content_percentage taken; an event with no id, or with
 * $prev_pageview_disable_scroll_properties true, adds no view (heatmaps-17).
 * A percentage that is not a number, or is negative, adds no view.
 */
export function compileScrollDepth(
  spec: ScrollDepthSpec,
  range: ResolvedRange,
  scope: Statement,
): CompiledQuery {
  const id = jsonValue("$prev_pageview_id");
  const percentage = jsonValue("$prev_pageview_max_content_percentage");
  const pathname = jsonValue("$prev_pageview_pathname");
  const disabled = jsonType("$prev_pageview_disable_scroll_properties");

  const views = joined(
    [
      fragment("WITH views AS (\n  SELECT "),
      id,
      fragment(" AS id, max("),
      percentage,
      fragment(") AS percentage\n    FROM events e\n   WHERE ("),
      scope,
      fragment(")\n     AND e.ts >= ? AND e.ts < ?", range.from, range.to),
      fragment("\n     AND e.event IN (?, ?)", "$pageleave", "$pageview"),
      fragment("\n     AND "),
      pathname,
      fragment(" = ?", spec.path),
      fragment("\n     AND COALESCE("),
      jsonType("$prev_pageview_id"),
      fragment(", '') NOT IN ('', 'null')"),
      fragment("\n     AND COALESCE("),
      disabled,
      fragment(", '') <> 'true'"),
      fragment("\n     AND COALESCE("),
      jsonType("$prev_pageview_max_content_percentage"),
      fragment(", '') IN ('integer', 'real')"),
      fragment("\n     AND "),
      percentage,
      fragment(" >= 0\n   GROUP BY 1\n)"),
    ],
    "",
  );

  const counts = joined(
    TENTHS.map((tenth) => fragment("sum(CASE WHEN percentage >= ? THEN 1 ELSE 0 END)", tenth)),
    ", ",
  );
  const statement = joined(
    [views, fragment("\nSELECT count(*) AS views, "), counts, fragment("\n  FROM views")],
    "",
  );

  return { statements: [statement] };
}

/**
 * The number of views, and reached[i] for i from 0 to 9: the share of views
 * whose percentage is at least (i + 1) / 10, a value above 1 counting as 1,
 * so exactly 0.1 reaches tenth 1 (heatmaps-03). With no view, every share is
 * 0.
 */
export function answerScrollDepth(rows: StoreRows): ScrollDepthResult {
  const [row] = rows.results[0] ?? [];
  const views = row?.[0];
  const total = typeof views === "number" ? views : 0;
  const reached = TENTHS.map((_, index) => {
    const count = row?.[index + 1];
    if (total === 0) return 0;
    return (typeof count === "number" ? count : 0) / total;
  });
  return { views: total, reached };
}
