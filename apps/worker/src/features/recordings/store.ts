import {
  BOUND_PARAMETERS_MAX,
  type ExportPage,
  R2_DELETE_KEYS_MAX,
  type RecordingSummary,
  WIDTH_BAND_PX,
} from "@cfanalytics/shared";
import { err, messageOf, ok, type Result } from "../../platform/result.ts";
import {
  type ExportShape,
  exportCursor,
  rowNumber,
  rowNumberOrNull,
  rowText,
  rowTextOrNull,
} from "../../platform/rows.ts";
import { runsOf } from "../../platform/runs.ts";
import type { ChunkMeta, ListQuery } from "./core.ts";

// The `recordings` and `recording_chunks` tables, which only the ProjectStore
// writes (D-13), and the R2 objects behind them. Table functions are
// synchronous, for the ProjectStore's transactions, and bind every parameter.
// R2 functions are async and take the bucket as a parameter. Retention,
// orphans, deletion by person and export are wave 4's (the sweep, ingest.ts).

/** One chunk's row, as the ProjectStore records it after its R2 write. */
export interface ChunkRow extends ChunkMeta {
  uuid: string;
  sessionId: string;
  distinctId: string;
  objectKey: string;
  receivedAt: number;
  /** The gzip bytes written to R2 (recordings-30). */
  bytes: number;
}

/** A chunk as playback reads it. */
export interface ChunkRef {
  uuid: string;
  objectKey: string;
}

/** The newest full snapshot of a page in a width band (heatmaps-02). */
export interface SnapshotRef {
  sessionId: string;
  objectKey: string;
  width: number;
}

/** Whether a chunk with this uuid is recorded, so a retry stores and counts nothing twice (recordings-12). */
export function hasChunk(sql: SqlStorage, uuid: string): boolean {
  return sql.exec("SELECT 1 FROM recording_chunks WHERE uuid = ?", uuid).toArray().length > 0;
}

/**
 * Records one chunk: its recording's row first, made with the chunk's
 * distinct id when the session has none, else folded in (start the least
 * firstTs, end the greatest lastTs; activeMs, clicks, keypresses and bytes
 * added; first_url taken from the chunk when the row has none or the chunk
 * starts earlier and has one), then the chunk's row with its snapshot path
 * and width (recordings-05, recordings-27, recordings-28, recordings-30).
 * The person is not written: listRecordings reads it through the distinct
 * id (recordings-29). A statement the tables refuse is "row refused", and
 * the caller rolls its transaction back (recordings-17).
 */
