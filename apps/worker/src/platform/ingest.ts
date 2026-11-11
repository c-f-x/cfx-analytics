import type { ErasedCounts, ExportPage, ExportTable, ProjectSettings } from "@cfanalytics/shared";
import { EXPORT_PAGE_ROWS } from "@cfanalytics/shared";
import {
  cookielessId,
  hashDay,
  type SaltError,
  saltExpiry,
  saltForDay,
  sessionFor,
} from "../features/cookieless/index.ts";
import {
  capDay,
  claimEvents,
  EVENTS_SHAPE,
  type EventInsert,
  eraseEvents,
  exportEvents,
  type InsertError,
  insertEvents,
  reassignPerson,
  returnToCap,
  storedUuids,
  storeIsFull,
  takeFromCap,
  takeWholeFromCap,
} from "../features/events/index.ts";
import {
  erasePoints,
  exportPoints,
  type HeatmapPointInput,
  insertPoints,
  POINTS_SHAPE,
  storedPointEvents,
} from "../features/heatmaps/index.ts";
import {
  DISTINCT_IDS_SHAPE,
  erasePerson as erasePersonRows,
  exportDistinctIds,
  exportPersons,
  PERSONS_SHAPE,
  type PersonChange,
  personWithIds,
  removeMergedPerson,
  resolvePerson,
} from "../features/identity/index.ts";
import type { IncomingEvent } from "../features/intake/index.ts";
import {
  CHUNKS_SHAPE,
  type ChunkMeta,
  deleteChunkRows,
  deleteObjects,
  exportChunks,
  exportRecordings,
  hasChunk,
  objectKey,
  putChunk,
  RECORDINGS_SHAPE,
  recordChunk,
  recordingsOf,
} from "../features/recordings/index.ts";
import { err, messageOf, ok, type Result } from "./result.ts";
import { type ExportShape, importRowsOf } from "./rows.ts";
import { insertImportRows, recordProjectId } from "./schema.ts";

// What happens inside a ProjectStore when a batch or a recording chunk
// arrives (architecture.md, "An event", step 5, and "A recording chunk").
// This file calls several slices' table functions in one place, because one
// transaction holds them all; each slice still owns its own SQL. A deletion
// by person and an export page are here too, for the same reason. The daily
// sweep and the purge are in sweep.ts.

export interface IngestRequest {
  projectId: string;
  /** The Worker's clock when the request arrived (intake-37). The cap's day and salt expiry are read from it. */
  receivedAt: number;
  settings: Pick<ProjectSettings, "daily_event_cap" | "timezone">;
  /** CF-Connecting-IP, for cookieless hashing only; never stored (intake-07, cookieless-16). */
  clientIp: string | null;
  /** In the order the SDK sent them. */
  events: IncomingEvent[];
  /**
   * The points of the batch's $$heatmap events, which make no event row
   * (intake-19, heatmaps-01). Empty with heatmaps off (heatmaps-05).
   */
  points: HeatmapPointInput[];
}

export interface IngestAnswer {
  /** Rows the batch added to `events`. */
  stored: number;
  /** True when the cap or the store's size left out any event (events-02, events-03, events-12). */
  quotaLimited: boolean;
}

/** What the ProjectStore passes in, so a test can pass its own. */
export interface IngestSources {
  /** 16 random bytes for a new day's salt. */
  makeSalt: () => Uint8Array;
  /** A new id for a server-made cookieless session. */
  newSessionId: () => string;
  /** The store's database size in bytes, read before the batch (events-12). */
  databaseSize: number;
}

/** A batch that failed as a whole: nothing of it was written, and the Worker answers 503. */
export type IngestError = SaltError | InsertError;

