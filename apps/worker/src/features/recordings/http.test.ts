import { env } from "cloudflare:test";
import type { Json, JsonObject } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import {
  answerJson,
  appAt,
  BROWSER_UA,
  CLIENT_IP,
  COOKIELESS_SENTINEL,
  capture,
  counterValue,
  dayIn,
  fetchApp,
  HOUR_MS,
  INTAKE,
  inStore,
  iso,
  jsBatch,
  jsEvent,
  jsonBytes,
  jsRequest,
  newUuid,
  ORIGIN,
  preflightRequest,
  T0,
  wasContacted,
} from "../../../test/helpers/capture.ts";
import { asRecord } from "../../../test/helpers/json.ts";
import { newSecretKey, seedProject } from "../../../test/helpers/registry.ts";
import type { StoredChunk } from "../../../test/helpers/replay.ts";
import {
  addedNode,
  chunkEvents,
  compressed,
  consoleEvent,
  customEvent,
  fullSnapshotEvent,
  gunzipText,
  inputEvent,
  iosSnapshot,
  iosSnapshotRequest,
  jsSnapshot,
  metaEvent,
  mutationEvent,
  ndjsonLines,
  networkEvent,
  newSessionId,
  r2Bytes,
  r2Keys,
  snapshotChunk,
  snapshotRequest,
  snapshotRequestOf,
  snapshotsDirect,
  storedChunks,
  storedRecordings,
} from "../../../test/helpers/replay.ts";
import { seedEvents, seedPerson } from "../../../test/helpers/seed.ts";
import { dashboardHeaders, dashboardSession } from "../../../test/helpers/session.ts";
import { mountRecordings } from "./http.ts";

// Every answer the snapshot routes and the two dashboard routes give
// (recordings-01, recordings-02, recordings-05, recordings-08, recordings-09,
// recordings-12, recordings-15 to recordings-24, recordings-28 to
// recordings-30, recordings-32, intake-05, intake-12, cookieless-15). SELF
// runs on the real clock; `appAt(() => T0, mountRecordings)` fixes it where a
// cap's day or a chunk's time is checked. Each test seeds its own projects and
// makes its own session ids.

const OSLO = "Europe/Oslo";
const DAY = dayIn(T0, OSLO);

/** A project with recordings turned on, as the dashboard's setting would. */
function recordingProject(): ReturnType<typeof seedProject> {
  return seedProject({ settings: { recording_enabled: true } });
}

/** A GET as the dashboard sends it: the session cookie and the dashboard's origin. */
function dashboardGet(path: string, signedIn: string): Request {
  return new Request(new URL(path, INTAKE), { headers: dashboardHeaders(signedIn) });
}

/** The one chunk row a project stored. */
async function onlyChunk(projectId: string): Promise<StoredChunk> {
  const [row] = await storedChunks(projectId);
  if (row === undefined) throw new Error("the project stored no chunk");
  return row;
}

/** A JSON value as an object, or a failure. */

/** An event's data as the helpers write it. */
function dataOf(event: JsonObject): JsonObject {
  return asRecord(event.data);
}

/** A JSON value as a string or a number, or a failure. */
function textOf(value: Json | undefined): string {
  if (typeof value !== "string") throw new Error("expected a string");
  return value;
}

function numberOf(value: Json | undefined): number {
  if (typeof value !== "number") throw new Error("expected a number");
  return value;
}

interface ListedRecording {
  sessionId: string;
  personId: number | null;
  pages?: unknown;
}

function isListedRecording(value: unknown): value is ListedRecording {
  if (typeof value !== "object" || value === null) return false;
  if (!("sessionId" in value) || typeof value.sessionId !== "string") return false;
  if (!("personId" in value)) return false;
  return value.personId === null || typeof value.personId === "number";
}

/** The list route's recordings, or a failure if it answered something else. */
function recordingsOf(value: unknown): ListedRecording[] {
  if (typeof value !== "object" || value === null || !("recordings" in value))
    throw new Error("the list route answered no recordings list");
  const rows = value.recordings;
  if (!Array.isArray(rows)) throw new Error("recordings is not an array");
  const all: unknown[] = rows;
  const summaries = all.filter(isListedRecording);
  if (summaries.length !== all.length) throw new Error("a recording summary is malformed");
  return summaries;
}

/** An SDK answer's CORS headers: the origin mirrored, never `*`. */
function expectCors(response: Response, origin: string | null): void {
  expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  expect(response.headers.get("vary")).toBe("Origin");
  if (origin !== null)
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
}

// -------------------------------------------------------- /s/ ingestion

