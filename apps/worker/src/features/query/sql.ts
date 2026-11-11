import type { SqlValue, Statement } from "./types.ts";

// The SQL pieces every query kind builds from: fragments with their own bound
// parameters, an event property read by its exact name, and the visitor rule.
// Every value and every property name is a bound parameter, never pasted into
// the SQL text (query-02). Pure.

/** One fragment from its text and the parameters its `?` marks, in order. */
export const fragment = (sql: string, ...params: SqlValue[]): Statement => ({ sql, params });

/** Fragments joined by `separator`, their parameters in text order. */
export const joined = (parts: readonly Statement[], separator: string): Statement => ({
  sql: parts.map((part) => part.sql).join(separator),
  params: parts.flatMap((part) => part.params),
});

/** `count` placeholders for an IN list, comma-separated. */
export const placeholders = (count: number): string =>
  Array.from({ length: count }, () => "?").join(", ");

/**
 * A property name as a JSON path, quoted so a dot, a bracket or a quote reads
 * that one key (query-02, query-57). The name itself is bound, and SQL escapes
 * its backslashes and quotes inside the label, so no name reaches the SQL text.
 * One `?`, the name.
 */
export const JSON_PATH = `'$."' || replace(replace(?, '\\', '\\\\'), '"', '\\"') || '"'`;

/** json_type of one of the event's own properties, as stored. */
export const eventPropertyType = (name: string): Statement =>
  fragment(`json_type(e.properties, ${JSON_PATH})`, name);

/** json_extract of one of the event's own properties, as stored. */
export const eventPropertyValue = (name: string): Statement =>
  fragment(`json_extract(e.properties, ${JSON_PATH})`, name);

/**
 * The visitor an event counts for: its person, else its distinct id, which
 * for a cookieless event is its daily hash (query-72, D-25). An identify links
 * an id's earlier events to the person, so a visitor who signs in counts once.
 * A person id is an integer and a distinct id text, so the two never collide.
 */
export const VISITOR = "CASE WHEN e.person_id IS NOT NULL THEN e.person_id ELSE e.distinct_id END";

/** An event count or a visitor count, the measures trends and top lists share. */
export const countOf = (measure: "events" | "visitors"): string =>
  measure === "events" ? "COUNT(*)" : `COUNT(DISTINCT ${VISITOR})`;

/** Where SQLite sorts a key's type: null, then numbers, then text. */
const typeRank = (value: SqlValue | boolean): number =>
  value === null ? 0 : typeof value === "number" || typeof value === "boolean" ? 1 : 2;

/** SQLite's order of two keys: null, then numbers, then text by code unit (the ranking's tie-break). */
export function compareKeys(left: SqlValue | boolean, right: SqlValue | boolean): number {
  const byRank = typeRank(left) - typeRank(right);
  if (byRank !== 0) return byRank;
  if (typeof left === "number" && typeof right === "number") return left - right;
  const a = String(left);
  const b = String(right);
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