/**
 * One batch in one transactionSync. Any failure rolls back every write of the
 * batch, the counter included, and answers the error (cookieless-17,
 * events-13, intake-28).
 * 1. When storeIsFull(databaseSize), write nothing and answer
 *    { stored: 0, quotaLimited: true } (events-12).
 * 2. Keep the first event of each uuid in the batch, and leave out uuids
 *    already stored (storedUuids), so a retry stores and counts nothing twice
 *    (intake-03, events-05, events-10). Leave out cookieless events when
 *    clientIp is null (cookieless-16).
 * 3. Take what is left from the "events" counter of capDay(receivedAt,
 *    settings.timezone) with takeFromCap. Keep the first ones granted, in
 *    batch order, and drop the rest; any dropped makes quotaLimited
 *    (events-01 to events-04, events-07, intake-09).
 * 4. Cookieless events, in event-time order so batch order never decides a
 *    session (cookieless-06): the salt of hashDay (saltForDay, with
 *    saltExpiry and makeSalt), the id from cookielessId with the project id,
 *    clientIp, hashHost and hashUserAgent, and the session from sessionFor
 *    with sources.newSessionId, which it calls only for a session it starts.
 *    The id replaces distinctId and the session replaces
 *    sessionId. They get no person and are never passed to identity
 *    (cookieless-01, cookieless-07, identity-19).
 * 5. Other events, in batch order: their person from resolvePerson; their
 *    sessionId as sent (cookieless-12, cookieless-13).
 * 6. insertEvents with every row; then, in the order they were returned,
 *    each merge through reassignPerson and each link through claimEvents, so
 *    rows of this batch are moved too (identity-01, identity-03).
 * 7. The batch's $$heatmap events, one per distinct eventUuid of
 *    request.points in order, leaving out those whose points are already
 *    stored, each take one from the same "events" counter after the events
 *    of step 3, so the cap bounds points too. The points of one not granted
 *    are left out and make quotaLimited (heatmaps-21). insertPoints with the
 *    points granted; a heatmap event sent again stores its points once
 *    (heatmaps-01, heatmaps-13). A full store (step 1) stores none (events-12).
 * Answers how many rows insertEvents added.
 */
export function ingestBatch(
  storage: DurableObjectStorage,
  request: IngestRequest,
  sources: IngestSources,
): Result<IngestAnswer, IngestError> {
  if (storeIsFull(sources.databaseSize)) return ok({ stored: 0, quotaLimited: true });

  return transactionResult(storage, () => storeBatch(storage.sql, request, sources));
}

/**
 * Runs `work` in one transactionSync. When it answers an error, every write
 * it made is rolled back and the error is answered as a value, the counter
 * included (events-13, cookieless-17, recordings-17). A throw nobody planned
 * for still throws.
 */
function transactionResult<T, E>(
  storage: DurableObjectStorage,
  work: () => Result<T, E>,
): Result<T, E> {
  let answer: Result<T, E> | null = null;
  try {
    storage.transactionSync(() => {
      answer = work();
      // Throwing out of the transaction is what rolls its writes back.
      if (!answer.ok) throw new RolledBack();
    });
  } catch (error) {
    if (!(error instanceof RolledBack)) throw error;
  }
  if (answer === null) throw new Error("the transaction answered nothing");
  return answer;
}

/** Thrown only to roll a transaction back; its answer is kept beside it. */
class RolledBack extends Error {}

