import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { inStore, newUuid, T0 } from "../../../test/helpers/capture.ts";
import { newProjectId } from "../../../test/helpers/registry.ts";
import {
  type ChunkRow,
  chunksOf,
  firstMissing,
  latestSnapshot,
  listRecordings,
  recordChunk,
} from "./store.ts";

/** A list query with no filter (recordings-34). */
const NO_FILTERS = { person: null, page: null, event: null, minDurationMs: null };

// The recordings tables inside a real ProjectStore, reached through `inStore`
// (recordings-01, recordings-05, recordings-14, recordings-15, recordings-29,
// heatmaps-02). Each test takes a fresh project id, so no two tests share rows,
// and every chunk row is built with its own uuid and session.

/** One chunk row as the Worker hands it to the table. Overrides win, objectKey included. */
function chunkRow(overrides: Partial<ChunkRow> = {}): ChunkRow {
  const uuid = overrides.uuid ?? newUuid();
  const sessionId = overrides.sessionId ?? newUuid();
  return {
    uuid,
    sessionId,
    distinctId: "anon-1",
    objectKey: `${sessionId}/${T0}-${uuid}.ndjson.gz`,
    receivedAt: T0,
    bytes: 100,
    firstTs: T0,
    lastTs: T0 + 1000,
    snapshotPath: null,
    snapshotWidth: null,
    firstUrl: null,
    clicks: 0,
    keypresses: 0,
    activeMs: 0,
    ...overrides,
  };
}

/** Stores every row through recordChunk and fails the test if the table refuses one. */
async function storeChunks(projectId: string, rows: ChunkRow[]): Promise<void> {
  const writes = await inStore(projectId, (sql) => rows.map((row) => recordChunk(sql, row)));
  for (const write of writes) {
    if (!write.ok) throw new Error(`the store refused a chunk row: ${write.error.message}`);
  }
}

it("recordings-01 · chunksOf returns a session's chunks ordered by their first timestamp", async () => {
  const project = newProjectId();
  const session = newUuid();
  const late = chunkRow({ sessionId: session, firstTs: T0 + 2000, lastTs: T0 + 3000 });
  const early = chunkRow({ sessionId: session, firstTs: T0, lastTs: T0 + 1000 });
  const middle = chunkRow({ sessionId: session, firstTs: T0 + 1000, lastTs: T0 + 2000 });

  await storeChunks(project, [late, early, middle]);

  expect(await inStore(project, (sql) => chunksOf(sql, session))).toEqual([
    { uuid: early.uuid, objectKey: early.objectKey },
    { uuid: middle.uuid, objectKey: middle.objectKey },
    { uuid: late.uuid, objectKey: late.objectKey },
  ]);
});

it("recordings-14 · chunks with the same first time are ordered by arrival, then uuid", async () => {
  const project = newProjectId();
  const session = newUuid();
  const uuidA = "0199a0c0-0000-7000-8000-00000000000a";
  const uuidB = "0199a0c0-0000-7000-8000-00000000000b";
  const uuidC = "0199a0c0-0000-7000-8000-00000000000c";
  const a = chunkRow({ sessionId: session, uuid: uuidA, firstTs: T0, receivedAt: T0 + 100 });
  const b = chunkRow({ sessionId: session, uuid: uuidB, firstTs: T0, receivedAt: T0 + 100 });
  const c = chunkRow({ sessionId: session, uuid: uuidC, firstTs: T0, receivedAt: T0 + 200 });

  // Stored in the reverse of the order they must come back in.
  await storeChunks(project, [c, b, a]);

  const refs = await inStore(project, (sql) => chunksOf(sql, session));
  expect(refs.map((ref) => ref.uuid)).toEqual([uuidA, uuidB, uuidC]);
});

it("recordings-15 · chunksOf answers one session's chunks and none for an unknown session", async () => {
  const project = newProjectId();
  const session = newUuid();
  const other = newUuid();
  const first = chunkRow({ sessionId: session, firstTs: T0 });
  const second = chunkRow({ sessionId: session, firstTs: T0 + 1000, lastTs: T0 + 2000 });
  const elsewhere = chunkRow({ sessionId: other, firstTs: T0 });

  await storeChunks(project, [first, second, elsewhere]);

  const refs = await inStore(project, (sql) => chunksOf(sql, session));
  expect(refs.map((ref) => ref.uuid)).toEqual([first.uuid, second.uuid]);
  expect(await inStore(project, (sql) => chunksOf(sql, other))).toEqual([
    { uuid: elsewhere.uuid, objectKey: elsewhere.objectKey },
  ]);
  expect(await inStore(project, (sql) => chunksOf(sql, newUuid()))).toEqual([]);
});