export function recordChunk(
  sql: SqlStorage,
  chunk: ChunkRow,
): Result<void, { kind: "row refused"; uuid: string; message: string }> {
  try {
    // The SET expressions read the row's values from before the update, so
    // first_url compares the new chunk with the recording's old start.
    sql.exec(
      `INSERT INTO recordings (
         session_id, distinct_id, start_ts, end_ts, active_ms, first_url,
         clicks, keypresses, bytes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id) DO UPDATE SET
         start_ts = MIN(recordings.start_ts, excluded.start_ts),
         end_ts = MAX(recordings.end_ts, excluded.end_ts),
         active_ms = recordings.active_ms + excluded.active_ms,
         clicks = recordings.clicks + excluded.clicks,
         keypresses = recordings.keypresses + excluded.keypresses,
         bytes = recordings.bytes + excluded.bytes,
         first_url = CASE
           WHEN recordings.first_url IS NULL THEN excluded.first_url
           WHEN excluded.first_url IS NOT NULL AND excluded.start_ts < recordings.start_ts
             THEN excluded.first_url
           ELSE recordings.first_url
         END`,
      chunk.sessionId,
      chunk.distinctId,
      chunk.firstTs,
      chunk.lastTs,
      chunk.activeMs,
      chunk.firstUrl,
      chunk.clicks,
      chunk.keypresses,
      chunk.bytes,
    );
    sql.exec(
      `INSERT INTO recording_chunks (
         uuid, session_id, object_key, first_ts, last_ts, received_at, bytes,
         snapshot_path, snapshot_width
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      chunk.uuid,
      chunk.sessionId,
      chunk.objectKey,
      chunk.firstTs,
      chunk.lastTs,
      chunk.receivedAt,
      chunk.bytes,
      chunk.snapshotPath,
      chunk.snapshotWidth,
    );
  } catch (cause) {
    return err({ kind: "row refused", uuid: chunk.uuid, message: messageOf(cause) });
  }
  return ok(undefined);
}

/**
 * A session's chunks in play order: first_ts, then received_at, then uuid
 * (recordings-01, recordings-14). Only that session's; empty for an unknown
 * one (recordings-15).
 */
export function chunksOf(sql: SqlStorage, sessionId: string): ChunkRef[] {
  return sql
    .exec(
      `SELECT uuid, object_key FROM recording_chunks
       WHERE session_id = ?
       ORDER BY first_ts, received_at, uuid`,
      sessionId,
    )
    .toArray()
    .map((row) => ({
      uuid: rowText(row.uuid, "uuid"),
      objectKey: rowText(row.object_key, "object_key"),
    }));
}

/**
 * One page of the recording list, newest start first, after `query.before`
 * when paging, with every filter of `query.filters` that is given
 * (recordings-34): the person's recordings under any of their distinct ids
 * (or that id's alone when it has no person), a session with an event on
 * that page or of that name (events_session), a recording at least that
 * long. Each row names its session's distinct pages in order of first visit
 * (recordings-35). The person is read through the recording's distinct id
 * now, so an identify after the recording began counts (recordings-29).
 */
export function listRecordings(sql: SqlStorage, query: ListQuery): RecordingSummary[] {
  const conditions: string[] = [];
  const bindings: SqlStorageValue[] = [];
  if (query.before !== null) {
    conditions.push("(r.start_ts < ? OR (r.start_ts = ? AND r.session_id < ?))");
    bindings.push(query.before.startTs, query.before.startTs, query.before.sessionId);
  }
  const { person, page, event, minDurationMs } = query.filters;
  if (person !== null) {
    conditions.push(`(r.distinct_id = ? OR r.distinct_id IN (
      SELECT ids.distinct_id FROM person_distinct_ids ids
       WHERE ids.person_id = (SELECT person_id FROM person_distinct_ids WHERE distinct_id = ?)))`);
    bindings.push(person, person);
  }
  if (page !== null) {
    conditions.push(
      "EXISTS (SELECT 1 FROM events e WHERE e.session_id = r.session_id AND e.page = ?)",
    );
    bindings.push(page);
  }
  if (event !== null) {
    conditions.push(
      "EXISTS (SELECT 1 FROM events e WHERE e.session_id = r.session_id AND e.event = ?)",
    );
    bindings.push(event);
  }
  if (minDurationMs !== null) {
    conditions.push("r.end_ts - r.start_ts >= ?");
    bindings.push(minDurationMs);
  }
  const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
  bindings.push(query.limit);
  return sql
    .exec(
      `SELECT r.session_id, r.distinct_id, r.start_ts, r.end_ts, r.active_ms,
              r.first_url, r.clicks, r.keypresses, r.bytes, p.person_id,
              (SELECT json_group_array(page) FROM (
                 SELECT e.page AS page FROM events e
                  WHERE e.session_id = r.session_id AND e.page IS NOT NULL
                  GROUP BY e.page ORDER BY MIN(e.ts), MIN(e.id))) AS pages
       FROM recordings r
       LEFT JOIN person_distinct_ids p ON p.distinct_id = r.distinct_id
       ${where}
       ORDER BY r.start_ts DESC, r.session_id DESC
       LIMIT ?`,
      ...bindings,
    )
    .toArray()
    .map((row) => {
      const startTs = rowNumber(row.start_ts, "start_ts");
      const endTs = rowNumber(row.end_ts, "end_ts");
      return {
        sessionId: rowText(row.session_id, "session_id"),
        distinctId: rowTextOrNull(row.distinct_id, "distinct_id"),
        personId: rowNumberOrNull(row.person_id, "person_id"),
        startTs,
        endTs,
        durationMs: endTs - startTs,
        activeMs: rowNumber(row.active_ms, "active_ms"),
        firstUrl: rowTextOrNull(row.first_url, "first_url"),
        clicks: rowNumber(row.clicks, "clicks"),
        keypresses: rowNumber(row.keypresses, "keypresses"),
        bytes: rowNumber(row.bytes, "bytes"),
        pages: pagesOf(row.pages),
      };
    });
}

/** The JSON array of page keys the list's subquery builds. */
function pagesOf(value: SqlStorageValue | undefined): string[] {
  const parsed: unknown = JSON.parse(rowText(value, "pages"));
  if (!Array.isArray(parsed)) throw new Error("pages is not an array");
  return parsed.filter((page): page is string => typeof page === "string");
}

/**
 * The chunk with the greatest last_ts whose snapshot_path is `path` and whose
 * snapshot_width is in [widthBand, widthBand + WIDTH_BAND_PX), or null
 * (heatmaps-02).
 */
export function latestSnapshot(
  sql: SqlStorage,
  path: string,
  widthBand: number,
): SnapshotRef | null {
  const row = sql
    .exec(
      `SELECT session_id, object_key, snapshot_width FROM recording_chunks
       WHERE snapshot_path = ? AND snapshot_width >= ? AND snapshot_width < ?
       ORDER BY last_ts DESC, received_at DESC, uuid DESC
       LIMIT 1`,
      path,
      widthBand,
      widthBand + WIDTH_BAND_PX,
    )
    .toArray()[0];
  if (row === undefined) return null;
  return {
    sessionId: rowText(row.session_id, "session_id"),
    objectKey: rowText(row.object_key, "object_key"),
    width: rowNumber(row.snapshot_width, "snapshot_width"),
  };
}

// ── Retention, deletion by person and export (wave 4) ──────────────────────

/** A recording and the R2 keys of its chunks. */
export interface RecordingKeys {
  sessionId: string;
  objectKeys: string[];
}

/**
 * Recordings whose end_ts, their newest chunk's end, is before `cutoffTs`,
 * oldest end first, with their chunks' keys, holding at most `limit` chunks
 * in all; a recording is never split across calls unless it alone holds more
 * than `limit` (privacy-12, privacy-27).
 */
export function expiredRecordings(
  sql: SqlStorage,
  cutoffTs: number,
  limit: number,
): RecordingKeys[] {
  // A recording is taken whole, so the batch never splits one across passes.
  const rows = sql
    .exec(
      `SELECT r.session_id, COUNT(c.uuid) AS chunks
         FROM recordings r
         LEFT JOIN recording_chunks c ON c.session_id = r.session_id
        WHERE r.end_ts < ?
        GROUP BY r.session_id
        ORDER BY r.end_ts, r.session_id
        LIMIT ?`,
      cutoffTs,
      // Every recording row keeps a chunk (deleteChunkRows takes the row with
      // its last chunk), so a batch of `limit` chunks never needs more sessions.
      limit,
    )
    .toArray();

  const chosen: string[] = [];
  let chunksTaken = 0;
  for (const row of rows) {
    const count = rowNumber(row.chunks, "chunks");
    if (chosen.length > 0 && chunksTaken + count > limit) break;
    chosen.push(rowText(row.session_id, "session_id"));
    chunksTaken += count;
    if (chunksTaken >= limit) break;
  }
  return keysOfSessions(sql, chosen);
}

/** The recordings whose distinct_id is one of `distinctIds`, with their chunks' keys (privacy-05). */
export function recordingsOf(sql: SqlStorage, distinctIds: readonly string[]): RecordingKeys[] {
  const sessions: string[] = [];
  for (const run of runsOf(distinctIds, BOUND_PARAMETERS_MAX)) {
    const placeholders = run.map(() => "?").join(", ");
    const rows = sql
      .exec(
        `SELECT session_id FROM recordings WHERE distinct_id IN (${placeholders})
         ORDER BY session_id`,
        ...run,
      )
      .toArray();
    for (const row of rows) sessions.push(rowText(row.session_id, "session_id"));
  }
  return keysOfSessions(sql, [...new Set(sessions)]);
}

/** Each session's chunk keys, in play order, one entry per session given. */
function keysOfSessions(sql: SqlStorage, sessions: readonly string[]): RecordingKeys[] {
  const keys = new Map<string, string[]>(sessions.map((sessionId) => [sessionId, []]));
  for (const run of runsOf(sessions, BOUND_PARAMETERS_MAX)) {
    const placeholders = run.map(() => "?").join(", ");
    const rows = sql
      .exec(
        `SELECT session_id, object_key FROM recording_chunks
          WHERE session_id IN (${placeholders})
          ORDER BY first_ts, received_at, uuid`,
        ...run,
      )
      .toArray();
    for (const row of rows) {
      const entry = keys.get(rowText(row.session_id, "session_id"));
      if (entry === undefined)
        throw new Error("a chunk row named a session that was not asked for");
      entry.push(rowText(row.object_key, "object_key"));
    }
  }
  return sessions.map((sessionId) => ({ sessionId, objectKeys: keys.get(sessionId) ?? [] }));
}

/**
 * Deletes the chunk rows of `objectKeys`, then every recording row of those
 * chunks' sessions left with no chunk, and answers how many of each
 * (privacy-12, privacy-13). A chunk whose key is not given keeps its row,
 * and so does its recording.
 */
export function deleteChunkRows(
  sql: SqlStorage,
  objectKeys: readonly string[],
): { chunks: number; recordings: number } {
  const sessions = new Set<string>();
  let chunks = 0;
  for (const run of runsOf(objectKeys, BOUND_PARAMETERS_MAX)) {
    const placeholders = run.map(() => "?").join(", ");
    const rows = sql
      .exec(
        `SELECT DISTINCT session_id FROM recording_chunks WHERE object_key IN (${placeholders})`,
        ...run,
      )
      .toArray();
    for (const row of rows) sessions.add(rowText(row.session_id, "session_id"));
    chunks += sql
      .exec(
        `DELETE FROM recording_chunks WHERE object_key IN (${placeholders}) RETURNING uuid`,
        ...run,
      )
      .toArray().length;
  }

  let recordings = 0;
  for (const run of runsOf([...sessions], BOUND_PARAMETERS_MAX)) {
    const placeholders = run.map(() => "?").join(", ");
    recordings += sql
      .exec(
        `DELETE FROM recordings
          WHERE session_id IN (${placeholders})
            AND NOT EXISTS (
              SELECT 1 FROM recording_chunks
               WHERE recording_chunks.session_id = recordings.session_id)
          RETURNING session_id`,
        ...run,
      )
      .toArray().length;
  }
  return { chunks, recordings };
}

/** Which of `keys` a recording_chunks row names (recordings-06). */
export function knownKeys(sql: SqlStorage, keys: readonly string[]): Set<string> {
  const known = new Set<string>();
  for (const run of runsOf(keys, BOUND_PARAMETERS_MAX)) {
    const placeholders = run.map(() => "?").join(", ");
    const rows = sql
      .exec(`SELECT object_key FROM recording_chunks WHERE object_key IN (${placeholders})`, ...run)
      .toArray();
    for (const row of rows) known.add(rowText(row.object_key, "object_key"));
  }
  return known;
}

/**
 * One export page of `recordings` (privacy-22, privacy-25): an ExportPage
 * of up to `limit` rows with a rowid above `after`, by rowid, each one JSON
 * line of its columns by name. `next` is the last row's rowid when the page
 * holds `limit` rows, else null.
 */
/** The columns a recordings export writes, and an import reads back (privacy-22, privacy-30). */
export const RECORDINGS_SHAPE: ExportShape = {
  table: "recordings",
  columns: [
    "session_id",
    "distinct_id",
    "person_id",
    "start_ts",
    "end_ts",
    "active_ms",
    "first_url",
    "clicks",
    "keypresses",
    "bytes",
  ],
  json: [],
};

/** The columns a recording_chunks export writes, and an import reads back. */
export const CHUNKS_SHAPE: ExportShape = {
  table: "recording_chunks",
  columns: [
    "uuid",
    "session_id",
    "object_key",
    "first_ts",
    "last_ts",
    "received_at",
    "bytes",
    "snapshot_path",
    "snapshot_width",
  ],
  json: [],
};

export function exportRecordings(sql: SqlStorage, after: number, limit: number): ExportPage {
  const page = sql
    .exec(
      `SELECT rowid AS row_id, ${RECORDINGS_SHAPE.columns.join(", ")}
         FROM recordings WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      after,
      limit,
    )
    .toArray();
  return { lines: exportLines(page), next: exportCursor(page, limit) };
}

/** One export page of `recording_chunks`, as exportRecordings pages (privacy-22, privacy-25). */
export function exportChunks(sql: SqlStorage, after: number, limit: number): ExportPage {
  const page = sql
    .exec(
      `SELECT rowid AS row_id, ${CHUNKS_SHAPE.columns.join(", ")}
         FROM recording_chunks WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      after,
      limit,
    )
    .toArray();
  return { lines: exportLines(page), next: exportCursor(page, limit) };
}

/** Each row of a page as one NDJSON line of its columns, without the cursor's rowid. */
function exportLines(page: readonly Record<string, SqlStorageValue>[]): string[] {
  return page.map((row) => {
    const columns: Record<string, unknown> = { ...row };
    delete columns.row_id;
    return JSON.stringify(columns);
  });
}

// ── R2 ──────────────────────────────────────────────────────────────────────

/** Writes one gzip NDJSON chunk; a failed put is "r2 failed", never a throw. */
export async function putChunk(
  bucket: R2Bucket,
  key: string,
  gzipped: Uint8Array,
): Promise<Result<void, "r2 failed">> {
  try {
    await bucket.put(key, gzipped);
  } catch {
    return err("r2 failed");
  }
  return ok(undefined);
}

/**
 * The first chunk, in the order given, whose object the bucket does not
 * hold; null when all exist (recordings-16). A session's objects share one
 * prefix, `<project>/<session>/`, so one list() call reads up to a thousand
 * keys. A HEAD per chunk would cost one subrequest each, and playback then
 * costs one GET each, which a long session would push past the Worker's
 * subrequest limit.
 */
export async function firstMissing(
  bucket: R2Bucket,
  chunks: readonly ChunkRef[],
): Promise<ChunkRef | null> {
  const prefixes = new Set(chunks.map((chunk) => prefixOf(chunk.objectKey)));
  const present = new Set<string>();
  for (const prefix of prefixes) {
    let cursor: string | undefined;
    do {
      // Each page needs the cursor of the one before, so pages go in turn.
      // oxlint-disable-next-line no-await-in-loop
      const page = await bucket.list(cursor === undefined ? { prefix } : { prefix, cursor });
      for (const object of page.objects) present.add(object.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
  }
  return chunks.find((chunk) => !present.has(chunk.objectKey)) ?? null;
}

/** An object key's folder, with its final slash: `<project>/<session>/`. */
function prefixOf(key: string): string {
  return key.slice(0, key.lastIndexOf("/") + 1);
}

/**
 * The chunks' objects gunzipped and joined in the order given, as one NDJSON
 * stream: each object is fetched only when the one before has been read, so
 * a session of tens of megabytes is never held whole (recordings-01,
 * recordings-18). An object gone by the time it is read errors the stream.
 */
export function playback(
  bucket: R2Bucket,
  chunks: readonly ChunkRef[],
): ReadableStream<Uint8Array> {
  let next = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const openNext = async (): Promise<ReadableStreamDefaultReader<Uint8Array>> => {
    const chunk = chunks[next];
    if (chunk === undefined) throw new Error("no chunk left to read");
    next += 1;
    const object = await bucket.get(chunk.objectKey);
    if (object === null) {
      throw new Error(`chunk ${chunk.uuid} is gone from the recordings bucket`);
    }
    return object.body.pipeThrough(new DecompressionStream("gzip")).getReader();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          if (reader === null) {
            if (next >= chunks.length) {
              controller.close();
              return;
            }
            reader = await openNext();
          }
          const { done, value } = await reader.read();
          if (!done) {
            controller.enqueue(value);
            return;
          }
          reader = null;
        }
      } catch (cause) {
        controller.error(cause);
      }
    },
    // A client that leaves mid-playback must not leave an R2 body open.
    async cancel(cause) {
      const current = reader;
      reader = null;
      await current?.cancel(cause);
    },
  });
}

// ---------------------------------------------------------------- columns

// The schema makes these columns STRICT and, where read below, non-null.
// Another type there is a broken invariant, so it throws rather than invent
// a value.

/**
 * Deletes `keys` from the bucket in calls of at most R2_DELETE_KEYS_MAX
 * keys. A call that fails is tried again key by key, so only a key whose own
 * delete fails is answered in `failed`, never thrown, and the rest count in
 * `deleted` (privacy-13, privacy-19). Deleting a key that is already gone
 * succeeds.
 */
export async function deleteObjects(
  bucket: R2Bucket,
  keys: readonly string[],
): Promise<{ deleted: number; failed: string[] }> {
  let deleted = 0;
  const failed: string[] = [];
  for (const run of runsOf(keys, R2_DELETE_KEYS_MAX)) {
    try {
      // oxlint-disable-next-line no-await-in-loop
      await bucket.delete([...run]);
      deleted += run.length;
    } catch {
      // One bad key in a batch fails the batch, so each key is tried alone.
      for (const key of run) {
        try {
          // oxlint-disable-next-line no-await-in-loop
          await bucket.delete(key);
          deleted += 1;
        } catch {
          failed.push(key);
        }
      }
    }
  }
  return { deleted, failed };
}

/**
 * The project's orphan objects (recordings-06, recordings-17): keys under
 * the prefix "<projectId>/", with its final slash so another project whose
 * id starts the same is never listed, that `isKnown` does not know, uploaded
 * before `uploadedBefore`, so an object whose row may still be coming is
 * left alone. Pages through the listing, at most `max` orphans; `more` is
 * true when the listing held further orphans.
 */
export async function orphanKeys(
  bucket: R2Bucket,
  projectId: string,
  uploadedBefore: number,
  isKnown: (keys: readonly string[]) => Set<string>,
  max: number,
): Promise<{ keys: string[]; more: boolean }> {
  const prefix = `${projectId}/`;
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    // Each page needs the cursor of the one before, so pages go in turn.
    // oxlint-disable-next-line no-await-in-loop
    const page = await bucket.list(cursor === undefined ? { prefix } : { prefix, cursor });
    const aged = page.objects.filter((object) => object.uploaded.getTime() < uploadedBefore);
    const known = isKnown(aged.map((object) => object.key));
    for (const object of aged) {
      if (known.has(object.key)) continue;
      if (keys.length === max) return { keys, more: true };
      keys.push(object.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return { keys, more: false };
}

/**
 * Deletes up to `max` objects under "<projectId>/", with its final slash,
 * paging through the listing, for a purge (privacy-03, privacy-21). `more`
 * is true when objects are left; a failed delete is answered, never thrown.
 */
export async function deletePrefix(
  bucket: R2Bucket,
  projectId: string,
  max: number,
): Promise<Result<{ deleted: number; more: boolean }, "r2 failed">> {
  const prefix = `${projectId}/`;
  const keys: string[] = [];
  let more = false;
  let cursor: string | undefined;
  do {
    // Each page needs the cursor of the one before, so pages go in turn.
    // oxlint-disable-next-line no-await-in-loop
    const page = await bucket.list(cursor === undefined ? { prefix } : { prefix, cursor });
    for (const object of page.objects) {
      if (keys.length === max) {
        more = true;
        break;
      }
      keys.push(object.key);
    }
    if (more) break;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);

  const { deleted, failed } = await deleteObjects(bucket, keys);
  if (failed.length > 0) return err("r2 failed");
  return ok({ deleted, more });
}