/** The batch's writes, inside the caller's transaction. */
function storeBatch(
  sql: SqlStorage,
  request: IngestRequest,
  sources: IngestSources,
): Result<IngestAnswer, IngestError> {
  const candidates = storableEvents(sql, request);
  const day = capDay(request.receivedAt, request.settings.timezone);
  const granted = takeFromCap(
    sql,
    day,
    "events",
    request.settings.daily_event_cap,
    candidates.length,
  );
  const kept = candidates.slice(0, granted);
  const eventsRefused = granted < candidates.length;

  const hashes = cookielessHashes(sql, request, kept, sources);
  if (!hashes.ok) return hashes;
  const hashedIds = hashes.value;

  const { persons, changes } = resolvePersons(sql, kept);

  const rows: EventInsert[] = kept.map((event) => {
    const hash = hashedIds.get(event.uuid);
    return {
      uuid: event.uuid,
      event: event.event,
      distinctId: hash?.distinctId ?? event.distinctId,
      personId: persons.get(event.uuid) ?? null,
      sessionId: hash?.sessionId ?? event.sessionId,
      ts: event.ts,
      receivedAt: request.receivedAt,
      bot: event.bot,
      page: event.page,
      properties: event.properties,
    };
  });

  const inserted = insertEvents(sql, rows);
  if (!inserted.ok) return inserted;

  // After the insert, so the batch's own rows move with their person too
  // (identity-01, identity-03).
  for (const change of changes) {
    if (change.kind === "merge") {
      reassignPerson(sql, change.from, change.into);
      removeMergedPerson(sql, change.from);
    } else {
      claimEvents(sql, change.distinctId, change.personId);
    }
  }

  // Each heatmap event with points takes one from the same cap after the
  // batch's events, so the cap bounds points too (heatmaps-21).
  const heatmapUuids = heatmapEventUuids(request.points);
  const storedHeatmaps = storedPointEvents(sql, heatmapUuids);
  const pendingHeatmaps = heatmapUuids.filter((eventUuid) => !storedHeatmaps.has(eventUuid));
  // One take for them all: the cap grants the first ones, in batch order.
  const heatmapsGranted = takeFromCap(
    sql,
    day,
    "events",
    request.settings.daily_event_cap,
    pendingHeatmaps.length,
  );
  const grantedHeatmaps = new Set(pendingHeatmaps.slice(0, heatmapsGranted));
  const heatmapsRefused = heatmapsGranted < pendingHeatmaps.length;
  const grantedPoints = request.points.filter((point) => grantedHeatmaps.has(point.eventUuid));
  if (grantedPoints.length > 0) insertPoints(sql, grantedPoints);

  return ok({ stored: inserted.value, quotaLimited: eventsRefused || heatmapsRefused });
}

/**
 * The batch's $$heatmap events in the order their points appear: one entry
 * per distinct event uuid (heatmaps-21).
 */
function heatmapEventUuids(points: readonly HeatmapPointInput[]): string[] {
  const uuids: string[] = [];
  const seen = new Set<string>();
  for (const point of points) {
    if (seen.has(point.eventUuid)) continue;
    seen.add(point.eventUuid);
    uuids.push(point.eventUuid);
  }
  return uuids;
}

/**
 * The batch's events that may be stored, in batch order: the first of each
 * uuid, none already stored, and no cookieless event without a client IP
 * (intake-03, cookieless-16, events-05, events-10).
 */
function storableEvents(sql: SqlStorage, request: IngestRequest): IncomingEvent[] {
  const seen = new Set<string>();
  const candidates: IncomingEvent[] = [];
  for (const event of request.events) {
    if (seen.has(event.uuid)) continue;
    seen.add(event.uuid);
    if (event.cookieless && request.clientIp === null) continue;
    candidates.push(event);
  }

  const stored = storedUuids(
    sql,
    candidates.map((event) => event.uuid),
  );
  return candidates.filter((event) => !stored.has(event.uuid));
}

/**
 * Each cookieless event's stored distinct id and session, by uuid
 * (cookieless-01, cookieless-06 to cookieless-10).
 */
