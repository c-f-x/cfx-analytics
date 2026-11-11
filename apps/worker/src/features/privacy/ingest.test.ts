import { env, runInDurableObject } from "cloudflare:test";
import { DAY_MS, type ErasedCounts } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import {
  cookielessIncoming,
  fixedSources,
  ingestDirect,
  ingestRequest,
  inStore,
  newUuid,
  personIdOf,
  storedEvents,
  storedPersons,
  storedSalts,
  storeOf,
  T0,
} from "../../../test/helpers/capture.ts";
import { newProjectId, seedProject } from "../../../test/helpers/registry.ts";
import {
  r2Bytes,
  r2Keys,
  refusingDeletes,
  snapshotChunk,
  snapshotRequestOf,
  snapshotsDirect,
  storedChunks,
  storedPoints,
  storedRecordings,
} from "../../../test/helpers/replay.ts";
import { seedEvents, seedFixture, seedPerson } from "../../../test/helpers/seed.ts";
import { erasePerson, exportPage } from "../../platform/ingest.ts";

// A deletion by person, the export's pages, the day's salt and the alarm a
// call sets (privacy-02, privacy-05, privacy-09, privacy-10, privacy-16,
// privacy-17, privacy-19, privacy-25, platform-27), all run inside a real
// ProjectStore with the real RECORDINGS bucket.

/** The counts of a deletion that found nothing, zeros included (privacy-17). */
function zeros(): ErasedCounts {
  return {
    events: 0,
    persons: 0,
    person_distinct_ids: 0,
    recordings: 0,
    recording_chunks: 0,
    heatmap_points: 0,
    objects: 0,
  };
}

/** One project's store, with its own rows for this test. */
async function freshProject() {
  return seedProject({ id: newProjectId() });
}

/** erasePerson inside the project's object, against `bucket`. */
function eraseIn(projectId: string, distinctId: string, bucket: R2Bucket = env.RECORDINGS) {
  return inStore(projectId, (_sql, storage) => erasePerson(storage, bucket, distinctId));
}

it("privacy-02 · a deletion by person removes its events, its person and every id, in one call", async () => {
  const project = await freshProject();
  const person = await seedPerson(project.id, ["erase-2a", "erase-2b"]);
  await seedEvents(project.id, [
    { ts: T0, distinctId: "erase-2a", personId: person },
    { ts: T0 + 1000, event: "$pageleave", distinctId: "erase-2b", personId: person },
  ]);

  const result = await eraseIn(project.id, "erase-2a");

  expect(result).toEqual({
    ok: true,
    value: { ...zeros(), events: 2, persons: 1, person_distinct_ids: 2 },
  });
  expect(await storedEvents(project.id)).toEqual([]);
  expect(await storedPersons(project.id)).toEqual([]);
  expect(await personIdOf(project.id, "erase-2b")).toBeNull();
});

it("privacy-05 · a deletion by person takes its recordings, their objects and its heatmap points", async () => {
  const project = await freshProject();
  await seedPerson(project.id, ["erase-5"]);
  const chunk = await snapshotChunk({ distinctId: "erase-5" });
  const stored = await snapshotsDirect(snapshotRequestOf(project.id, [chunk]));
  expect(stored.ok).toBe(true);
  await ingestDirect(
    ingestRequest(project.id, [], {
      points: [
        {
          eventUuid: newUuid(),
          seq: 0,
          host: "www.example.com",
          path: "/heat",
          widthBand: 1200,
          x: 10,
          y: 20,
          kind: "click",
          fixed: false,
          bot: false,
          ts: T0,
          sessionId: null,
          distinctId: "erase-5",
        },
      ],
    }),
  );
  const objects = await r2Keys(`${project.id}/`);
  expect(objects).toHaveLength(1);

  const result = await eraseIn(project.id, "erase-5");

  expect(result).toEqual({
    ok: true,
    value: {
      ...zeros(),
      persons: 1,
      person_distinct_ids: 1,
      recordings: 1,
      recording_chunks: 1,
      heatmap_points: 1,
      objects: 1,
    },
  });
  expect(await storedRecordings(project.id)).toEqual([]);
  expect(await storedChunks(project.id)).toEqual([]);
  expect(await storedPoints(project.id)).toEqual([]);
  expect(await r2Keys(`${project.id}/`)).toEqual([]);
  for (const key of objects) expect(await r2Bytes(key)).toBeNull();
});

it("privacy-09 · a day's salt is the bytes the random source made", async () => {
  const project = await freshProject();
  const salt = Uint8Array.from({ length: 16 }, (_value, index) => index + 1);

  const result = await ingestDirect(
    ingestRequest(project.id, [cookielessIncoming()]),
    fixedSources({ salts: [salt] }),
  );

  expect(result).toEqual({ ok: true, value: { stored: 1, quotaLimited: false } });
  const salts = await storedSalts(project.id);
  expect(salts).toHaveLength(1);
  expect(salts[0]?.day).toBe("2026-10-21");
  expect([...(salts[0]?.salt ?? [])]).toEqual([...salt]);
});

