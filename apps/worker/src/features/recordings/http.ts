import { BODY_LIMITS, type RecordingSummary } from "@cfanalytics/shared";
import type { Hono } from "hono";
import { mirroredOrigin, sdkCorsHeaders } from "../../platform/cors.ts";
import {
  type AppContext,
  type AppEnv,
  apiError,
  bodyRefusal,
  dashboardAnswer,
  readBody,
  STORE_UNAVAILABLE,
  sdkAnswer,
  sdkError,
} from "../../platform/http.ts";
import type { SnapshotAnswer, SnapshotChunk, SnapshotError } from "../../platform/ingest.ts";
import { projectStore } from "../../platform/project-store-id.ts";
import { messageOf, type Result } from "../../platform/result.ts";
import type { SchemaError } from "../../platform/schema.ts";
import { requireAdmin } from "../../platform/session.ts";
import {
  clockSkew,
  decodeBody,
  isUuid,
  normalizeBody,
  sentLimit,
  uuidV7,
} from "../intake/index.ts";
import { dashboardProject, sdkProject } from "../projects/index.ts";
import {
  chunkMeta,
  cursorOf,
  decodeChunk,
  isSessionId,
  listQuery,
  type SnapshotDrop,
  scrub,
  snapshotOf,
  toNdjson,
} from "./core.ts";
import { type ChunkRef, firstMissing, playback } from "./store.ts";

// Replay intake and playback (D-13, D-20; posthog-protocol.md §7, §10.5).
//
//   POST /s and /s/                                       snapshots from posthog-js and posthog-ios
//   GET  /api/projects/:id/recordings                     the recording list
//   GET  /api/projects/:id/recordings/:session/chunks     a session's events, for the player
//
// /s and /s/ are SDK paths: every answer carries sdkCorsHeaders as capture's
// do, refusals included, and a refusal is sdkError (intake-12). The two
// dashboard paths are behind requireAdmin, so a secret key is 401 there
// (recordings-04), and carry no CORS headers (platform-11). A dashboard
// project is read with getProject (projects): a registry failure is 503, and
// an unknown or deleted project 404 with no ProjectStore contacted.
export function mountRecordings(app: Hono<AppEnv>): void {
  app.all("/s", handleSnapshots);
  app.all("/s/", handleSnapshots);
  app.get("/api/projects/:id/recordings", requireAdmin(), handleList);
  app.get("/api/projects/:id/recordings/:session/chunks", requireAdmin(), handleChunks);
}

/**
 * /s and /s/. OPTIONS: the preflight, 200 with an empty body. Any method but
 * POST and OPTIONS: 405, nothing read or stored. POST:
 * 1. readBody with sentLimit(Content-Type, Content-Encoding,
 *    BODY_LIMITS.recordingBytes), then decodeBody with
 *    BODY_LIMITS.recordingBytes: too large is 413, unreadable is 400, and
 *    neither the registry nor a ProjectStore is contacted (intake-05,
 *    intake-25, intake-26). A browser's bare array as gzip text/plain, the
 *    base64 form body and posthog-ios's gzip JSON all decode (recordings-19).
 * 2. normalizeBody with the query's sent_at: "not events" is 400.
 * 3. Its token: none is 401; resolveToken with REGISTRY, caches.default and
 *    deps.now(): a failure is 503 and an unknown token 401.
 * 4. With recording_enabled off: 200 {"status": 1}, nothing stored and no
 *    ProjectStore contacted (recordings-13).
 * 5. The events whose own token is null or the project's; the others are
 *    left out (recordings-23). Each through snapshotOf: any "bad session" is
 *    400 for the whole request, with nothing stored (recordings-08); a
 *    SnapshotDrop leaves that event out (recordings-21, recordings-22,
 *    cookieless-15). Snapshots are never clipped.
 * 6. Each snapshot: its uuid kept when isUuid, else uuidV7(deps.now(),
 *    deps.random(10)); decodeChunk, then scrub, then chunkMeta with
 *    clockSkew(raw.sentAt, receivedAt), so times sent with no sent_at are
 *    kept as sent (recordings-19, recordings-28); then toNdjson, gzipped with
 *    CompressionStream. An "undecodable" or "no events" chunk is left out.
 *    Every chunk left out is counted for one log line.
 * 7. With no chunk left: 200 {"status": 1}, no ProjectStore contacted.
 * 8. One RPC, ingestSnapshots, to projectStore(env, project id) with
 *    receivedAt = deps.now() at step 3, the project's
 *    daily_recording_bytes_cap and timezone, and the chunks. No IP and no
 *    user agent travel with them (recordings-09). An error answered or
 *    thrown is 503 (recordings-17).
 * 9. 200 with {"status": 1}, and "quota_limited": ["recordings"] when the
 *    answer is quotaLimited (recordings-03, posthog-protocol.md §2.5, §7.4),
 *    with Cache-Control "no-store", after the store committed.
 */