it("recordings-05 · listRecordings folds a session's chunks into one summary", async () => {
  const project = newProjectId();
  const session = newUuid();
  const late = chunkRow({
    sessionId: session,
    firstTs: T0 + 1000,
    lastTs: T0 + 2000,
    receivedAt: T0 + 200,
    activeMs: 300,
    clicks: 1,
    keypresses: 2,
    bytes: 100,
    firstUrl: "https://www.example.com/late",
  });
  const early = chunkRow({
    sessionId: session,
    firstTs: T0,
    lastTs: T0 + 1500,
    receivedAt: T0 + 100,
    activeMs: 200,
    clicks: 0,
    keypresses: 1,
    bytes: 150,
    firstUrl: "https://www.example.com/early",
  });

  await storeChunks(project, [late, early]);

  expect(
    await inStore(project, (sql) =>
      listRecordings(sql, { limit: 50, before: null, filters: NO_FILTERS }),
    ),
  ).toEqual([
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
  ]);
});

it("recordings-29 · listRecordings names the person a distinct id is linked to", async () => {
  const project = newProjectId();
  const session = newUuid();
  const distinctId = "anon-29";
  await inStore(project, (sql) => {
    sql.exec("INSERT INTO persons (id, created_at, identified) VALUES (1, ?, 1)", T0);
    sql.exec("INSERT INTO person_distinct_ids (distinct_id, person_id) VALUES (?, 1)", distinctId);
    return null;
  });

  await storeChunks(project, [chunkRow({ sessionId: session, distinctId })]);

  const summaries = await inStore(project, (sql) =>
    listRecordings(sql, { limit: 50, before: null, filters: NO_FILTERS }),
  );
  const [summary] = summaries;
  if (summary === undefined) throw new Error("the store listed no recording");
  expect(summary.personId).toBe(1);
});

it("heatmaps-02 · latestSnapshot picks the newest snapshot in the width band", async () => {
  const project = newProjectId();
  const session = newUuid();
  const band = 1200;
  const older = chunkRow({
    sessionId: session,
    lastTs: T0 + 1000,
    snapshotPath: "/pricing",
    snapshotWidth: 1200,
  });
  const topEdge = chunkRow({
    sessionId: session,
    lastTs: T0 + 2000,
    snapshotPath: "/pricing",
    snapshotWidth: 1299,
  });
  const otherPath = chunkRow({
    sessionId: session,
    lastTs: T0 + 3000,
    snapshotPath: "/checkout",
    snapshotWidth: 1250,
  });
  const nextBand = chunkRow({
    sessionId: session,
    lastTs: T0 + 4000,
    snapshotPath: "/pricing",
    snapshotWidth: 1300,
  });

  await storeChunks(project, [older, topEdge, otherPath, nextBand]);

  expect(await inStore(project, (sql) => latestSnapshot(sql, "/pricing", band))).toEqual({
    sessionId: session,
    objectKey: topEdge.objectKey,
    width: 1299,
  });
  // The next band starts at 1300, so its snapshot is not in band 1200.
  expect(await inStore(project, (sql) => latestSnapshot(sql, "/pricing", 1300))).toEqual({
    sessionId: session,
    objectKey: nextBand.objectKey,
    width: 1300,
  });
  expect(await inStore(project, (sql) => latestSnapshot(sql, "/nowhere", band))).toBeNull();
});

it("recordings-16 · firstMissing finds the one missing chunk among more than a thousand", async () => {
  // A list page holds a thousand keys, so a long session's check reads more
  // than one page.
  const prefix = `${newProjectId()}/${newUuid()}/`;
  const chunks = Array.from({ length: 1002 }, (_, index) => ({
    uuid: `chunk-${index}`,
    objectKey: `${prefix}${T0 + index}-chunk-${index}.ndjson.gz`,
  }));
  const stored = chunks.slice(0, 1001);
  await Promise.all(stored.map((chunk) => env.RECORDINGS.put(chunk.objectKey, "x")));

  expect(await firstMissing(env.RECORDINGS, stored)).toBeNull();
  expect(await firstMissing(env.RECORDINGS, chunks)).toEqual(chunks[1001]);
  await Promise.all(stored.map((chunk) => env.RECORDINGS.delete(chunk.objectKey)));
});
