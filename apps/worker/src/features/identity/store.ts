import {
  BOUND_PARAMETERS_MAX,
  type ExportPage,
  isJsonObject,
  type JsonObject,
} from "@cfanalytics/shared";
import { type ExportShape, exportCursor, rowNumber, rowText } from "../../platform/rows.ts";
import { runsOf } from "../../platform/runs.ts";
import {
  applyPersonOps,
  type IdSide,
  linkPlan,
  mergeStates,
  type PersonState,
  type PropertyTimes,
} from "./core.ts";

// The `persons` and `person_distinct_ids` tables. Synchronous: called inside
// the ProjectStore's write transaction. Every statement binds its parameters.

export interface ResolveInput {
  event: string;
  distinctId: string;
  ts: number;
  processPerson: boolean;
  anonDistinctId: string | null;
  alias: string | null;
  set: Readonly<JsonObject>;
  setOnce: Readonly<JsonObject>;
  unset: readonly string[];
}

/**
 * A change the caller makes to the events table in the same transaction, in
 * the order given: a merge moves person `from`'s events to `into`
 * (reassignPerson), then removes `from` (removeMergedPerson), since events
 * reference their person; a link gives `personId` the events of `distinctId`
 * that have no person yet (claimEvents).
 */
export type PersonChange =
  | { kind: "merge"; from: number; into: number }
  | { kind: "link"; distinctId: string; personId: number };

/**
 * The person an event belongs to, and the changes the caller makes to the
 * events table.
 * - processPerson false: the person `distinctId` already belongs to, or
 *   null; nothing is made or changed, and $set, $set_once and $unset are
 *   ignored (identity-04, intake-06).
 * - Otherwise, in order:
 *   1. An $identify with anonDistinctId, or a $create_alias with alias, runs
 *      linkPlan(target distinctId, other anonDistinctId or alias) and carries
 *      it out. A merged person's row is deleted and its distinct ids point to
 *      the person it joined (identity-01, identity-11 to identity-14).
 *   2. The event's person is the one `distinctId` belongs to, made when it has
 *      none, with created_at `ts` and not identified (identity-06). An
 *      $identify marks it identified, with or without $anon_distinct_id, as
 *      posthog-ios sends it with reuseAnonymousId (identity-01).
 *   3. applyPersonOps at `ts` updates that person's properties and
 *      property_times (identity-05, identity-07 to identity-10).
 * Every distinct id this call gave a person yields a link, and every merge a
 * merge, so events stored before the id was known count for the person
 * (identity-01, identity-03, identity-13). $groupidentify and $groups are
 * ordinary: they make no group (identity-16, identity-17).
 */
export function resolvePerson(
  sql: SqlStorage,
  input: ResolveInput,
): { personId: number | null; changes: PersonChange[] } {
  const changes: PersonChange[] = [];

  if (!input.processPerson) {
    return { personId: personOf(sql, input.distinctId), changes };
  }

  const other = joinedId(input);
  if (other !== null) applyLink(sql, input.distinctId, other, input.ts, changes);

  let personId = personOf(sql, input.distinctId);
  if (personId === null) {
    personId = insertPerson(sql, input.ts, input.event === "$identify");
    link(sql, input.distinctId, personId);
    changes.push({ kind: "link", distinctId: input.distinctId, personId });
  } else if (input.event === "$identify") {
    markIdentified(sql, personId);
  }

  if (hasOps(input)) {
    const state = readState(sql, personId);
    writeState(
      sql,
      personId,
      applyPersonOps(
        state,
        { set: input.set, setOnce: input.setOnce, unset: input.unset },
        input.ts,
      ),
    );
  }

  return { personId, changes };
}

/** The id an $identify or $create_alias joins to the event's own id, or null. */
function joinedId(input: ResolveInput): string | null {
  if (input.event === "$identify") return input.anonDistinctId;
  if (input.event === "$create_alias") return input.alias;
  return null;
}

/** Runs linkPlan for the two ids and carries the plan out, recording its changes. */
function applyLink(
  sql: SqlStorage,
  targetId: string,
  otherId: string,
  ts: number,
  changes: PersonChange[],
): void {
  const plan = linkPlan(idSide(sql, targetId), idSide(sql, otherId));

  if (plan.kind === "new person") {
    const personId = insertPerson(sql, ts, true);
    link(sql, targetId, personId);
    link(sql, otherId, personId);
    changes.push(
      { kind: "link", distinctId: targetId, personId },
      { kind: "link", distinctId: otherId, personId },
    );
    return;
  }

  if (plan.kind === "attach") {
    link(sql, plan.distinctId, plan.personId);
    markIdentified(sql, plan.personId);
    changes.push({ kind: "link", distinctId: plan.distinctId, personId: plan.personId });
    return;
  }

  if (plan.kind === "merge") {
    const moved = mergePeople(sql, plan.from, plan.into);
    changes.push({ kind: "merge", from: plan.from, into: plan.into });
    for (const distinctId of moved) {
      changes.push({ kind: "link", distinctId, personId: plan.into });
    }
  }
}

