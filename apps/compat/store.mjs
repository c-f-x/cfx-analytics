// @ts-check

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";

// Reads what the Worker stored out of the state wrangler persisted, opening
// every database read-only. Paths are found by looking at what miniflare wrote:
// - a ProjectStore is the SQLite file carrying person_distinct_ids, under
//   <state>/v3/do/<script>-<class>/<hash>.sqlite;
// - a recordings object is a file under <state>/v3/r2/<bucket>/blobs/<blob id>,
//   with its key in the R2 object store's SQLite file, the one with _mf_objects.
// The Worker keeps writing while a run reads, so every open sets a busy timeout.

const PROJECT_STORE_TABLE = "person_distinct_ids";
const R2_OBJECT_TABLE = "_mf_objects";
const R2_INDEX_DIRECTORY = "miniflare-R2BucketObject";
const BUSY_TIMEOUT_MS = 2_000;

/**
 * @typedef {{
 *   uuid: string,
 *   event: string,
 *   distinctId: string,
 *   personId: number | null,
 *   ts: number,
 *   properties: Record<string, unknown>,
 * }} StoredEvent
 * @typedef {{ distinctId: string, personId: number }} PersonLink
 * @typedef {{
 *   eventUuid: string,
 *   seq: number,
 *   host: string | null,
 *   path: string,
 *   widthBand: number,
 *   x: number,
 *   y: number,
 *   kind: string,
 *   fixed: boolean,
 *   bot: boolean,
 *   ts: number,
 *   sessionId: string | null,
 *   distinctId: string | null,
 * }} StoredPoint
 * @typedef {{
 *   uuid: string,
 *   sessionId: string,
 *   objectKey: string,
 *   firstTs: number,
 *   lastTs: number,
 *   byteSize: number,
 *   snapshotPath: string | null,
 *   snapshotWidth: number | null,
 * }} StoredChunk
 * @typedef {{ key: string, bytes: Uint8Array }} StoredObject
 * @typedef {{ key: string, bytes: Uint8Array, events: Record<string, unknown>[] }} DecodedObject
 */

/**
 * One events row as a check reads it. Rows written by the Worker should always
 * map; a row that does not is reported, not thrown, so a check can say why.
 * @param {unknown} row
 * @returns {{ ok: true, value: StoredEvent } | { ok: false, error: string }}
 */
export function mapEventRow(row) {
  if (!isRecord(row)) return { ok: false, error: "an events row is not an object" };
  const { uuid, event, distinct_id: distinctId, person_id: personId, ts, properties } = row;
  if (typeof uuid !== "string" || typeof event !== "string" || typeof distinctId !== "string") {
    return { ok: false, error: "an events row has a missing text column" };
  }
  if (typeof ts !== "number") {
    return { ok: false, error: `event ${uuid} has no numeric ts` };
  }
  const person = personId === null ? null : typeof personId === "number" ? personId : undefined;
  if (person === undefined) {
    return { ok: false, error: `event ${uuid} has a person_id that is neither null nor a number` };
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(String(properties));
  } catch {
    return { ok: false, error: `event ${uuid} has properties that are not JSON` };
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: `event ${uuid} has properties that are not an object` };
  }
  return { ok: true, value: { uuid, event, distinctId, personId: person, ts, properties: parsed } };
}

/**
 * One person_distinct_ids row as a check reads it.
 * @param {unknown} row
 * @returns {{ ok: true, value: PersonLink } | { ok: false, error: string }}
 */
export function mapPersonLink(row) {
  if (!isRecord(row)) return { ok: false, error: "a person_distinct_ids row is not an object" };
  const { distinct_id: distinctId, person_id: personId } = row;
  if (typeof distinctId !== "string" || typeof personId !== "number") {
    return { ok: false, error: "a person_distinct_ids row has a missing column" };
  }
  return { ok: true, value: { distinctId, personId } };
}

/**
 * One R2 index row as the reader uses it.
 * @param {unknown} row
 * @returns {{ ok: true, value: { key: string, blobId: string } } | { ok: false, error: string }}
 */
