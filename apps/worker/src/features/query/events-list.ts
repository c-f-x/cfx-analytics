import {
  type EventRow,
  type EventsResult,
  type EventsSpec,
  isJsonObject,
  QUERY,
  type ResolvedRange,
} from "@cfanalytics/shared";
import { err, ok, type Result } from "../../platform/result.ts";
import { decodeCursor, encodeCursor, fingerprint } from "./cursor.ts";
import type { CompiledQuery, SqlValue, Statement, StoreRows } from "./types.ts";

// The raw event list (query-48, query-49, query-70). Pure.

/**
 * One statement over events in [range.from, range.to) that match `scope`
 * and spec.event when given: uuid, event, distinct_id, ts, the properties'
 * JSON text and id, newest first by (ts desc, id desc), id being unique.
 * Paged by keyset, never OFFSET: with spec.cursor, only rows after its
 * (ts, id); spec.limit (QUERY.eventsLimit.default when absent) plus one rows
 * are read. A cursor decodeCursor refuses, or one of another kind or spec,
 * is "invalid cursor" (query-49).
 */
export function compileEvents(
  spec: EventsSpec,
  range: ResolvedRange,
  scope: Statement,
): Result<CompiledQuery, "invalid cursor"> {
  const where: Statement[] = [
    { sql: "e.ts >= ? AND e.ts < ?", params: [range.from, range.to] },
    { sql: `(${scope.sql})`, params: [...scope.params] },
  ];
  if (spec.event !== undefined) where.push({ sql: "e.event = ?", params: [spec.event] });

  if (spec.cursor !== undefined) {
    const decoded = decodeCursor(spec.cursor, fingerprint({ ...spec }));
    if (!decoded.ok || decoded.value.kind !== "events") return err("invalid cursor");
    const { ts, id } = decoded.value;
    where.push({
      sql: "(e.ts < ? OR (e.ts = ? AND e.id < ?))",
      params: [ts, ts, id],
    });
  }

  const limit = spec.limit ?? QUERY.eventsLimit.default;
  return ok({
    statements: [
      {
        sql: `SELECT e.uuid, e.event, e.distinct_id, e.ts, e.properties, e.id
              FROM events e
              WHERE ${where.map((part) => part.sql).join(" AND ")}
              ORDER BY e.ts DESC, e.id DESC
              LIMIT ?`,
        params: [...where.flatMap((part) => part.params), limit + 1],
      },
    ],
  });
}

/**
 * At most spec.limit EventRows, `ts` as ISO UTC and `properties` parsed back
 * from their JSON text with every value's type unchanged (events-15); and
 * `nextCursor` when compileEvents' rows held one more, absent on the last
 * page (query-70).
 */
export function answerEvents(spec: EventsSpec, rows: StoreRows): EventsResult {
  const limit = spec.limit ?? QUERY.eventsLimit.default;
  const found = (rows.results[0] ?? []).map(readRow);
  const page = found.slice(0, limit);
  const result: EventsResult = { rows: page.map((entry) => entry.row) };
  if (found.length > page.length) {
    const last = page.at(-1);
    if (last !== undefined) {
      result.nextCursor = encodeCursor(
        { kind: "events", ts: last.ts, id: last.id },
        fingerprint({ ...spec }),
      );
    }
  }
  return result;
}

/** A row of compileEvents' SELECT, in its column order, with the key its cursor needs. */
function readRow(values: readonly SqlValue[]): { row: EventRow; ts: number; id: number } {
  const [uuid, event, distinctId, ts, properties, id] = values;
  return {
    row: {
      uuid: String(uuid),
      event: String(event),
      distinctId: String(distinctId),
      ts: new Date(Number(ts)).toISOString(),
      properties: propertiesOf(properties),
    },
    ts: Number(ts),
    id: Number(id),
  };
}

/** The properties' JSON text back, every value as stored (events-15); a value that is not an object has no properties. */
function propertiesOf(text: SqlValue | undefined): Record<string, unknown> {
  if (typeof text !== "string") return {};
  const parsed: unknown = JSON.parse(text);
  return isJsonObject(parsed) ? parsed : {};
}