it("recordings-01 · chunks sent out of order play back in timestamp order, each chunk's events in place", async () => {
  const project = await recordingProject();
  const session = newSessionId();
  const early = jsSnapshot(project.token, {
    sessionId: session,
    data: [customEvent("early", T0, { part: 1 }), customEvent("early", T0 + 100, { part: 2 })],
  });
  const middle = jsSnapshot(project.token, {
    sessionId: session,
    data: [
      customEvent("middle", T0 + 1000, { part: 1 }),
      customEvent("middle", T0 + 1100, { part: 2 }),
    ],
  });
  const late = jsSnapshot(project.token, {
    sessionId: session,
    data: [
      customEvent("late", T0 + 2000, { part: 1 }),
      customEvent("late", T0 + 2100, { part: 2 }),
    ],
  });

  const stored = await capture(await snapshotRequest([late, early, middle]));
  expect(stored.status).toBe(200);

  const signedIn = await dashboardSession();
  const playback = await capture(
    dashboardGet(`/api/projects/${project.id}/recordings/${session}/chunks`, signedIn),
  );
  expect(playback.status).toBe(200);
  expect(playback.headers.get("content-type")).toBe("application/x-ndjson");

  const events = ndjsonLines(await playback.text());
  const played = events.map((event) => {
    const data = dataOf(event);
    const payload = asRecord(data.payload);
    return `${textOf(data.tag)}:${numberOf(payload.part)}`;
  });
  expect(played).toEqual(["early:1", "early:2", "middle:1", "middle:2", "late:1", "late:2"]);
});

it("recordings-02 · typed text in an Input event is stored as asterisks of the same length", async () => {
  const project = await recordingProject();
  const sessionId = newSessionId();

  const response = await capture(
    await snapshotRequest([
      jsSnapshot(project.token, { sessionId, data: [inputEvent(10, "hunter2", T0)] }),
    ]),
  );
  expect(response.status).toBe(200);

  const row = await onlyChunk(project.id);
  const events = await chunkEvents(row.objectKey);
  const [input] = events ?? [];
  if (input === undefined) throw new Error("the stored object held no event");
  expect(dataOf(input).text).toBe("*******");
});

it("recordings-03 · with the day's recording cap taken, /s/ answers quota-limited and writes no object", async () => {
  const project = await seedProject({
    settings: { recording_enabled: true, daily_recording_bytes_cap: 1, timezone: OSLO },
  });
  await inStore(project.id, (sql) => {
    sql.exec("INSERT INTO counters (day, name, value) VALUES (?, 'recording_bytes', 1)", DAY);
    return null;
  });

  const app = appAt(() => T0, mountRecordings);
  const request = await snapshotRequest([
    jsSnapshot(project.token, {
      sessionId: newSessionId(),
      data: [metaEvent("https://www.example.com/", 1280, 800, T0)],
      sentAt: iso(T0),
    }),
  ]);
  const response = await fetchApp(app, request);

  expect(response.status).toBe(200);
  expect(await answerJson(response)).toEqual({ status: 1, quota_limited: ["recordings"] });
  expect(await r2Keys(`${project.id}/`)).toEqual([]);
});

it("recordings-36 · the chunks route asked for one chunk key answers only that chunk", async () => {
  const project = await recordingProject();
  const session = newSessionId();
  const first = jsSnapshot(project.token, {
    sessionId: session,
    data: [customEvent("first", T0, { part: 1 })],
  });
  const second = jsSnapshot(project.token, {
    sessionId: session,
    data: [customEvent("second", T0 + 1000, { part: 1 })],
  });
  expect((await capture(await snapshotRequest([first, second]))).status).toBe(200);
  const chunks = await storedChunks(project.id);
  const firstKey = chunks[0]?.objectKey ?? "";

  const signedIn = await dashboardSession();
  const where = `/api/projects/${project.id}/recordings/${session}/chunks`;
  const one = await capture(
    dashboardGet(`${where}?chunk=${encodeURIComponent(firstKey)}`, signedIn),
  );
  expect(one.status).toBe(200);
  const tags = ndjsonLines(await one.text()).map((event) => textOf(dataOf(event).tag));
  expect(tags).toEqual(["first"]);

  const other = await capture(dashboardGet(`${where}?chunk=not-a-chunk-of-this-session`, signedIn));
  expect(other.status).toBe(404);
});