export function mapObjectRow(row) {
  if (!isRecord(row)) return { ok: false, error: "an R2 index row is not an object" };
  const { key, blob_id: blobId } = row;
  if (typeof key !== "string" || typeof blobId !== "string") {
    return { ok: false, error: "an R2 index row has a missing column" };
  }
  return { ok: true, value: { key, blobId } };
}

/**
 * One heatmap_points row as a check reads it.
 * @param {unknown} row
 * @returns {{ ok: true, value: StoredPoint } | { ok: false, error: string }}
 */
export function mapPointRow(row) {
  if (!isRecord(row)) return { ok: false, error: "a heatmap_points row is not an object" };
  const {
    event_uuid: eventUuid,
    seq,
    host,
    path: pointPath,
    width_band: widthBand,
    x,
    y,
    kind,
    fixed,
    bot,
    ts,
    session_id: sessionId,
    distinct_id: distinctId,
  } = row;
  if (
    typeof eventUuid !== "string" ||
    typeof pointPath !== "string" ||
    typeof kind !== "string" ||
    !isNumber(seq) ||
    !isNumber(widthBand) ||
    !isNumber(x) ||
    !isNumber(y) ||
    !isNumber(ts)
  ) {
    return { ok: false, error: "a heatmap_points row has a missing column" };
  }
  if ((fixed !== 0 && fixed !== 1) || (bot !== 0 && bot !== 1)) {
    return { ok: false, error: `heatmap point ${eventUuid} has a flag that is not 0 or 1` };
  }
  const hostValue = stringOrNull(host);
  const sessionValue = stringOrNull(sessionId);
  const distinctValue = stringOrNull(distinctId);
  if (hostValue === undefined || sessionValue === undefined || distinctValue === undefined) {
    return { ok: false, error: `heatmap point ${eventUuid} has a text column of the wrong type` };
  }
  return {
    ok: true,
    value: {
      eventUuid,
      seq,
      host: hostValue,
      path: pointPath,
      widthBand,
      x,
      y,
      kind,
      fixed: fixed === 1,
      bot: bot === 1,
      ts,
      sessionId: sessionValue,
      distinctId: distinctValue,
    },
  };
}

/**
 * One recording_chunks row as a check reads it.
 * @param {unknown} row
 * @returns {{ ok: true, value: StoredChunk } | { ok: false, error: string }}
 */
export function mapChunkRow(row) {
  if (!isRecord(row)) return { ok: false, error: "a recording_chunks row is not an object" };
  const {
    uuid,
    session_id: sessionId,
    object_key: objectKey,
    first_ts: firstTs,
    last_ts: lastTs,
    bytes: byteSize,
    snapshot_path: snapshotPath,
    snapshot_width: snapshotWidth,
  } = row;
  if (
    typeof uuid !== "string" ||
    typeof sessionId !== "string" ||
    typeof objectKey !== "string" ||
    !isNumber(firstTs) ||
    !isNumber(lastTs) ||
    !isNumber(byteSize)
  ) {
    return { ok: false, error: "a recording_chunks row has a missing column" };
  }
  const pathValue = stringOrNull(snapshotPath);
  const widthValue = snapshotWidth === null || isNumber(snapshotWidth) ? snapshotWidth : undefined;
  if (pathValue === undefined || widthValue === undefined) {
    return { ok: false, error: `recording chunk ${uuid} has a column of the wrong type` };
  }
  return {
    ok: true,
    value: {
      uuid,
      sessionId,
      objectKey,
      firstTs,
      lastTs,
      byteSize,
      snapshotPath: pathValue,
      snapshotWidth: widthValue,
    },
  };
}

/**
 * The rrweb events of one recording object: the Worker stores gzip NDJSON
 * (D-13, docs/data-model.md), one event per line. A body that is not that is
 * an error, not an empty recording.
 * @param {Uint8Array} bytes
 * @returns {Record<string, unknown>[]}
 */
export function decodeRecordingObject(bytes) {
  /** @type {string} */
  let text;
  try {
    text = gunzipSync(bytes).toString("utf8");
  } catch {
    throw new Error("a recording object is not gzip");
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      /** @type {unknown} */
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error("a recording object is not NDJSON");
      }
      if (!isRecord(parsed)) throw new Error("a recording event is not a JSON object");
      return parsed;
    });
}