function cookielessHashes(
  sql: SqlStorage,
  request: IngestRequest,
  events: readonly IncomingEvent[],
  sources: IngestSources,
): Result<Map<string, { distinctId: string; sessionId: string }>, SaltError> {
  const hashes = new Map<string, { distinctId: string; sessionId: string }>();
  // Event time decides a session, never batch order (cookieless-06).
  const ordered = events
    .filter((event) => event.cookieless)
    .toSorted((left, right) => left.ts - right.ts);
  if (ordered.length === 0) return ok(hashes);

  const { clientIp } = request;
  // storableEvents left out every cookieless event of a batch without an IP
  // (cookieless-16), so reaching here with one means the IP is present.
  if (clientIp === null)
    throw new Error("a cookieless event reached the store without a client IP");

  for (const event of ordered) {
    const day = hashDay(event.ts, request.receivedAt, event.timezone, request.settings.timezone);
    const salt = saltForDay(sql, day, saltExpiry(day), request.receivedAt, sources.makeSalt);
    if (!salt.ok) return salt;

    const distinctId = cookielessId({
      salt: salt.value,
      projectId: request.projectId,
      ip: clientIp,
      host: event.hashHost ?? "",
      userAgent: event.hashUserAgent ?? "",
    });
    hashes.set(event.uuid, {
      distinctId,
      sessionId: sessionFor(sql, distinctId, day, event.ts, sources.newSessionId),
    });
  }
  return ok(hashes);
}

/**
 * Each non-cookieless event's person, by uuid, and the person changes the
 * batch makes, in the order it makes them (identity-01 to identity-19).
 */
function resolvePersons(
  sql: SqlStorage,
  events: readonly IncomingEvent[],
): { persons: Map<string, number | null>; changes: PersonChange[] } {
  const persons = new Map<string, number | null>();
  const changes: PersonChange[] = [];
  for (const event of events) {
    if (event.cookieless) continue;
    const resolved = resolvePerson(sql, {
      event: event.event,
      distinctId: event.distinctId,
      ts: event.ts,
      processPerson: event.processPerson,
      anonDistinctId: event.anonDistinctId,
      alias: event.alias,
      set: event.set,
      setOnce: event.setOnce,
      unset: event.unset,
    });
    persons.set(event.uuid, resolved.personId);
    changes.push(...resolved.changes);
  }
  return { persons, changes };
}

/** One recording chunk as the Worker prepared it (architecture.md, "A recording chunk", steps 1 to 3). */
export interface SnapshotChunk {
  /** The $snapshot event's uuid, a UUID (recordings-12). */
  uuid: string;
  /** isSessionId (recordings-08). */
  sessionId: string;
  distinctId: string;
  /** The chunk's scrubbed rrweb events as gzip NDJSON (recordings-09, recordings-25). */
  gzipped: Uint8Array;
  meta: ChunkMeta;
}

export interface SnapshotRequest {
  projectId: string;
  /** The Worker's clock when the request arrived. The cap's day and the object keys read it. */
  receivedAt: number;
  settings: Pick<ProjectSettings, "daily_recording_bytes_cap" | "timezone">;
  /** In the order the SDK sent them. */
  chunks: SnapshotChunk[];
}

export interface SnapshotAnswer {
  /** Chunks written to R2 and recorded by this call. */
  stored: number;
  /** True when the bytes cap refused any chunk (recordings-03, recordings-10). */
  quotaLimited: boolean;
}

/** A request that failed part way: the chunks before the one named are stored, and the Worker answers 503. */
export type SnapshotError =
  | { kind: "r2 failed"; uuid: string }
  | { kind: "row refused"; uuid: string; message: string };

/**
 * Stores a request's chunks, one after another, in the order sent (D-13,
 * D-20). For each chunk:
 * 1. Skipped when hasChunk(uuid), or when `inFlight` holds its uuid, which
 *    another call of this object is writing now, so a retry or a duplicate
 *    sent at once stores and counts nothing twice (recordings-12). Else its
 *    uuid joins `inFlight` until this chunk is done, whatever the outcome.
 * 2. Its gzip bytes taken whole from the "recording_bytes" counter of
 *    capDay(receivedAt, settings.timezone) with takeWholeFromCap under
 *    daily_recording_bytes_cap, in its own transaction before any R2 write,
 *    so two calls never both take the last bytes (recordings-03,
 *    recordings-10, recordings-30). Refused: nothing is written for it,
 *    quotaLimited, and the next chunk is tried. The events counter is never
 *    touched (recordings-11).
 * 3. putChunk under objectKey(projectId, sessionId, receivedAt, uuid)
 *    (recordings-07). A failure gives the bytes back with returnToCap and
 *    answers "r2 failed".
 * 4. recordChunk in one transaction. A refusal answers "row refused" and
 *    leaves the object for the orphan sweep, its bytes still counted
 *    (recordings-17).
 * The store's database size is not read: a full store still takes
 * recordings, whose bodies live in R2 (events-12).
 */