it("recordings-04 · a session id from another project is 404 on the chunks route", async () => {
  const projectA = await recordingProject();
  const projectB = await recordingProject();
  const session = newSessionId();
  await snapshotsDirect(
    snapshotRequestOf(projectB.id, [await snapshotChunk({ sessionId: session })]),
  );
  expect(await storedChunks(projectB.id)).toHaveLength(1);

  const signedIn = await dashboardSession();
  const response = await capture(
    dashboardGet(`/api/projects/${projectA.id}/recordings/${session}/chunks`, signedIn),
  );

  expect(response.status).toBe(404);
  expect(await answerJson(response)).toEqual({ code: "not_found", message: expect.any(String) });
});

it("recordings-04 · a secret key is 401 on both dashboard routes", async () => {
  const project = await recordingProject();
  const key = newSecretKey();

  for (const path of [
    `/api/projects/${project.id}/recordings`,
    `/api/projects/${project.id}/recordings/${newSessionId()}/chunks`,
  ]) {
    const response = await capture(
      new Request(new URL(path, INTAKE), { headers: { authorization: `Bearer ${key}` } }),
    );
    expect(response.status).toBe(401);
    expect(await answerJson(response)).toEqual({
      code: "unauthorized",
      message: expect.any(String),
    });
  }
});

it("recordings-05 · the list route summarises a session after two chunks", async () => {
  const project = await recordingProject();
  const session = newSessionId();
  const late = await snapshotChunk({
    sessionId: session,
    meta: {
      firstTs: T0 + 1000,
      lastTs: T0 + 2000,
      activeMs: 300,
      clicks: 1,
      keypresses: 2,
      firstUrl: "https://www.example.com/late",
    },
  });
  late.gzipped = new Uint8Array(100);
  const early = await snapshotChunk({
    sessionId: session,
    meta: {
      firstTs: T0,
      lastTs: T0 + 1500,
      activeMs: 200,
      keypresses: 1,
      firstUrl: "https://www.example.com/early",
    },
  });
  early.gzipped = new Uint8Array(150);

  expect(await snapshotsDirect(snapshotRequestOf(project.id, [late, early]))).toEqual({
    ok: true,
    value: { stored: 2, quotaLimited: false },
  });

  const signedIn = await dashboardSession();
  const response = await capture(dashboardGet(`/api/projects/${project.id}/recordings`, signedIn));
  expect(response.status).toBe(200);
  expect(await answerJson(response)).toEqual({
    recordings: [
      {
        sessionId: session,
        distinctId: "anon-1",
        personId: null,
        startTs: T0,
        endTs: T0 + 2000,
        durationMs: 2000,
        activeMs: 500,
        firstUrl: "https://www.example.com/early",
        clicks: 1,
        keypresses: 3,
        bytes: 250,
        pages: [],
      },
    ],
  });
});

it("recordings-08 · a session id that is not a UUID is a 400 for the whole request", async () => {
  const project = await recordingProject();

  for (const sessionId of ["", "a/b", "..", "../p_other", "not-a-uuid"]) {
    const response = await capture(
      await snapshotRequest([
        jsSnapshot(project.token, {
          sessionId,
          data: [metaEvent("https://www.example.com/", 1280, 800, T0)],
        }),
      ]),
    );
    expect(response.status).toBe(400);
    expect(await answerJson(response)).toEqual({
      code: "validation_failed",
      message: expect.any(String),
    });
  }

  expect(await r2Keys(`${project.id}/`)).toEqual([]);
  expect(await wasContacted(project.id)).toBe(false);
});

it("recordings-09 · the stored object holds neither the client IP nor the user agent", async () => {
  const project = await recordingProject();
  const sessionId = newSessionId();

  const response = await capture(
    await snapshotRequest([
      jsSnapshot(project.token, {
        sessionId,
        data: [metaEvent("https://www.example.com/", 1280, 800, T0)],
      }),
    ]),
  );
  expect(response.status).toBe(200);

  const row = await onlyChunk(project.id);
  const bytes = await r2Bytes(row.objectKey);
  if (bytes === null) throw new Error("the chunk object is missing");
  const text = await gunzipText(bytes);
  expect(text).not.toContain(CLIENT_IP);
  expect(text).not.toContain(BROWSER_UA);
  expect(ndjsonLines(text)).toHaveLength(1);
});

it("recordings-12 · the same snapshot sent twice stores one chunk and plays back once", async () => {
  const project = await recordingProject();
  const sessionId = newSessionId();
  const uuid = newUuid();
  const snapshot = jsSnapshot(project.token, {
    sessionId,
    uuid,
    data: [customEvent("once", T0)],
    sentAt: iso(T0),
  });

  const first = await capture(await snapshotRequest([snapshot]));
  expect(first.status).toBe(200);
  const second = await capture(await snapshotRequest([snapshot]));
  expect(second.status).toBe(200);
  expect(await storedChunks(project.id)).toHaveLength(1);

  const signedIn = await dashboardSession();
  const playback = await capture(
    dashboardGet(`/api/projects/${project.id}/recordings/${sessionId}/chunks`, signedIn),
  );
  expect(playback.status).toBe(200);
  const events = ndjsonLines(await playback.text());
  expect(events).toHaveLength(1);
  const [event] = events;
  if (event === undefined) throw new Error("the playback held no event");
  expect(dataOf(event).tag).toBe("once");
});

