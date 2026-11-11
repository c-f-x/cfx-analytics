import type { ExportPage, JsonObject } from "@cfanalytics/shared";
import { BOUND_PARAMETERS_MAX } from "@cfanalytics/shared";
import { err, ok, type Result } from "../../platform/result.ts";
import { type ExportShape, exportCursor, rowText } from "../../platform/rows.ts";
import { runsOf } from "../../platform/runs.ts";
import { grant } from "./core.ts";

// The `events` and `counters` tables. Synchronous: called inside the
// ProjectStore's write transaction. Every statement binds its parameters, and
// none binds more than 100, the store's limit per statement.

export interface EventInsert {
  uuid: string;
  event: string;
  distinctId: string;
  personId: number | null;
  sessionId: string | null;
  ts: number;
  receivedAt: number;
  bot: boolean;
  page: string | null;
  /** Written as JSON.stringify of the object, read back with JSON.parse (events-15). */
  properties: JsonObject;
}

/** A row the table refused, by a NOT NULL, CHECK or STRICT type rule (events-13). */
export type InsertError = { kind: "row refused"; uuid: string };

const EVENT_COLUMNS =
  "uuid, event, distinct_id, person_id, session_id, ts, received_at, bot, page, properties";
const EVENT_ROW_PARAMETERS = 10;
/** Ten parameters a row, so ten rows meet the statement limit. */
const EVENT_ROWS_PER_STATEMENT = Math.floor(BOUND_PARAMETERS_MAX / EVENT_ROW_PARAMETERS);

/** The uuids among `uuids` that are already stored (intake-03, events-05). */
export function storedUuids(sql: SqlStorage, uuids: readonly string[]): Set<string> {
  const stored = new Set<string>();
  for (const chunk of runsOf([...new Set(uuids)], BOUND_PARAMETERS_MAX)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = sql
      .exec(`SELECT uuid FROM events WHERE uuid IN (${placeholders})`, ...chunk)
      .toArray();
    for (const row of rows) {
      if (typeof row.uuid === "string") stored.add(row.uuid);
    }
  }
  return stored;
}

/**
 * Takes up to `wanted` from the counter `name` of `day` under `cap`, making
 * the row when it has none, and answers how many were granted (grant). The
 * counter rises by what was granted only (events-01 to events-04). One
 * writer per counter, inside one transaction, so two batches never both take
 * the last of a cap (intake-09). Recording bytes use takeWholeFromCap.
 */
export function takeFromCap(
  sql: SqlStorage,
  day: string,
  name: "events" | "recording_bytes",
  cap: number,
  wanted: number,
): number {
  const row = sql
    .exec("SELECT value FROM counters WHERE day = ? AND name = ?", day, name)
    .toArray()[0];
  const taken = typeof row?.value === "number" ? row.value : 0;
  const granted = grant(cap, taken, wanted);
  if (granted > 0) {
    sql.exec(
      `INSERT INTO counters (day, name, value) VALUES (?, ?, ?)
       ON CONFLICT (day, name) DO UPDATE SET value = excluded.value`,
      day,
      name,
      taken + granted,
    );
  }
  return granted;
}

/**
 * Takes all of `wanted` from the counter `name` of `day` under `cap`, or
 * nothing, making the row when it has none: true when taken. A recording
 * chunk that would cross the daily bytes cap is refused whole, and one of
 * exactly the bytes left is taken (recordings-03, recordings-10, D-20).
 */
export function takeWholeFromCap(
  sql: SqlStorage,
  day: string,
  name: "events" | "recording_bytes",
  cap: number,
  wanted: number,
): boolean {
  const row = sql
    .exec("SELECT value FROM counters WHERE day = ? AND name = ?", day, name)
    .toArray()[0];
  const taken = typeof row?.value === "number" ? row.value : 0;
  if (grant(cap, taken, wanted) < wanted) return false;
  if (wanted > 0) {
    sql.exec(
      `INSERT INTO counters (day, name, value) VALUES (?, ?, ?)
       ON CONFLICT (day, name) DO UPDATE SET value = excluded.value`,
      day,
      name,
      taken + wanted,
    );
  }
  return true;
}

/**
 * Gives `amount` back to the counter `name` of `day`, never below zero, when
 * what was taken was never written: a recording chunk whose R2 write failed.
 */
export function returnToCap(
  sql: SqlStorage,
  day: string,
  name: "events" | "recording_bytes",
  amount: number,
): void {
  if (amount <= 0) return;
  sql.exec(
    "UPDATE counters SET value = MAX(0, value - ?) WHERE day = ? AND name = ?",
    amount,
    day,
    name,
  );
}

/**
 * Inserts the rows, each with INSERT OR IGNORE ... RETURNING, and answers how
 * many were new, counted from what RETURNING gave, never from rowsWritten
 * (events-06, events-10). A uuid already stored changes nothing (events-10).
 * When a row's uuid is not stored afterwards, a constraint refused it: the
 * answer is that InsertError, and the caller rolls its transaction back, so
 * the batch is accepted only when every uuid is present (events-13).
 */