/**
 * Removes a person a merge emptied, once the caller has moved its events
 * (identity-14). Only a person no distinct id points at goes, so a call for a
 * person still in use changes nothing.
 */
export function removeMergedPerson(sql: SqlStorage, personId: number): void {
  sql.exec(
    `DELETE FROM persons WHERE id = ?
       AND NOT EXISTS (SELECT 1 FROM person_distinct_ids WHERE person_id = ?)`,
    personId,
    personId,
  );
}

/** Merges person `from` into `into` and answers the distinct ids that moved. */
function mergePeople(sql: SqlStorage, from: number, into: number): string[] {
  writeState(sql, into, mergeStates(readState(sql, into), readState(sql, from)));
  const moved = sql
    .exec("SELECT distinct_id FROM person_distinct_ids WHERE person_id = ?", from)
    .toArray()
    .map((row) => rowText(row.distinct_id, "person_distinct_ids.distinct_id"));
  sql.exec("UPDATE person_distinct_ids SET person_id = ? WHERE person_id = ?", into, from);
  // The row of `from` stays until the caller has moved its events, which
  // reference it; removeMergedPerson then takes it away (identity-14).
  markIdentified(sql, into);
  return moved;
}

/** A distinct id and the person it belongs to, as linkPlan reads it. */
function idSide(sql: SqlStorage, distinctId: string): IdSide {
  const personId = personOf(sql, distinctId);
  return { distinctId, personId, identified: personId !== null && isIdentified(sql, personId) };
}

/** The person a distinct id belongs to, or null. */
function personOf(sql: SqlStorage, distinctId: string): number | null {
  const row = sql
    .exec("SELECT person_id FROM person_distinct_ids WHERE distinct_id = ?", distinctId)
    .toArray()[0];
  if (row === undefined) return null;
  return rowNumber(row.person_id, "person_distinct_ids.person_id");
}

/** Whether a person is identified. */
function isIdentified(sql: SqlStorage, personId: number): boolean {
  const row = sql.exec("SELECT identified FROM persons WHERE id = ?", personId).toArray()[0];
  if (row === undefined) throw new Error(`person ${personId} is missing`);
  return rowNumber(row.identified, "persons.identified") === 1;
}

/** Makes a person with no properties and answers its id. */
function insertPerson(sql: SqlStorage, createdAt: number, identified: boolean): number {
  const row = sql
    .exec(
      "INSERT INTO persons (created_at, identified) VALUES (?, ?) RETURNING id",
      createdAt,
      identified ? 1 : 0,
    )
    .one();
  return rowNumber(row.id, "persons.id");
}

/** Gives the distinct id the person. The id has none yet, or a merge moved it. */
function link(sql: SqlStorage, distinctId: string, personId: number): void {
  sql.exec(
    "INSERT INTO person_distinct_ids (distinct_id, person_id) VALUES (?, ?)",
    distinctId,
    personId,
  );
}

function markIdentified(sql: SqlStorage, personId: number): void {
  sql.exec("UPDATE persons SET identified = 1 WHERE id = ?", personId);
}

function readState(sql: SqlStorage, personId: number): PersonState {
  const row = sql
    .exec("SELECT properties, property_times FROM persons WHERE id = ?", personId)
    .toArray()[0];
  if (row === undefined) throw new Error(`person ${personId} is missing`);
  return {
    properties: readProperties(row.properties),
    times: readTimes(row.property_times),
  };
}

function writeState(sql: SqlStorage, personId: number, state: PersonState): void {
  sql.exec(
    "UPDATE persons SET properties = ?, property_times = ? WHERE id = ?",
    JSON.stringify(state.properties),
    JSON.stringify(state.times),
    personId,
  );
}

function readProperties(value: SqlStorageValue | undefined): JsonObject {
  const parsed: unknown = JSON.parse(rowText(value, "persons.properties"));
  if (!isJsonObject(parsed)) throw new Error("persons.properties is not a JSON object");
  return parsed;
}

function readTimes(value: SqlStorageValue | undefined): PropertyTimes {
  const parsed: unknown = JSON.parse(rowText(value, "persons.property_times"));
  if (!isJsonObject(parsed)) throw new Error("persons.property_times is not a JSON object");
  const times: PropertyTimes = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (!isJsonObject(entry) || typeof entry.ts !== "number" || typeof entry.once !== "boolean") {
      throw new Error(`persons.property_times has a bad entry for ${key}`);
    }
    times[key] = { ts: entry.ts, once: entry.once };
  }
  return times;
}

function hasOps(input: ResolveInput): boolean {
  return (
    Object.keys(input.set).length > 0 ||
    Object.keys(input.setOnce).length > 0 ||
    input.unset.length > 0
  );
}

// ── Deletion, retention and export (wave 4) ────────────────────────────────