it("recordings-13 · with recording off, /s/ answers 200 and touches neither store", async () => {
  const project = await seedProject();

  const response = await capture(
    await snapshotRequest([
      jsSnapshot(project.token, {
        sessionId: newSessionId(),
        data: [metaEvent("https://www.example.com/", 1280, 800, T0)],
      }),
    ]),
  );

  expect(response.status).toBe(200);
  expect(await answerJson(response)).toEqual({ status: 1 });
  expect(await wasContacted(project.id)).toBe(false);
  expect(await r2Keys(`${project.id}/`)).toEqual([]);
});

it("recordings-15 · an unknown session is 404 on the chunks route", async () => {
  const project = await recordingProject();
  const signedIn = await dashboardSession();

  const response = await capture(
    dashboardGet(`/api/projects/${project.id}/recordings/${newSessionId()}/chunks`, signedIn),
  );

  expect(response.status).toBe(404);
  expect(await answerJson(response)).toEqual({ code: "not_found", message: expect.any(String) });
});

it("recordings-15 · a session id that is not a UUID is 404 before any store is touched", async () => {
  const project = await recordingProject();
  const signedIn = await dashboardSession();

  const response = await capture(
    dashboardGet(`/api/projects/${project.id}/recordings/session-1/chunks`, signedIn),
  );

  expect(response.status).toBe(404);
  expect(await wasContacted(project.id)).toBe(false);
});

it("recordings-16 · a chunk object deleted from the bucket is a 502 naming its uuid", async () => {
  const project = await recordingProject();
  const session = newSessionId();
  const uuid = newUuid();
  expect(
    await snapshotsDirect(
      snapshotRequestOf(project.id, [await snapshotChunk({ uuid, sessionId: session })]),
    ),
  ).toEqual({ ok: true, value: { stored: 1, quotaLimited: false } });

  const row = await onlyChunk(project.id);
  await env.RECORDINGS.delete(row.objectKey);

  const signedIn = await dashboardSession();
  const response = await capture(
    dashboardGet(`/api/projects/${project.id}/recordings/${session}/chunks`, signedIn),
  );

  expect(response.status).toBe(502);
  expect(await answerJson(response)).toEqual({
    code: "chunk_missing",
    message: expect.stringContaining(uuid),
  });
});

it("recordings-17 · a store without the recordings table answers /s/ with a 503", async () => {
  const project = await recordingProject();
  await inStore(project.id, (sql) => {
    sql.exec("DROP TABLE recordings");
    return null;
  });

  const response = await capture(
    await snapshotRequest([
      jsSnapshot(project.token, {
        sessionId: newSessionId(),
        data: [metaEvent("https://www.example.com/", 1280, 800, T0)],
        sentAt: iso(T0),
      }),
    ]),
  );

  expect(response.status).toBe(503);
  expect(await answerJson(response)).toEqual({ code: "unavailable", message: expect.any(String) });
});

it("recordings-18 · twenty chunks of about 2 MiB play back with every event in order", async () => {
  const project = await recordingProject();
  const session = newSessionId();
  const payload = "x".repeat(2 * 1024 * 1024);

  for (let index = 0; index < 20; index += 1) {
    const firstTs = T0 + index * 1000;
    const events = [customEvent("chunk", firstTs, { index, payload })];
    const answer = await snapshotsDirect(
      snapshotRequestOf(project.id, [
        await snapshotChunk({
          sessionId: session,
          events,
          meta: { firstTs, lastTs: firstTs + 500 },
        }),
      ]),
    );
    expect(answer).toEqual({ ok: true, value: { stored: 1, quotaLimited: false } });
  }

  const signedIn = await dashboardSession();
  const playback = await capture(
    dashboardGet(`/api/projects/${project.id}/recordings/${session}/chunks`, signedIn),
  );
  expect(playback.status).toBe(200);

  const events = ndjsonLines(await playback.text());
  expect(events).toHaveLength(20);
  const indices = events.map((event) => numberOf(asRecord(dataOf(event).payload).index));
  expect(indices).toEqual(Array.from({ length: 20 }, (_, index) => index));
});

