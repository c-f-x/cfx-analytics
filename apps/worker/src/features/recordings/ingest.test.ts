import { STORE_GUARD_BYTES } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import {
  counterValue,
  dayIn,
  fixedSources,
  incomingEvent,
  ingestDirect,
  ingestRequest,
  inStore,
  newUuid,
  storedCounters,
  storedEvents,
  T0,
} from "../../../test/helpers/capture.ts";
import { newProjectId } from "../../../test/helpers/registry.ts";
import {
  chunkEvents,
  fullSnapshotEvent,
  inputEvent,
  r2Keys,
  snapshotChunk,
  snapshotRequestOf,
  snapshotsDirect,
  snapshotsRpc,
  storedChunks,
} from "../../../test/helpers/replay.ts";
import type { SnapshotChunk } from "../../platform/ingest.ts";

// ingestSnapshots inside a real ProjectStore against the real RECORDINGS
// bucket (recordings-03, recordings-07, recordings-09 to recordings-12,
// recordings-17, recordings-27, recordings-30, events-12). Every request
// carries its own arrival time T0 and its own project, so no test depends on
// the real clock or shares a counter with another.

const OSLO = "Europe/Oslo";
const DAY = dayIn(T0, OSLO);

/** A request for a seeded project's own settings; the cap is the test's to choose. */
function requestOf(
  projectId: string,
  chunks: SnapshotChunk[],
  cap = 500_000_000,
): ReturnType<typeof snapshotRequestOf> {
  return snapshotRequestOf(projectId, chunks, {
    settings: { daily_recording_bytes_cap: cap, timezone: OSLO },
  });
}

/** One chunk whose gzipped bytes are exactly `bytes` long, so the cap counts what the test says. */
async function chunkOfBytes(
  bytes: number,
  options: { uuid?: string; sessionId?: string } = {},
): Promise<SnapshotChunk> {
  const chunk = await snapshotChunk(options);
  return { ...chunk, gzipped: new Uint8Array(bytes) };
}

/** Places the day's recording bytes counter at `value`, as earlier traffic would have. */
async function takeBytes(projectId: string, value: number): Promise<void> {
  await inStore(projectId, (sql) => {
    sql.exec(
      "INSERT INTO counters (day, name, value) VALUES (?, 'recording_bytes', ?)",
      DAY,
      value,
    );
    return null;
  });
}

it("recordings-03 · a chunk when the cap is already taken stays out of the bucket", async () => {
  const project = newProjectId();
  await takeBytes(project, 1000);

  const answer = await snapshotsDirect(requestOf(project, [await chunkOfBytes(100)], 1000));

  expect(answer).toEqual({ ok: true, value: { stored: 0, quotaLimited: true } });
  expect(await r2Keys(`${project}/`)).toEqual([]);
  expect(await counterValue(project, DAY, "recording_bytes")).toBe(1000);
});

it("recordings-03 · a chunk of exactly the bytes left under the cap is stored", async () => {
  const project = newProjectId();
  await takeBytes(project, 800);

  const answer = await snapshotsDirect(requestOf(project, [await chunkOfBytes(200)], 1000));

  expect(answer).toEqual({ ok: true, value: { stored: 1, quotaLimited: false } });
  expect(await counterValue(project, DAY, "recording_bytes")).toBe(1000);
  expect(await storedChunks(project)).toHaveLength(1);
  expect(await r2Keys(`${project}/`)).toHaveLength(1);
});

it("recordings-03 · a chunk one byte over what is left is refused whole", async () => {
  const project = newProjectId();
  await takeBytes(project, 800);

  const answer = await snapshotsDirect(requestOf(project, [await chunkOfBytes(201)], 1000));

  expect(answer).toEqual({ ok: true, value: { stored: 0, quotaLimited: true } });
  expect(await counterValue(project, DAY, "recording_bytes")).toBe(800);
  expect(await storedChunks(project)).toEqual([]);
  expect(await r2Keys(`${project}/`)).toEqual([]);
});