export async function handleSnapshots(c: AppContext): Promise<Response> {
  const preflight = c.req.method === "OPTIONS";
  const cors = sdkCorsHeaders(
    mirroredOrigin(c.req.header("origin") ?? null),
    c.req.header("access-control-request-headers") ?? null,
    preflight,
  );
  if (preflight) return new Response(null, { status: 200, headers: cors });
  if (c.req.method !== "POST") {
    const message = "Only POST and OPTIONS are allowed on this path.";
    return sdkError(cors, 405, "method_not_allowed", message);
  }

  const deps = c.get("deps");
  const contentType = c.req.header("content-type") ?? null;
  const contentEncoding = c.req.header("content-encoding") ?? null;
  const limit = BODY_LIMITS.recordingBytes;

  // The body is read and decoded before anything else, so a body this path
  // refuses never reaches the registry or a store (intake-05, intake-25).
  const bytes = await readBody(c.req.raw, sentLimit(contentType, contentEncoding, limit));
  if (!bytes.ok) return bodyRefusal(cors, bytes.error.kind === "too_large");

  const decoded = await decodeBody(bytes.value, contentType, contentEncoding, limit);
  if (!decoded.ok) return bodyRefusal(cors, decoded.error.kind === "too large");

  const normalized = normalizeBody(decoded.value.body, c.req.query("sent_at") ?? null);
  if (!normalized.ok) return sdkError(cors, 400, "validation_failed", "The body holds no events.");

  const token = normalized.value.token;
  if (token === null) {
    return sdkError(cors, 401, "unauthorized", "The request carries no project token.");
  }

  const now = deps.now();
  const result = await sdkProject(c, token, now, cors);
  if (!result.ok) return result.error;
  const project = result.value;

  // Nothing is stored while the project has recording off, and its store is
  // never contacted (recordings-13).
  if (!project.settings.recording_enabled) return sdkAnswer(cors, snapshotsAnswer(false));

  const dropped: DroppedSnapshots = {
    foreignToken: 0,
    notSnapshot: 0,
    cookieless: 0,
    noSession: 0,
    noData: 0,
    undecodable: 0,
    noEvents: 0,
  };
  const chunks: SnapshotChunk[] = [];
  for (const raw of normalized.value.events) {
    if (raw.token !== null && raw.token !== token) {
      dropped.foreignToken += 1;
      continue;
    }
    const snapshot = snapshotOf(raw);
    if (!snapshot.ok) {
      // A session id that is not a UUID refuses the whole request, so no R2
      // key can reach outside its session's prefix (recordings-08).
      if (snapshot.error === "bad session") {
        return sdkError(cors, 400, "validation_failed", "A session id on this path is not a UUID.");
      }
      dropped[SNAPSHOT_DROP_FIELD[snapshot.error]] += 1;
      continue;
    }

    const uuid = isUuid(snapshot.value.uuid)
      ? snapshot.value.uuid
      : uuidV7(deps.now(), deps.random(10));
    const decodedEvents = await decodeChunk(snapshot.value.data);
    if (!decodedEvents.ok) {
      dropped.undecodable += 1;
      continue;
    }
    const events = scrub(decodedEvents.value);
    // A chunk with no events stores nothing (chunkMeta's "no events").
    const meta = chunkMeta(events, clockSkew(raw.sentAt, now));
    if (!meta.ok) {
      dropped.noEvents += 1;
      continue;
    }

    chunks.push({
      uuid,
      sessionId: snapshot.value.sessionId,
      distinctId: snapshot.value.distinctId,
      gzipped: await gzip(toNdjson(events)),
      meta: meta.value,
    });
  }
  if (hasDrops(dropped)) deps.log.info("snapshots_dropped", { ...dropped });

  if (chunks.length === 0) return sdkAnswer(cors, snapshotsAnswer(false));

  // No IP and no user agent travel with the chunks (recordings-09).
  let stored: Result<SnapshotAnswer, SchemaError | SnapshotError>;
  try {
    stored = await projectStore(c.env, project.id).ingestSnapshots({
      projectId: project.id,
      receivedAt: now,
      settings: {
        daily_recording_bytes_cap: project.settings.daily_recording_bytes_cap,
        timezone: project.settings.timezone,
      },
      chunks,
    });
  } catch (cause) {
    deps.log.error("project_store_failed", { message: messageOf(cause) });
    return sdkError(cors, 503, "unavailable", STORE_UNAVAILABLE);
  }
  if (!stored.ok) {
    deps.log.error("project_store_refused", { error: stored.error });
    return sdkError(cors, 503, "unavailable", STORE_UNAVAILABLE);
  }

  return sdkAnswer(cors, snapshotsAnswer(stored.value.quotaLimited));
}