it("recordings-19 · posthog-js's bare array, gzip as text/plain, is stored", async () => {
  const project = await recordingProject();
  const sessionId = newSessionId();
  const request = await snapshotRequest([
    jsSnapshot(project.token, {
      sessionId,
      data: [metaEvent("https://www.example.com/", 1280, 800, T0)],
    }),
  ]);

  expect(request.headers.get("content-type")).toBe("text/plain");
  expect(request.headers.get("origin")).toBe(ORIGIN);

  const response = await capture(request);
  expect(response.status).toBe(200);
  const [row] = await storedChunks(project.id);
  if (row === undefined) throw new Error("the project stored no chunk");
  expect(row.sessionId).toBe(sessionId);
});

it("recordings-19 · posthog-ios's api_key per event and absent sent_at are read, its times kept", async () => {
  const project = await recordingProject();
  const sessionId = newSessionId();
  const event = iosSnapshot(project.token, {
    sessionId,
    data: [metaEvent("https://www.example.com/", 1280, 800, T0), fullSnapshotEvent(T0 + 500)],
  });

  expect(event.api_key).toBe(project.token);
  expect(event.properties).toMatchObject({ $snapshot_source: "mobile" });
  expect("sent_at" in event).toBe(false);

  const response = await capture(await iosSnapshotRequest([event]));
  expect(response.status).toBe(200);

  const row = await onlyChunk(project.id);
  expect(row.sessionId).toBe(sessionId);
  expect(row.firstTs).toBe(T0);
  expect(row.lastTs).toBe(T0 + 500);
});

it("recordings-19 · a snapshot with no $snapshot_source is still stored", async () => {
  const project = await recordingProject();
  const sessionId = newSessionId();
  const event = iosSnapshot(project.token, {
    sessionId,
    data: [metaEvent("https://www.example.com/", 1280, 800, T0)],
  });
  const properties = asRecord(event.properties);
  delete properties.$snapshot_source;
  expect("$snapshot_source" in properties).toBe(false);

  const response = await capture(await iosSnapshotRequest([event]));
  expect(response.status).toBe(200);
  expect(await storedChunks(project.id)).toHaveLength(1);
});

it("recordings-20 · one request holding two sessions stores two chunks", async () => {
  const project = await recordingProject();
  const sessionA = newSessionId();
  const sessionB = newSessionId();

  const response = await capture(
    await snapshotRequest([
      jsSnapshot(project.token, {
        sessionId: sessionA,
        data: [metaEvent("https://www.example.com/", 1280, 800, T0)],
      }),
      jsSnapshot(project.token, {
        sessionId: sessionB,
        data: [metaEvent("https://www.example.com/", 1280, 800, T0 + 1)],
      }),
    ]),
  );
  expect(response.status).toBe(200);

  const chunks = await storedChunks(project.id);
  expect(chunks.map((chunk) => chunk.sessionId)).toEqual(
    expect.arrayContaining([sessionA, sessionB]),
  );
  expect(chunks).toHaveLength(2);
  expect(await storedRecordings(project.id)).toHaveLength(2);
});

it("recordings-21 · a snapshot with no $session_id is dropped and the others are stored", async () => {
  const project = await recordingProject();
  const goodSession = newSessionId();
  const good = jsSnapshot(project.token, {
    sessionId: goodSession,
    data: [metaEvent("https://www.example.com/", 1280, 800, T0)],
  });
  const noSession = jsSnapshot(project.token, {
    sessionId: newSessionId(),
    data: [metaEvent("https://www.example.com/", 1280, 800, T0 + 1)],
  });
  delete asRecord(noSession.properties).$session_id;

  const response = await capture(await snapshotRequest([noSession, good]));
  expect(response.status).toBe(200);
  expect(await answerJson(response)).toEqual({ status: 1 });

  const chunks = await storedChunks(project.id);
  expect(chunks.map((chunk) => chunk.sessionId)).toEqual([goodSession]);
});

it("recordings-22 · a $pageview sent to /s/ stores nothing in any table", async () => {
  const project = await recordingProject();
  const pageview = jsEvent(project.token, {
    event: "$pageview",
    distinctId: "anon-22",
    properties: {},
  });

  const response = await capture(await snapshotRequest([pageview]));
  expect(response.status).toBe(200);
  expect(await answerJson(response)).toEqual({ status: 1 });

  expect(await storedChunks(project.id)).toEqual([]);
  expect(await storedRecordings(project.id)).toEqual([]);
  expect(await r2Keys(`${project.id}/`)).toEqual([]);
});