export function insertEvents(
  sql: SqlStorage,
  rows: readonly EventInsert[],
): Result<number, InsertError> {
  let added = 0;
  for (const chunk of runsOf(rows, EVENT_ROWS_PER_STATEMENT)) {
    const values = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const bindings: SqlStorageValue[] = [];
    for (const row of chunk) {
      bindings.push(
        row.uuid,
        row.event,
        row.distinctId,
        row.personId,
        row.sessionId,
        row.ts,
        row.receivedAt,
        Number(row.bot),
        row.page,
        JSON.stringify(row.properties),
      );
    }
    let inserted: unknown[];
    try {
      inserted = sql
        .exec(
          `INSERT OR IGNORE INTO events (${EVENT_COLUMNS}) VALUES ${values} RETURNING uuid`,
          ...bindings,
        )
        .toArray();
    } catch {
      // OR IGNORE does not cover a STRICT datatype violation: SQLite throws.
      // The uuid names the first row of the statement that held the bad row.
      return err({ kind: "row refused", uuid: chunk[0]?.uuid ?? "" });
    }
    added += inserted.length;
  }

  // OR IGNORE skips a row that breaks NOT NULL or CHECK as well as one that
  // repeats a uuid, so a uuid missing afterwards is a refusal (events-13).
  const stored = storedUuids(
    sql,
    rows.map((row) => row.uuid),
  );
  for (const row of rows) {
    if (!stored.has(row.uuid)) return err({ kind: "row refused", uuid: row.uuid });
  }
  return ok(added);
}

/** Moves a merged person's events to the person they joined, and answers how many moved (identity-01). */
export function reassignPerson(sql: SqlStorage, from: number, into: number): number {
  return sql
    .exec("UPDATE events SET person_id = ? WHERE person_id = ? RETURNING id", into, from)
    .toArray().length;
}

/**
 * Gives `personId` the events of `distinctId` that have no person, and
 * answers how many (identity-01, identity-03, identity-13). Events of other
 * ids, and events that already have a person, are not touched.
 */
export function claimEvents(sql: SqlStorage, distinctId: string, personId: number): number {
  return sql
    .exec(
      "UPDATE events SET person_id = ? WHERE distinct_id = ? AND person_id IS NULL RETURNING id",
      personId,
      distinctId,
    )
    .toArray().length;
}

/** Deletes counter rows of days before `keepFrom` and answers how many. The daily alarm calls it from wave 4 (events-09). */
export function pruneCounters(sql: SqlStorage, keepFrom: string): number {
  return sql.exec("DELETE FROM counters WHERE day < ? RETURNING day", keepFrom).toArray().length;
}

// ── Retention, deletion by person and export (wave 4) ──────────────────────

/**
 * Deletes up to `limit` events whose ts, the event time, is before
 * `cutoffTs`, the oldest first, and answers how many (privacy-01,
 * privacy-06, privacy-27). Received time plays no part.
 */
export function pruneEvents(sql: SqlStorage, cutoffTs: number, limit: number): number {
  return sql
    .exec(
      `DELETE FROM events WHERE id IN (
         SELECT id FROM events WHERE ts < ? ORDER BY ts, id LIMIT ?
       ) RETURNING id`,
      cutoffTs,
      limit,
    )
    .toArray().length;
}

/**
 * Deletes a person's events: those whose person_id is `personId`, and those
 * of `distinctIds` with no person (privacy-02, privacy-16). `personId` null
 * deletes only the latter. Answers how many. Statements bind at most
 * BOUND_PARAMETERS_MAX parameters, however many ids the person has.
 */
export function eraseEvents(
  sql: SqlStorage,
  personId: number | null,
  distinctIds: readonly string[],
): number {
  let deleted = 0;
  if (personId !== null) {
    deleted += sql
      .exec("DELETE FROM events WHERE person_id = ? RETURNING id", personId)
      .toArray().length;
  }
  for (const chunk of runsOf(distinctIds, BOUND_PARAMETERS_MAX)) {
    const placeholders = chunk.map(() => "?").join(", ");
    deleted += sql
      .exec(
        `DELETE FROM events WHERE person_id IS NULL AND distinct_id IN (${placeholders})
         RETURNING id`,
        ...chunk,
      )
      .toArray().length;
  }
  return deleted;
}

/**
 * One export page of `events` (privacy-22, privacy-25): an ExportPage: up to `limit` rows with a rowid above `after`, by rowid, each as one JSON line of its columns by name
 * (id, uuid, event, distinct_id, person_id, session_id, ts, received_at,
 * bot, page, and properties as its JSON object, not as text). `next` is the
 * last row's rowid when the page holds `limit` rows, else null.
 */
/** The columns an events export writes, and an import reads back (privacy-22, privacy-30). */
export const EVENTS_SHAPE: ExportShape = {
  table: "events",
  columns: [
    "id",
    "uuid",
    "event",
    "distinct_id",
    "person_id",
    "session_id",
    "ts",
    "received_at",
    "bot",
    "page",
    "properties",
  ],
  json: ["properties"],
};

export function exportEvents(sql: SqlStorage, after: number, limit: number): ExportPage {
  const page = sql
    .exec(
      `SELECT rowid AS row_id, ${EVENTS_SHAPE.columns.join(", ")}
         FROM events WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      after,
      limit,
    )
    .toArray();
  const lines = page.map((row) => {
    // The export reads the stored text back as the object it holds (privacy-22).
    const parsed: unknown = JSON.parse(rowText(row.properties, "events.properties"));
    const columns: Record<string, unknown> = { ...row, properties: parsed };
    delete columns.row_id;
    return JSON.stringify(columns);
  });
  return { lines, next: exportCursor(page, limit) };
}