/** Why a $snapshot event on /s/ made no chunk, by reason, for one log line. */
interface DroppedSnapshots {
  foreignToken: number;
  notSnapshot: number;
  cookieless: number;
  noSession: number;
  noData: number;
  undecodable: number;
  noEvents: number;
}

/** The log field that counts each SnapshotDrop the request keeps going past. */
const SNAPSHOT_DROP_FIELD = {
  "not a snapshot": "notSnapshot",
  cookieless: "cookieless",
  "no session": "noSession",
  "no data": "noData",
} as const satisfies Record<Exclude<SnapshotDrop, "bad session">, keyof DroppedSnapshots>;

function hasDrops(dropped: DroppedSnapshots): boolean {
  return Object.values(dropped).some((count) => count > 0);
}

/** The accepted batch's answer: quota_limited names recordings when its cap refused a chunk (recordings-03). */
function snapshotsAnswer(quotaLimited: boolean): Record<string, unknown> {
  return quotaLimited ? { status: 1, quota_limited: ["recordings"] } : { status: 1 };
}

/** The NDJSON chunk's gzip bytes, as the store writes them and the counter counts them (recordings-30). */
async function gzip(text: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const stream = new Response(bytes).body?.pipeThrough(new CompressionStream("gzip"));
  if (stream === undefined) throw new Error("the chunk body has no stream");
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The recording list: listQuery of the query string's limit, cursor and
 * filters (recordings-34), where
 * "bad limit" is 400 validation_failed and "bad cursor" 400 invalid_cursor;
 * then the project; then the RPC listRecordings, whose error is 503. 200 with
 * {"recordings": RecordingSummary[]}, and "nextCursor": cursorOf(the last row)
 * when the page is full (recordings-05, recordings-29).
 */
export async function handleList(c: AppContext): Promise<Response> {
  const param = (name: string): string | null => c.req.query(name) ?? null;
  const query = listQuery({
    limit: param("limit"),
    cursor: param("cursor"),
    person: param("person"),
    page: param("page"),
    event: param("event"),
    minDuration: param("minDuration"),
  });
  if (!query.ok) {
    if (query.error === "bad cursor") {
      return apiError(400, "invalid_cursor", "cursor is not one this route wrote.");
    }
    return query.error === "bad limit"
      ? apiError(400, "validation_failed", "limit must be a whole number from 1 to 100.")
      : apiError(
          400,
          "validation_failed",
          "person, page and event take 1 to 200 characters, and minDuration a whole number of milliseconds.",
        );
  }

  const result = await dashboardProject(c);
  if (!result.ok) return result.error;
  const project = result.value;

  let rows: RecordingSummary[];
  try {
    const listed = await projectStore(c.env, project.id).listRecordings(query.value);
    if (!listed.ok) {
      c.get("deps").log.error("project_store_refused", { error: listed.error });
      return apiError(503, "unavailable", STORE_UNAVAILABLE);
    }
    rows = listed.value;
  } catch (cause) {
    c.get("deps").log.error("project_store_failed", { message: messageOf(cause) });
    return apiError(503, "unavailable", STORE_UNAVAILABLE);
  }

  const body: Record<string, unknown> = { recordings: rows };
  const last = rows[rows.length - 1];
  // A full page may have more behind it, so it hands back where to resume.
  if (rows.length === query.value.limit && last !== undefined) body.nextCursor = cursorOf(last);
  return dashboardAnswer(body);
}

/**
 * A session's events for the player. The project first; a session that is
 * not isSessionId is 404 with no ProjectStore contacted. Then the RPC
 * recordingChunks: an error is 503, no chunks 404, so a session of another
 * project is 404 and nothing of it is read (recordings-04, recordings-15).
 * Then firstMissing on RECORDINGS: a missing object is 502 chunk_missing,
 * whose message names the chunk's uuid (recordings-16). Else 200 with
 * Content-Type "application/x-ndjson", Cache-Control "no-store" and
 * playback's stream: every chunk's events in play order, once each
 * (recordings-01, recordings-09, recordings-12, recordings-14,
 * recordings-18). With `chunk` in the query string, only the chunk of that
 * key is played, and a key that is none of the session's is 404
 * (recordings-36).
 */
export async function handleChunks(c: AppContext): Promise<Response> {
  const result = await dashboardProject(c);
  if (!result.ok) return result.error;
  const project = result.value;

  // A session id that cannot name a session reaches no store (recordings-15).
  const sessionId = routeParam(c, "session");
  if (!isSessionId(sessionId)) return projectNotFound();

  let chunks: ChunkRef[];
  try {
    const found = await projectStore(c.env, project.id).recordingChunks(sessionId);
    if (!found.ok) {
      c.get("deps").log.error("project_store_refused", { error: found.error });
      return apiError(503, "unavailable", STORE_UNAVAILABLE);
    }
    chunks = found.value;
  } catch (cause) {
    c.get("deps").log.error("project_store_failed", { message: messageOf(cause) });
    return apiError(503, "unavailable", STORE_UNAVAILABLE);
  }
  const only = c.req.query("chunk");
  if (only !== undefined) chunks = chunks.filter((chunk) => chunk.objectKey === only);
  // A session of another project has no chunk here, so it is 404 too (recordings-04).
  if (chunks.length === 0) return projectNotFound();

  const missing = await firstMissing(c.env.RECORDINGS, chunks);
  if (missing !== null) {
    const message = `The chunk ${missing.uuid} is missing from the recordings bucket.`;
    return apiError(502, "chunk_missing", message);
  }

  return new Response(playback(c.env.RECORDINGS, chunks), {
    status: 200,
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}

// ── shared by the two dashboard routes ──────────────────────────────────────

function projectNotFound(): Response {
  return apiError(404, "not_found", "No such recording.");
}

/** The router matched the route, so the parameter is there; an empty id finds no project. */
function routeParam(c: AppContext, name: "id" | "session"): string {
  return c.req.param(name) ?? "";
}
