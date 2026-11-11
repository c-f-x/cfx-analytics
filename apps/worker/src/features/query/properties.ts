import {
  type PropertiesResult,
  type PropertiesSpec,
  QUERY,
  type ResolvedRange,
} from "@cfanalytics/shared";
import { fragment, joined } from "./sql.ts";
import type { CompiledQuery, Statement, StoreRows } from "./types.ts";

// The property catalogue (query-51). Pure.

/**
 * Two statements over the newest QUERY.propertiesEvents events in
 * [range.from, range.to) that match `scope` and spec.event when given, read
 * newest first on events_ts (D-26): each top-level property name of
 * e.properties (json_each), each JSON type it holds (json_type: "text",
 * "integer", "real", "true", "false", "null", "array", "object"), and how
 * many of those events hold it with that type; then how many events the
 * sample holds.
 */
export function compileProperties(
  spec: PropertiesSpec,
  range: ResolvedRange,
  scope: Statement,
): CompiledQuery {
  const sample = joined(
    [
      fragment(
        "SELECT e.properties FROM events e INDEXED BY events_ts WHERE e.ts >= ? AND e.ts < ?",
        range.from,
        range.to,
      ),
      fragment(`(${scope.sql})`, ...scope.params),
      ...(spec.event === undefined ? [] : [fragment("e.event = ?", spec.event)]),
    ],
    " AND ",
  );
  const newest = joined(
    [sample, fragment("ORDER BY e.ts DESC, e.id DESC LIMIT ?", QUERY.propertiesEvents)],
    " ",
  );
  return {
    statements: [
      joined(
        [
          fragment("SELECT j.key AS name, j.type AS type, COUNT(*) AS total FROM ("),
          newest,
          fragment(") AS e, json_each(e.properties) AS j GROUP BY j.key, j.type"),
        ],
        " ",
      ),
      joined([fragment("SELECT COUNT(*) AS events FROM ("), newest, fragment(")")], " "),
    ],
  };
}

/** Each property once, by name ascending, with its types by count descending, then type ascending (query-51). */
export function answerProperties(rows: StoreRows): PropertiesResult {
  const byName = new Map<string, { type: string; count: number }[]>();
  for (const row of rows.results[0] ?? []) {
    const [name, type, total] = row;
    if (typeof name !== "string" || typeof type !== "string" || typeof total !== "number") continue;
    const types = byName.get(name) ?? [];
    types.push({ type, count: total });
    byName.set(name, types);
  }

  const properties = [...byName.entries()]
    .toSorted(([left], [right]) => compareText(left, right))
    .map(([name, types]) => ({
      name,
      types: types.toSorted(
        (left, right) => right.count - left.count || compareText(left.type, right.type),
      ),
    }));
  const [[events] = []] = rows.results[1] ?? [];
  return { properties, events: typeof events === "number" ? events : 0 };
}

/** Text ascending, the order SQLite gives these names. */
function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}