it("recordings-07 · a stored chunk's R2 key is the project, session, arrival time and uuid", async () => {
  const project = newProjectId();
  const session = newUuid();
  const uuid = newUuid();

  const answer = await snapshotsDirect(
    requestOf(project, [await snapshotChunk({ uuid, sessionId: session })]),
  );
  expect(answer).toEqual({ ok: true, value: { stored: 1, quotaLimited: false } });

  const key = `${project}/${session}/${T0}-${uuid}.ndjson.gz`;
  expect(await r2Keys(`${project}/`)).toEqual([key]);
  const [row] = await storedChunks(project);
  if (row === undefined) throw new Error("the store wrote no chunk row");
  expect(row.objectKey).toBe(key);
});

it("recordings-09 · the stored object gunzips to the chunk's events, in order", async () => {
  const project = newProjectId();
  const events = [fullSnapshotEvent(T0), inputEvent(10, "ab", T0 + 500)];

  await snapshotsDirect(requestOf(project, [await snapshotChunk({ events })]));

  const [row] = await storedChunks(project);
  if (row === undefined) throw new Error("the store wrote no chunk row");
  expect(await chunkEvents(row.objectKey)).toEqual(events);
});

it("recordings-10 · three chunks at once take only the two that fit and the third is quota-limited", async () => {
  const project = newProjectId();
  await takeBytes(project, 600);
  const requests = await Promise.all(
    Array.from({ length: 3 }, async () => requestOf(project, [await chunkOfBytes(200)], 1000)),
  );

  const answers = await Promise.all(requests.map((request) => snapshotsRpc(request)));
  const values = answers.map((answer) => {
    if (!answer.ok) throw new Error(`a chunk failed: ${JSON.stringify(answer.error)}`);
    return answer.value;
  });

  expect(values.filter((value) => value.stored === 1)).toHaveLength(2);
  expect(values.filter((value) => value.quotaLimited)).toHaveLength(1);
  expect(await counterValue(project, DAY, "recording_bytes")).toBe(1000);
  expect(await storedChunks(project)).toHaveLength(2);
  expect(await r2Keys(`${project}/`)).toHaveLength(2);
});

it("recordings-11 · a stored chunk moves the recording bytes counter and leaves the events one alone", async () => {
  const project = newProjectId();

  await snapshotsDirect(requestOf(project, [await chunkOfBytes(123)]));

  expect(await counterValue(project, DAY, "events")).toBeNull();
  expect(await counterValue(project, DAY, "recording_bytes")).toBe(123);
  expect(await storedCounters(project)).toEqual([
    { day: DAY, name: "recording_bytes", value: 123 },
  ]);
});

it("recordings-12 · the same chunk stored twice is written once", async () => {
  const project = newProjectId();
  const request = requestOf(project, [await chunkOfBytes(111)]);

  expect(await snapshotsDirect(request)).toEqual({
    ok: true,
    value: { stored: 1, quotaLimited: false },
  });
  expect(await snapshotsDirect(request)).toEqual({
    ok: true,
    value: { stored: 0, quotaLimited: false },
  });

  expect(await storedChunks(project)).toHaveLength(1);
  expect(await r2Keys(`${project}/`)).toHaveLength(1);
  expect(await counterValue(project, DAY, "recording_bytes")).toBe(111);
});

it("recordings-12 · the same chunk sent twice at once is written once", async () => {
  const project = newProjectId();
  const request = requestOf(project, [await chunkOfBytes(111)]);

  const answers = await Promise.all([snapshotsRpc(request), snapshotsRpc(request)]);
  const values = answers.map((answer) => {
    if (!answer.ok) throw new Error(`a chunk failed: ${JSON.stringify(answer.error)}`);
    return answer.value;
  });

  expect(values.reduce((sum, value) => sum + value.stored, 0)).toBe(1);
  expect(await storedChunks(project)).toHaveLength(1);
  expect(await r2Keys(`${project}/`)).toHaveLength(1);
  expect(await counterValue(project, DAY, "recording_bytes")).toBe(111);
});