/**
 * Where an R2 object body lives under the bucket directory. The blob id is
 * checked because it becomes a path.
 * @param {string} bucketDir
 * @param {string} blobId
 * @returns {string | null}
 */
export function resolveObjectFile(bucketDir, blobId) {
  if (!/^[0-9a-f]+$/.test(blobId)) return null;
  return path.join(bucketDir, "blobs", blobId);
}

/**
 * The project's stored events, person links, heatmap points and recording
 * chunks, read from the ProjectStore the Worker created under the run's state.
 * Throws while that store does not exist yet; a caller that is waiting catches
 * it and asks again. The chunks come in the order the Worker plays them back.
 * @param {string} stateDir
 * @returns {{
 *   storeFile: string,
 *   events: StoredEvent[],
 *   links: PersonLink[],
 *   points: StoredPoint[],
 *   chunks: StoredChunk[],
 * }}
 */
export function readObservations(stateDir) {
  const storeFile = findProjectStore(stateDir);
  return {
    storeFile,
    events: readEvents(storeFile),
    links: readPersonLinks(storeFile),
    points: readHeatmapPoints(storeFile),
    chunks: readRecordingChunks(storeFile),
  };
}

/**
 * Every object the Worker put in the run's recordings bucket. An absent
 * bucket reads as no objects.
 * @param {string} stateDir
 * @returns {StoredObject[]}
 */
export function readBucketObjects(stateDir) {
  const bucketDir = findBucketDir(stateDir);
  if (bucketDir === null) return [];
  /** @type {StoredObject[]} */
  const objects = [];
  for (const file of sqliteFiles(stateDir)) {
    for (const row of tableRows(file, R2_OBJECT_TABLE)) {
      const mapped = mapObjectRow(row);
      if (!mapped.ok) throw new Error(mapped.error);
      const objectFile = resolveObjectFile(bucketDir, mapped.value.blobId);
      if (objectFile === null || !existsSync(objectFile)) continue;
      objects.push({ key: mapped.value.key, bytes: readFileSync(objectFile) });
    }
  }
  return objects;
}

/**
 * Polls a read until it is ready or the deadline passes. The wait ends the
 * moment the rows exist; the deadline catches a hang.
 * @param {() => { ready: boolean, detail: string } | Promise<{ ready: boolean, detail: string }>} read
 * @param {{ timeoutMs: number, pollMs?: number }} options
 * @returns {Promise<{ ready: boolean, detail: string }>}
 */