export async function ingestSnapshots(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  request: SnapshotRequest,
  inFlight: Set<string>,
): Promise<Result<SnapshotAnswer, SnapshotError>> {
  const sql = storage.sql;
  const day = capDay(request.receivedAt, request.settings.timezone);
  let stored = 0;
  let quotaLimited = false;

  for (const chunk of request.chunks) {
    if (hasChunk(sql, chunk.uuid) || inFlight.has(chunk.uuid)) continue;
    // Held until this chunk is done, whatever its outcome, so a duplicate
    // sent while it writes sees it (recordings-12).
    inFlight.add(chunk.uuid);
    try {
      const bytes = chunk.gzipped.byteLength;
      const taken = storage.transactionSync(() =>
        takeWholeFromCap(
          sql,
          day,
          "recording_bytes",
          request.settings.daily_recording_bytes_cap,
          bytes,
        ),
      );
      if (!taken) {
        quotaLimited = true;
        continue;
      }

      const key = objectKey(request.projectId, chunk.sessionId, request.receivedAt, chunk.uuid);
      const written = await putChunk(bucket, key, chunk.gzipped);
      if (!written.ok) {
        storage.transactionSync(() => returnToCap(sql, day, "recording_bytes", bytes));
        return err({ kind: "r2 failed", uuid: chunk.uuid });
      }

      // Both rows in one transaction that rolls back whole (recordings-17).
      const recorded = transactionResult(storage, () =>
        recordChunk(sql, {
          uuid: chunk.uuid,
          sessionId: chunk.sessionId,
          distinctId: chunk.distinctId,
          objectKey: key,
          receivedAt: request.receivedAt,
          bytes,
          ...chunk.meta,
        }),
      );
      if (!recorded.ok) {
        return err({ kind: "row refused", uuid: chunk.uuid, message: recorded.error.message });
      }
      stored += 1;
    } finally {
      inFlight.delete(chunk.uuid);
    }
  }

  return ok({ stored, quotaLimited });
}

/** A deletion by person that deleted no row: these R2 objects could not be deleted (privacy-19). */
export type EraseError = { kind: "r2 failed"; keys: string[] };

/**
 * Deletes everything of the person behind a distinct id (privacy-02,
 * privacy-05, privacy-16, privacy-17, privacy-19):
 * 1. The person's distinct ids from personWithIds (identity), or the one id
 *    given when it has no person.
 * 2. Their recordings (recordingsOf) and every chunk's R2 object, with
 *    deleteObjects. When any delete fails, no row is deleted and the answer
 *    names the failed keys; a repeat finishes the work, since deleting an
 *    object already gone succeeds.
 * 3. Then in one transactionSync: eraseEvents (the person's, and those of
 *    its ids with no person), erasePoints, deleteChunkRows of every key,
 *    and erasePerson (identity) when there is a person.
 * Answers the count per table and the objects deleted, zeros included; an
 * unknown id, or the same deletion again, answers all zeros (privacy-17).
 */