it("recordings-17 · a chunk whose row the store refuses keeps its object and its counted bytes", async () => {
  const project = newProjectId();
  // The table is the last guard: without it the row cannot be written, and the
  // object and the reservation are already made.
  await inStore(project, (sql) => {
    sql.exec("DROP TABLE recordings");
    return null;
  });

  const chunk = await chunkOfBytes(90, { sessionId: newUuid(), uuid: newUuid() });
  const answer = await snapshotsDirect(requestOf(project, [chunk]));

  if (answer.ok) throw new Error("a chunk whose row the store refused was accepted");
  expect(answer.error).toEqual({
    kind: "row refused",
    uuid: chunk.uuid,
    message: expect.any(String),
  });

  const key = `${project}/${chunk.sessionId}/${T0}-${chunk.uuid}.ndjson.gz`;
  expect(await r2Keys(`${project}/`)).toEqual([key]);
  expect(await counterValue(project, DAY, "recording_bytes")).toBe(90);
});

it("recordings-27 · a stored chunk keeps the path and width its metadata found", async () => {
  const project = newProjectId();

  await snapshotsDirect(
    requestOf(project, [
      await snapshotChunk({
        meta: { firstTs: T0, lastTs: T0 + 1000, snapshotPath: "/pricing", snapshotWidth: 1280 },
      }),
    ]),
  );

  const [row] = await storedChunks(project);
  if (row === undefined) throw new Error("the store wrote no chunk row");
  expect(row.snapshotPath).toBe("/pricing");
  expect(row.snapshotWidth).toBe(1280);
});

it("recordings-30 · the counter grows by each chunk's gzipped length", async () => {
  const project = newProjectId();

  await snapshotsDirect(requestOf(project, [await chunkOfBytes(100)]));
  expect(await counterValue(project, DAY, "recording_bytes")).toBe(100);

  await snapshotsDirect(requestOf(project, [await chunkOfBytes(50)]));
  expect(await counterValue(project, DAY, "recording_bytes")).toBe(150);
});

it("events-12 · a store at the size guard stores no event and still stores a chunk", async () => {
  const project = newProjectId();

  const batch = await ingestDirect(
    ingestRequest(project, [incomingEvent({ uuid: newUuid() })]),
    fixedSources({ databaseSize: STORE_GUARD_BYTES }),
  );
  expect(batch).toEqual({ ok: true, value: { stored: 0, quotaLimited: true } });
  expect(await storedEvents(project)).toEqual([]);

  const answer = await snapshotsDirect(requestOf(project, [await chunkOfBytes(80)]));
  expect(answer).toEqual({ ok: true, value: { stored: 1, quotaLimited: false } });
  expect(await storedChunks(project)).toHaveLength(1);
});

it("recordings-17 · a chunk row the store refuses leaves the recording's row as it was", async () => {
  // recordChunk writes the recording's row, then the chunk's. When the second
  // fails, the first must not stay behind: a retry would add its counts again.
  // A row already holding the new chunk's object key, under another uuid,
  // makes the chunk's insert fail after the recording's row is written.
  const project = newProjectId();
  const sessionId = newUuid();
  const chunk = await chunkOfBytes(90, { sessionId, uuid: newUuid() });
  const key = `${project}/${sessionId}/${T0}-${chunk.uuid}.ndjson.gz`;
  await inStore(project, (sql) => {
    sql.exec(
      `INSERT INTO recordings (session_id, distinct_id, start_ts, end_ts, active_ms,
         first_url, clicks, keypresses, bytes) VALUES (?, 'anon-1', ?, ?, 0, NULL, 0, 0, 0)`,
      sessionId,
      T0,
      T0,
    );
    sql.exec(
      `INSERT INTO recording_chunks (uuid, session_id, object_key, first_ts, last_ts,
         received_at, bytes) VALUES (?, ?, ?, ?, ?, ?, 0)`,
      newUuid(),
      sessionId,
      key,
      T0,
      T0,
      T0,
    );
    return null;
  });

  const answer = await snapshotsDirect(requestOf(project, [chunk]));
  expect(answer.ok).toBe(false);

  const recordings = await inStore(project, (sql) =>
    sql.exec("SELECT bytes, clicks FROM recordings").toArray(),
  );
  expect(recordings).toEqual([{ bytes: 0, clicks: 0 }]);
});