it("recordings-23 · with two tokens in one array, only the first token's project stores", async () => {
  const first = await recordingProject();
  const second = await recordingProject();
  const sessionFirst = newSessionId();
  const sessionSecond = newSessionId();

  const response = await capture(
    await snapshotRequest([
      jsSnapshot(first.token, {
        sessionId: sessionFirst,
        data: [metaEvent("https://www.example.com/", 1280, 800, T0)],
      }),
      jsSnapshot(second.token, {
        sessionId: sessionSecond,
        data: [metaEvent("https://www.example.com/", 1280, 800, T0 + 1)],
      }),
    ]),
  );
  expect(response.status).toBe(200);

  const chunks = await storedChunks(first.id);
  expect(chunks.map((chunk) => chunk.sessionId)).toEqual([sessionFirst]);
  expect(await wasContacted(second.id)).toBe(false);
});

it("recordings-24 · one chunk of 3 MiB is stored whole", async () => {
  const project = await recordingProject();
  const sessionId = newSessionId();
  const payload = "y".repeat(3 * 1024 * 1024);

  const response = await capture(
    await snapshotRequest([
      jsSnapshot(project.token, { sessionId, data: [inputEvent(10, payload, T0)] }),
    ]),
  );
  expect(response.status).toBe(200);

  const row = await onlyChunk(project.id);
  const events = await chunkEvents(row.objectKey);
  const [input] = events ?? [];
  if (input === undefined) throw new Error("the stored object held no event");
  expect(dataOf(input).text).toBe("*".repeat(payload.length));
});

it("recordings-25 · compressed fields are decoded and the typed text scrubbed before the object is written", async () => {
  const project = await recordingProject();
  const sessionId = newSessionId();
  const data = [
    await compressed(
      fullSnapshotEvent(T0, [{ id: 10, tagName: "input", attributes: { value: "hunter2" } }]),
    ),
    await compressed(inputEvent(10, "typed", T0 + 1)),
    await compressed(
      mutationEvent(T0 + 2, { attributes: [{ id: 10, attributes: { value: "changed" } }] }),
    ),
  ];

  const response = await capture(
    await snapshotRequest([jsSnapshot(project.token, { sessionId, data })]),
  );
  expect(response.status).toBe(200);

  const row = await onlyChunk(project.id);
  const events = await chunkEvents(row.objectKey);
  if (events === null) throw new Error("the chunk object is missing");
  for (const event of events) expect("cv" in event).toBe(false);

  const text = JSON.stringify(events);
  expect(text).not.toContain("hunter2");
  expect(text).not.toContain("typed");
  expect(text).not.toContain("changed");
  expect(text).toContain("*******");
  expect(text).toContain("*****");
});

it("recordings-26 · a network plugin event is dropped before the object is written and console events stay", async () => {
  const project = await recordingProject();
  const sessionId = newSessionId();
  const data = [networkEvent(T0), consoleEvent(T0 + 1)];

  const response = await capture(
    await snapshotRequest([jsSnapshot(project.token, { sessionId, data })]),
  );
  expect(response.status).toBe(200);

  const row = await onlyChunk(project.id);
  const events = await chunkEvents(row.objectKey);
  expect(events).toHaveLength(1);
  const [kept] = events ?? [];
  if (kept === undefined) throw new Error("the stored object held no event");
  expect(dataOf(kept)).toMatchObject({ plugin: "rrweb/console@1" });
});

it("recordings-28 · a client clock an hour ahead gives a chunk starting an hour before its rrweb times", async () => {
  const project = await recordingProject();
  const sessionId = newSessionId();
  const app = appAt(() => T0, mountRecordings);
  const request = await snapshotRequest([
    jsSnapshot(project.token, {
      sessionId,
      data: [
        metaEvent("https://www.example.com/", 1280, 800, T0 + HOUR_MS),
        fullSnapshotEvent(T0 + HOUR_MS + 1000),
      ],
      sentAt: iso(T0 + HOUR_MS),
    }),
  ]);

  const response = await fetchApp(app, request);
  expect(response.status).toBe(200);

  const row = await onlyChunk(project.id);
  expect(row.firstTs).toBe(T0);
  expect(row.lastTs).toBe(T0 + 1000);
  const [recording] = await storedRecordings(project.id);
  if (recording === undefined) throw new Error("the project stored no recording");
  expect(recording.startTs).toBe(T0);
  expect(recording.endTs).toBe(T0 + 1000);
});