/** The person a distinct id belongs to, with every distinct id linked to it, sorted; null when the id has no person. */
export function personWithIds(
  sql: SqlStorage,
  distinctId: string,
): { personId: number; distinctIds: string[] } | null {
  const row = sql
    .exec("SELECT person_id FROM person_distinct_ids WHERE distinct_id = ?", distinctId)
    .toArray()[0];
  if (row === undefined) return null;
  const personId = rowNumber(row.person_id, "person_distinct_ids.person_id");
  const distinctIds = sql
    .exec(
      "SELECT distinct_id FROM person_distinct_ids WHERE person_id = ? ORDER BY distinct_id",
      personId,
    )
    .toArray()
    .map((linkRow) => rowText(linkRow.distinct_id, "person_distinct_ids.distinct_id"));
  return { personId, distinctIds };
}

/** Deletes a person's distinct ids and then the person, and answers how many of each (privacy-02). */
export function erasePerson(
  sql: SqlStorage,
  personId: number,
): { persons: number; distinctIds: number } {
  // The ids go first, so the person has no linked id by the time it is deleted.
  const distinctIds = sql
    .exec("DELETE FROM person_distinct_ids WHERE person_id = ? RETURNING distinct_id", personId)
    .toArray().length;
  const persons = sql
    .exec("DELETE FROM persons WHERE id = ? RETURNING id", personId)
    .toArray().length;
  return { persons, distinctIds };
}

/**
 * Deletes up to `limit` people with no event left (no events.person_id
 * points at them) and no recording left (no recordings.distinct_id is one of
 * their ids), with their distinct ids, in id order, and answers how many of
 * each (privacy-04, privacy-08). A person with a recording stays. So no
 * person_distinct_ids row and no events.person_id points at a deleted person.
 */
export function prunePersons(
  sql: SqlStorage,
  limit: number,
): { persons: number; distinctIds: number } {
  const ids = sql
    .exec(
      `SELECT id FROM persons
        WHERE NOT EXISTS (SELECT 1 FROM events WHERE events.person_id = persons.id)
          AND NOT EXISTS (
            SELECT 1 FROM person_distinct_ids
              JOIN recordings ON recordings.distinct_id = person_distinct_ids.distinct_id
             WHERE person_distinct_ids.person_id = persons.id)
        ORDER BY id
        LIMIT ?`,
      limit,
    )
    .toArray()
    .map((row) => rowNumber(row.id, "persons.id"));

  let persons = 0;
  let distinctIds = 0;
  for (const run of runsOf(ids, BOUND_PARAMETERS_MAX)) {
    const placeholders = run.map(() => "?").join(", ");
    distinctIds += sql
      .exec(
        `DELETE FROM person_distinct_ids WHERE person_id IN (${placeholders}) RETURNING distinct_id`,
        ...run,
      )
      .toArray().length;
    persons += sql
      .exec(`DELETE FROM persons WHERE id IN (${placeholders}) RETURNING id`, ...run)
      .toArray().length;
  }
  return { persons, distinctIds };
}

/**
 * One export page of `persons` (privacy-22, privacy-25): an ExportPage of up
 * to `limit` rows with a rowid above `after`, by rowid, each one JSON line of
 * its columns by name, properties and property_times as their JSON objects.
 * `next` is the last row's rowid when the page holds `limit` rows, else null.
 */
/** The columns a persons export writes, and an import reads back (privacy-22, privacy-30). */
export const PERSONS_SHAPE: ExportShape = {
  table: "persons",
  columns: ["id", "created_at", "identified", "properties", "property_times"],
  json: ["properties", "property_times"],
};

/** The columns a person_distinct_ids export writes, and an import reads back. */
export const DISTINCT_IDS_SHAPE: ExportShape = {
  table: "person_distinct_ids",
  columns: ["distinct_id", "person_id"],
  json: [],
};

export function exportPersons(sql: SqlStorage, after: number, limit: number): ExportPage {
  const page = sql
    .exec(
      `SELECT rowid AS row_id, ${PERSONS_SHAPE.columns.join(", ")}
         FROM persons WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      after,
      limit,
    )
    .toArray();
  const lines = page.map((row) => {
    const properties: unknown = JSON.parse(rowText(row.properties, "persons.properties"));
    const propertyTimes: unknown = JSON.parse(
      rowText(row.property_times, "persons.property_times"),
    );
    const columns: Record<string, unknown> = {
      ...row,
      properties,
      property_times: propertyTimes,
    };
    delete columns.row_id;
    return JSON.stringify(columns);
  });
  return { lines, next: exportCursor(page, limit) };
}

/** One export page of `person_distinct_ids`, as exportPersons pages (privacy-22, privacy-25). */
export function exportDistinctIds(sql: SqlStorage, after: number, limit: number): ExportPage {
  const page = sql
    .exec(
      `SELECT rowid AS row_id, ${DISTINCT_IDS_SHAPE.columns.join(", ")}
         FROM person_distinct_ids WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      after,
      limit,
    )
    .toArray();
  const lines = page.map((row) => {
    const columns: Record<string, unknown> = { ...row };
    delete columns.row_id;
    return JSON.stringify(columns);
  });
  return { lines, next: exportCursor(page, limit) };
}