export async function erasePerson(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  distinctId: string,
): Promise<Result<ErasedCounts, EraseError>> {
  const sql = storage.sql;
  const person = personWithIds(sql, distinctId);
  const personId = person?.personId ?? null;
  const distinctIds = person?.distinctIds ?? [distinctId];

  // Objects go first, so a failed delete leaves every row in place for the
  // repeat (privacy-19).
  const keys = recordingsOf(sql, distinctIds).flatMap((recording) => recording.objectKeys);
  const objects = await deleteObjects(bucket, keys);
  if (objects.failed.length > 0) return err({ kind: "r2 failed", keys: objects.failed });

  return transactionResult(storage, () => {
    // Rows go in the order the foreign keys allow: the events that name the
    // person, then the recordings and points, then the person itself.
    const events = eraseEvents(sql, personId, distinctIds);
    const chunks = deleteChunkRows(sql, keys);
    const points = erasePoints(sql, distinctIds);
    const rows =
      personId === null ? { persons: 0, distinctIds: 0 } : erasePersonRows(sql, personId);
    return ok({
      events,
      persons: rows.persons,
      person_distinct_ids: rows.distinctIds,
      recordings: chunks.recordings,
      recording_chunks: chunks.chunks,
      heatmap_points: points,
      objects: objects.deleted,
    });
  });
}

/**
 * One export page of `table` (privacy-22, privacy-25): the owning slice's
 * export function (exportEvents, exportPersons, exportDistinctIds,
 * exportRecordings, exportChunks, exportPoints) with `after` and
 * EXPORT_PAGE_ROWS. Read only.
 */
export function exportPage(sql: SqlStorage, table: ExportTable, after: number): ExportPage {
  const pages: Record<ExportTable, (store: SqlStorage, cursor: number) => ExportPage> = {
    events: (store, cursor) => exportEvents(store, cursor, EXPORT_PAGE_ROWS),
    persons: (store, cursor) => exportPersons(store, cursor, EXPORT_PAGE_ROWS),
    person_distinct_ids: (store, cursor) => exportDistinctIds(store, cursor, EXPORT_PAGE_ROWS),
    recordings: (store, cursor) => exportRecordings(store, cursor, EXPORT_PAGE_ROWS),
    recording_chunks: (store, cursor) => exportChunks(store, cursor, EXPORT_PAGE_ROWS),
    heatmap_points: (store, cursor) => exportPoints(store, cursor, EXPORT_PAGE_ROWS),
  };
  return pages[table](sql, after);
}

/** Each exported table's shape, so an import reads back what the export wrote (privacy-30). */
const IMPORT_SHAPES: Record<ExportTable, ExportShape> = {
  events: EVENTS_SHAPE,
  persons: PERSONS_SHAPE,
  person_distinct_ids: DISTINCT_IDS_SHAPE,
  recordings: RECORDINGS_SHAPE,
  recording_chunks: CHUNKS_SHAPE,
  heatmap_points: POINTS_SHAPE,
};

/** Why an import was refused: the first line that is not a row of its table (privacy-31). */
export type ImportRefusal =
  | { kind: "bad line"; line: number; reason: string }
  /** A row names a person or recording not stored yet: the tables came out of IMPORT_ORDER. */
  | { kind: "missing parent" };

/**
 * One import request into this store (privacy-30, privacy-31): every line
 * read back as a row of `table` first, and nothing stored unless all are.
 * Then, in one transaction, the project id is recorded, as the first capture
 * would, and the rows are inserted, those already stored skipped. Answers how
 * many were added; a row naming a person or recording not yet stored is
 * "missing parent", with nothing stored. Any other failure throws on to the
 * route, which answers 503.
 */
export function importPage(
  storage: DurableObjectStorage,
  projectId: string,
  table: ExportTable,
  lines: readonly unknown[],
): Result<number, ImportRefusal> {
  const shape = IMPORT_SHAPES[table];
  const read = importRowsOf(shape, lines);
  if (!read.ok) return err({ kind: "bad line", line: read.line, reason: read.reason });
  try {
    return ok(
      storage.transactionSync(() => {
        recordProjectId(storage.sql, projectId);
        return insertImportRows(storage.sql, shape, read.rows);
      }),
    );
  } catch (cause) {
    // The transaction rolled back, so nothing of the request is stored.
    if (messageOf(cause).includes("FOREIGN KEY")) return err({ kind: "missing parent" });
    throw cause;
  }
}