export async function waitFor(read, { timeoutMs, pollMs = 100 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await read();
    if (result.ready || Date.now() >= deadline) return result;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * The one SQLite file under the state that holds the ProjectStore's tables.
 * @param {string} stateDir
 * @returns {string}
 */
function findProjectStore(stateDir) {
  for (const file of sqliteFiles(stateDir)) {
    if (hasTable(file, PROJECT_STORE_TABLE)) return file;
  }
  throw new Error(`no ProjectStore database under ${stateDir} yet`);
}

/**
 * The one directory under the state's r2 folder that is a bucket. Miniflare
 * keeps the R2 object store itself in a sibling directory of that name.
 * @param {string} stateDir
 * @returns {string | null}
 */
function findBucketDir(stateDir) {
  /** @type {string[]} */
  const buckets = [];
  for (const dir of directories(stateDir)) {
    if (path.basename(path.dirname(dir)) === "r2" && path.basename(dir) !== R2_INDEX_DIRECTORY) {
      buckets.push(dir);
    }
  }
  if (buckets.length > 1) throw new Error(`more than one R2 bucket under ${stateDir}`);
  return buckets[0] ?? null;
}

/**
 * @param {string} file
 * @returns {StoredEvent[]}
 */
function readEvents(file) {
  const db = openReadOnly(file);
  try {
    const rows = /** @type {unknown[]} */ (
      db
        .prepare(
          "SELECT uuid, event, distinct_id, person_id, ts, properties FROM events ORDER BY id",
        )
        .all()
    );
    return rows.map((row) => {
      const mapped = mapEventRow(row);
      if (!mapped.ok) throw new Error(mapped.error);
      return mapped.value;
    });
  } finally {
    db.close();
  }
}

/**
 * @param {string} file
 * @returns {PersonLink[]}
 */
function readPersonLinks(file) {
  const db = openReadOnly(file);
  try {
    const rows = /** @type {unknown[]} */ (
      db.prepare("SELECT distinct_id, person_id FROM person_distinct_ids").all()
    );
    return rows.map((row) => {
      const mapped = mapPersonLink(row);
      if (!mapped.ok) throw new Error(mapped.error);
      return mapped.value;
    });
  } finally {
    db.close();
  }
}

/**
 * @param {string} file
 * @returns {StoredPoint[]}
 */
function readHeatmapPoints(file) {
  if (!hasTable(file, "heatmap_points")) return [];
  const db = openReadOnly(file);
  try {
    const rows = /** @type {unknown[]} */ (
      db
        .prepare(
          `SELECT event_uuid, seq, host, path, width_band, x, y, kind, fixed, bot, ts,
             session_id, distinct_id
           FROM heatmap_points ORDER BY id`,
        )
        .all()
    );
    return rows.map((row) => {
      const mapped = mapPointRow(row);
      if (!mapped.ok) throw new Error(mapped.error);
      return mapped.value;
    });
  } finally {
    db.close();
  }
}

/**
 * The chunks in the Worker's playback order (docs/data-model.md,
 * recording_chunks): first_ts, then the time it was received, then its uuid.
 * @param {string} file
 * @returns {StoredChunk[]}
 */
function readRecordingChunks(file) {
  if (!hasTable(file, "recording_chunks")) return [];
  const db = openReadOnly(file);
  try {
    const rows = /** @type {unknown[]} */ (
      db
        .prepare(
          `SELECT uuid, session_id, object_key, first_ts, last_ts, bytes,
             snapshot_path, snapshot_width
           FROM recording_chunks ORDER BY first_ts, received_at, uuid`,
        )
        .all()
    );
    return rows.map((row) => {
      const mapped = mapChunkRow(row);
      if (!mapped.ok) throw new Error(mapped.error);
      return mapped.value;
    });
  } finally {
    db.close();
  }
}

/**
 * Rows of one table, or none when the file has no such table.
 * @param {string} file
 * @param {string} table
 * @returns {unknown[]}
 */
function tableRows(file, table) {
  if (!hasTable(file, table)) return [];
  const db = openReadOnly(file);
  try {
    return db.prepare(`SELECT key, blob_id FROM ${table}`).all();
  } finally {
    db.close();
  }
}

/**
 * @param {string} file
 * @param {string} table
 * @returns {boolean}
 */
function hasTable(file, table) {
  try {
    const db = openReadOnly(file);
    try {
      const rows = /** @type {unknown[]} */ (
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").all(table)
      );
      return rows.length > 0;
    } finally {
      db.close();
    }
  } catch {
    // A database the Worker holds a write lock on is not this file's answer.
    return false;
  }
}

/**
 * Opens a database the Worker owns without taking a write lock on it.
 * @param {string} file
 * @returns {DatabaseSync}
 */
function openReadOnly(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
  return db;
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function sqliteFiles(root) {
  /** @type {string[]} */
  const files = [];
  for (const file of filesUnder(root)) {
    if (file.endsWith(".sqlite")) files.push(file);
  }
  return files;
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function directories(root) {
  /** @type {string[]} */
  const dirs = [];
  for (const entry of entries(root)) {
    if (entry.isDirectory()) {
      const dir = path.join(root, entry.name);
      dirs.push(dir, ...directories(dir));
    }
  }
  return dirs;
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function filesUnder(root) {
  /** @type {string[]} */
  const files = [];
  for (const entry of entries(root)) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

/**
 * @param {string} root
 * @returns {import("node:fs").Dirent[]}
 */
function entries(root) {
  try {
    return readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isNumber(value) {
  return typeof value === "number";
}

/**
 * A column that is text or null; undefined when it is another type.
 * @param {unknown} value
 * @returns {string | null | undefined}
 */
function stringOrNull(value) {
  if (value === null || typeof value === "string") return value;
  return undefined;
}