it("recordings-29 · a recording whose distinct id is identified later is listed with the person", async () => {
  const project = await recordingProject();
  const sessionId = newSessionId();
  const distinctId = "anon-29-http";
  await snapshotsDirect(
    snapshotRequestOf(project.id, [await snapshotChunk({ sessionId, distinctId })]),
  );

  const identified = await capture(
    await jsRequest(
      jsBatch(project.token, [
        {
          event: "$identify",
          distinctId,
          properties: { $session_id: sessionId },
          set: { email: "owner@example.test" },
        },
      ]),
      "gzip",
    ),
  );
  expect(identified.status).toBe(200);

  const signedIn = await dashboardSession();
  const response = await capture(dashboardGet(`/api/projects/${project.id}/recordings`, signedIn));
  expect(response.status).toBe(200);

  const body = await answerJson(response);
  expect(body).toMatchObject({ recordings: [{ sessionId }] });
  const [summary] = recordingsOf(body);
  if (summary === undefined) throw new Error("the list route held no recording");
  expect(summary.personId).toEqual(expect.any(Number));
});

it("recordings-30 · the counter and the row count the gzipped object, not $snapshot_bytes", async () => {
  const project = await recordingProject();
  const sessionId = newSessionId();
  const app = appAt(() => T0, mountRecordings);
  const data = [inputEvent(10, "x".repeat(10_000), T0)];
  const snapshotBytes = jsonBytes(data).byteLength;

  const request = await snapshotRequest([
    jsSnapshot(project.token, { sessionId, data, sentAt: iso(T0) }),
  ]);
  const response = await fetchApp(app, request);
  expect(response.status).toBe(200);

  const row = await onlyChunk(project.id);
  const bytes = await r2Bytes(row.objectKey);
  if (bytes === null) throw new Error("the chunk object is missing");
  expect(row.bytes).toBe(bytes.byteLength);
  expect(row.bytes).not.toBe(snapshotBytes);
  expect(await counterValue(project.id, DAY, "recording_bytes")).toBe(bytes.byteLength);
});

it("recordings-32 · text in a full snapshot and in a mutation's value changes is masked in the stored object", async () => {
  const project = await recordingProject();
  const sessionId = newSessionId();
  const data = [
    fullSnapshotEvent(T0, [
      { id: 10, tagName: "input", attributes: { value: "hunter2" } },
      { id: 11, tagName: "textarea", attributes: { value: "hello" } },
    ]),
    mutationEvent(T0 + 1, {
      attributes: [{ id: 10, attributes: { value: "typed" } }],
      adds: [addedNode(4, { id: 13, tagName: "input", attributes: { value: "fresh" } })],
    }),
  ];

  const response = await capture(
    await snapshotRequest([jsSnapshot(project.token, { sessionId, data })]),
  );
  expect(response.status).toBe(200);

  const row = await onlyChunk(project.id);
  const events = await chunkEvents(row.objectKey);
  if (events === null) throw new Error("the chunk object is missing");
  const text = JSON.stringify(events);
  for (const typed of ["hunter2", "hello", "typed", "fresh"]) expect(text).not.toContain(typed);
  expect(text).toContain("*******");
  expect(text).toContain("*****");
  expect(text).toContain("******");
});

// ----------------------------------------------------- limits and CORS

it("intake-05 · a /s/ body over 25 MiB decoded is a 413 and stores nothing", async () => {
  const project = await recordingProject();
  const huge = "z".repeat(26 * 1024 * 1024);
  const request = await snapshotRequest([
    jsSnapshot(project.token, { sessionId: newSessionId(), data: [inputEvent(10, huge, T0)] }),
  ]);

  const response = await capture(request);
  expect(response.status).toBe(413);
  expect(await answerJson(response)).toEqual({
    code: "body_too_large",
    message: expect.any(String),
  });
  expect(await wasContacted(project.id)).toBe(false);
  expect(await r2Keys(`${project.id}/`)).toEqual([]);
});