it("privacy-10 · a new day's salt deletes the expired ones, so at most three exist", async () => {
  const project = await freshProject();
  for (const day of [0, 1, 2]) {
    const at = T0 + day * DAY_MS;
    const result = await ingestDirect(
      ingestRequest(project.id, [cookielessIncoming({ ts: at })], { receivedAt: at }),
      fixedSources({ salts: [Uint8Array.from({ length: 16 }, () => day + 1)] }),
    );
    expect(result.ok).toBe(true);
  }

  const salts = await storedSalts(project.id);

  expect(salts.length).toBeLessThanOrEqual(3);
  expect(salts.map((row) => row.day)).toEqual(["2026-10-22", "2026-10-23"]);
});

it("privacy-16 · events whose person_id is null are deleted by the id their row names", async () => {
  const project = await freshProject();
  await seedEvents(project.id, [
    { ts: T0, distinctId: "ghost-16", personId: null },
    { ts: T0 + 1000, event: "$pageleave", distinctId: "ghost-16", personId: null },
    { ts: T0, distinctId: "kept-16", personId: null },
  ]);

  const result = await eraseIn(project.id, "ghost-16");

  expect(result).toEqual({ ok: true, value: { ...zeros(), events: 2 } });
  expect((await storedEvents(project.id)).map((event) => event.distinctId)).toEqual(["kept-16"]);
});

it("privacy-17 · a deletion for an unknown id, and the same deletion twice, answer all zeros", async () => {
  const project = await freshProject();
  const person = await seedPerson(project.id, ["twice-17"]);
  await seedEvents(project.id, [{ ts: T0, distinctId: "twice-17", personId: person }]);

  expect(await eraseIn(project.id, "nobody-17")).toEqual({ ok: true, value: zeros() });
  expect(await eraseIn(project.id, "twice-17")).toEqual({
    ok: true,
    value: { ...zeros(), events: 1, persons: 1, person_distinct_ids: 1 },
  });
  expect(await eraseIn(project.id, "twice-17")).toEqual({ ok: true, value: zeros() });
});

it("privacy-19 · a failed object delete names its keys and keeps every row, and the repeat finishes", async () => {
  const project = await freshProject();
  const person = await seedPerson(project.id, ["erase-19"]);
  await seedEvents(project.id, [{ ts: T0, distinctId: "erase-19", personId: person }]);
  const chunk = await snapshotChunk({ distinctId: "erase-19" });
  const stored = await snapshotsDirect(snapshotRequestOf(project.id, [chunk]));
  expect(stored.ok).toBe(true);
  const [key] = await r2Keys(`${project.id}/`);
  if (key === undefined) throw new Error("the recording's object was not written");

  const failed = await eraseIn(project.id, "erase-19", refusingDeletes(env.RECORDINGS, [key]));

  expect(failed).toEqual({ ok: false, error: { kind: "r2 failed", keys: [key] } });
  expect(await storedEvents(project.id)).toHaveLength(1);
  expect(await personIdOf(project.id, "erase-19")).toBe(person);
  expect(await storedRecordings(project.id)).toHaveLength(1);
  expect(await storedChunks(project.id)).toHaveLength(1);

  const repeat = await eraseIn(project.id, "erase-19");

  expect(repeat).toEqual({
    ok: true,
    value: {
      ...zeros(),
      events: 1,
      persons: 1,
      person_distinct_ids: 1,
      recordings: 1,
      recording_chunks: 1,
      objects: 1,
    },
  });
  expect(await storedEvents(project.id)).toEqual([]);
  expect(await r2Keys(`${project.id}/`)).toEqual([]);
});

it("privacy-25 · an export of 10,001 events gives 10,000 lines and a cursor, then one line and none", async () => {
  const project = await freshProject();
  await seedFixture(project.id, { events: 10_001, persons: 50, days: 30, end: T0 });

  const first = await inStore(project.id, (sql) => exportPage(sql, "events", 0));

  expect(first.lines).toHaveLength(10_000);
  expect(new Set(first.lines).size).toBe(10_000);
  expect(first.next).not.toBeNull();
  const cursor = first.next;
  if (cursor === null) throw new Error("the first page named no cursor");

  const second = await inStore(project.id, (sql) => exportPage(sql, "events", cursor));

  expect(second.lines).toHaveLength(1);
  expect(second.next).toBeNull();
  expect(first.lines).not.toContain(second.lines[0]);
  const line = second.lines[0];
  if (line === undefined) throw new Error("the second page held no line");
  // Event 10,000 of the fixture, the 10,001st: its uuid is a pure function of its index.
  expect(JSON.parse(line)).toMatchObject({ uuid: "00002710-0000-7000-8000-000000002710" });
});

it("platform-27 · a call to a store with no alarm sets one for the next daily sweep", async () => {
  const project = await freshProject();
  const stub = storeOf(project.id);
  await stub.ready();
  await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
  expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBeNull();

  const before = Date.now();
  expect(await stub.erasePerson("nobody-27")).toEqual({ ok: true, value: zeros() });
  const after = Date.now();

  const alarm = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
  if (alarm === null) throw new Error("the erase call left no alarm");
  expect(alarm).toBeGreaterThanOrEqual(before + DAY_MS);
  expect(alarm).toBeLessThanOrEqual(after + DAY_MS);
});