it("intake-12 · a preflight on /s/ and /s mirrors the origin and echoes the requested headers", async () => {
  for (const path of ["/s/", "/s"]) {
    const response = await capture(preflightRequest(path));
    expect(response.status).toBe(200);
    expectCors(response, ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(response.headers.get("access-control-max-age")).toBe("86400");

    const asked = await capture(preflightRequest(path, ORIGIN, "content-type, x-extra"));
    expect(asked.headers.get("access-control-allow-headers")).toBe("content-type, x-extra");
  }
});

it("intake-12 · /s/ answers 200 and 401 with the origin mirrored in CORS", async () => {
  const project = await seedProject();
  const accepted = await capture(
    await snapshotRequest([
      jsSnapshot(project.token, {
        sessionId: newSessionId(),
        data: [metaEvent("https://www.example.com/", 1280, 800, T0)],
      }),
    ]),
  );
  expect(accepted.status).toBe(200);
  expectCors(accepted, ORIGIN);

  const refused = await capture(
    await snapshotRequest([
      jsSnapshot("cfa_pk_unknown", {
        sessionId: newSessionId(),
        data: [metaEvent("https://www.example.com/", 1280, 800, T0)],
      }),
    ]),
  );
  expect(refused.status).toBe(401);
  expectCors(refused, ORIGIN);
});

it("intake-12 · a 413 carries the same CORS headers", async () => {
  const project = await recordingProject();
  const huge = "z".repeat(26 * 1024 * 1024);
  const response = await capture(
    await snapshotRequest([
      jsSnapshot(project.token, { sessionId: newSessionId(), data: [inputEvent(10, huge, T0)] }),
    ]),
  );

  expect(response.status).toBe(413);
  expectCors(response, ORIGIN);
});

it("cookieless-15 · a cookieless $snapshot stores nothing", async () => {
  const project = await recordingProject();

  const response = await capture(
    await snapshotRequest([
      jsSnapshot(project.token, {
        sessionId: newSessionId(),
        distinctId: COOKIELESS_SENTINEL,
        data: [metaEvent("https://www.example.com/", 1280, 800, T0)],
      }),
    ]),
  );

  expect(response.status).toBe(200);
  expect(await answerJson(response)).toEqual({ status: 1 });
  expect(await storedChunks(project.id)).toEqual([]);
  expect(await storedRecordings(project.id)).toEqual([]);
});

it("recordings-34 · the list filters by person, page, event and length, all that are given", async () => {
  const project = await recordingProject();
  const person = await seedPerson(project.id, ["user-34", "anon-34"]);
  const [linked, other, long] = [newSessionId(), newSessionId(), newSessionId()];
  await snapshotsDirect(
    snapshotRequestOf(project.id, [
      // The person's recording under their anonymous id, one second long.
      await snapshotChunk({ sessionId: linked, distinctId: "anon-34" }),
      await snapshotChunk({ sessionId: other, distinctId: "someone-else" }),
      // Ten minutes long.
      await snapshotChunk({
        sessionId: long,
        distinctId: "someone-else",
        meta: { firstTs: T0, lastTs: T0 + 600_000 },
      }),
    ]),
  );
  await seedEvents(project.id, [
    {
      ts: T0,
      distinctId: "anon-34",
      personId: person,
      sessionId: linked,
      page: "www.example.com/pricing",
      event: "signup",
    },
    { ts: T0, distinctId: "someone-else", sessionId: other, page: "www.example.com/demo" },
  ]);
  const signedIn = await dashboardSession();
  const listed = async (query: string): Promise<string[]> => {
    const response = await capture(
      dashboardGet(`/api/projects/${project.id}/recordings?${query}`, signedIn),
    );
    expect(response.status).toBe(200);
    return recordingsOf(await answerJson(response)).map((row) => row.sessionId);
  };

  expect(await listed("person=user-34")).toEqual([linked]);
  expect(await listed("page=www.example.com%2Fpricing")).toEqual([linked]);
  expect(await listed("event=signup")).toEqual([linked]);
  expect(await listed("minDuration=60000")).toEqual([long]);
  expect(await listed("page=www.example.com%2Fdemo&event=signup")).toEqual([]);
  expect((await listed("")).toSorted()).toEqual([linked, other, long].toSorted());

  for (const bad of ["minDuration=-1", "minDuration=1.5", `event=${"x".repeat(201)}`, "person="]) {
    const response = await capture(
      dashboardGet(`/api/projects/${project.id}/recordings?${bad}`, signedIn),
    );
    expect(response.status).toBe(400);
  }
});

it("recordings-35 · each listed recording names the distinct pages its session visited", async () => {
  const project = await recordingProject();
  const sessionId = newSessionId();
  await snapshotsDirect(snapshotRequestOf(project.id, [await snapshotChunk({ sessionId })]));
  await seedEvents(project.id, [
    { ts: T0, sessionId, page: "www.example.com/" },
    { ts: T0 + 1000, sessionId, page: "www.example.com/pricing" },
    { ts: T0 + 2000, sessionId, page: "www.example.com/" },
    { ts: T0 + 3000, sessionId, page: null },
  ]);
  const response = await capture(
    dashboardGet(`/api/projects/${project.id}/recordings`, await dashboardSession()),
  );
  const [row] = recordingsOf(await answerJson(response));
  expect(row?.pages).toEqual(["www.example.com/", "www.example.com/pricing"]);
});
