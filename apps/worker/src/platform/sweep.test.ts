import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import {
  DEFAULT_SETTINGS,
  ORPHAN_GRACE_MS,
  ORPHAN_SWEEP_KEYS,
  type ProjectSettings,
  STORE_GUARD_BYTES,
  SWEEP_BATCH_ROWS,
} from "@cfanalytics/shared";
import { expect, it } from "vitest";
import {
  CLIENT_IP,
  DAY_MS,
  fixedSources,
  incomingEvent,
  ingestDirect,
  ingestRequest,
  ingestRpc,
  inStore,
  jsBatch,
  jsRequest,
  MINUTE_MS,
  newUuid,
  storedCounters,
  storedEvents,
  storedPersons,
  storedSalts,
  storedSessions,
  storeOf,
  T0,
} from "../../test/helpers/capture.ts";
import { asRecord } from "../../test/helpers/json.ts";
import { newProjectId, seedProject } from "../../test/helpers/registry.ts";
import {
  r2Keys,
  refusingDeletes,
  snapshotChunk,
  snapshotRequestOf,
  snapshotsDirect,
  storedChunks,
  storedPoints,
  storedRecordings,
} from "../../test/helpers/replay.ts";
import { seedEvents, seedPerson } from "../../test/helpers/seed.ts";
import { SWEEP_ORDER } from "../features/privacy/index.ts";
import { NEXT_PASS_MS } from "./alarm.ts";
import { createLogger } from "./log.ts";
import type { Result } from "./result.ts";
import {
  type AlarmFailure,
  type AlarmOutcome,
  purge,
  runAlarm,
  type SweepOutcome,
  sweep,
} from "./sweep.ts";

// The daily sweep and the purge inside a real ProjectStore, with the real
// RECORDINGS bucket and registry (privacy-01, 03, 04, 06 to 08, 11 to 14 and
// 20 to 27; platform-27 to 31; projects-21; recordings-06 and 17;
// cookieless-04; events-09 and 12). Time is an argument everywhere but
// ProjectStore.alarm, which reads Date.now().

/** The four settings a sweep reads, from the defaults unless the test changes them. */
type SweepSettings = Pick<
  ProjectSettings,
  "events_retention_days" | "recordings_retention_days" | "heatmaps_retention_days" | "timezone"
>;

function settingsOf(overrides: Partial<SweepSettings> = {}): SweepSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

/** A project with its own registry row (and settings, when a test changes them). */
function freshProject(seed: { settings?: Partial<ProjectSettings>; deletedAt?: number } = {}) {
  return seedProject({ id: newProjectId(), ...seed });
}

/** Records the project id in the store as every RPC call does, storing no row. */
async function bindStore(projectId: string): Promise<void> {
  const answer = await ingestRpc(ingestRequest(projectId, []));
  if (!answer.ok) throw new Error("the store refused an empty batch");
}

/** One pass of the sweep, inside the project's object. */
async function sweepIn(
  projectId: string,
  settings: SweepSettings,
  now: number,
  batchRows: number,
  bucket: R2Bucket = env.RECORDINGS,
): Promise<SweepOutcome> {
  return await inStore(projectId, (_sql, storage) =>
    sweep(storage, bucket, projectId, settings, now, batchRows),
  );
}

/** One pass of the purge, inside the project's object. */
function purgeIn(
  projectId: string,
  maxKeys: number,
  bucket: R2Bucket = env.RECORDINGS,
  registry: D1Database = env.REGISTRY,
) {
  return inStore(projectId, (_sql, storage) =>
    purge(storage, bucket, registry, projectId, maxKeys),
  );
}

/**
 * The alarm's work at `now`, the lines its logger wrote and the alarm it left.
 * The alarm is read and deleted in the same object call that set it, so the
 * real ProjectStore.alarm never runs beside the test. workerd fires an alarm
 * set in the past at once, and getAlarm answers the wall clock for it, so a
 * test that checks the alarm's time runs at the wall clock, not at T0.
 */
async function runAlarmAt(
  projectId: string,
  now: number,
  batchRows: number = SWEEP_BATCH_ROWS,
): Promise<{ result: Result<AlarmOutcome, AlarmFailure>; lines: string[]; alarm: number | null }> {
  const lines: string[] = [];
  return await inStore(projectId, async (_sql, storage) => {
    const result = await runAlarm(
      storage,
      env,
      now,
      createLogger((line) => lines.push(line)),
      batchRows,
    );
    const alarm = await storage.getAlarm();
    await storage.deleteAlarm();
    return { result, lines, alarm };
  });
}

/** The alarm the store now holds. Read without inStore, which would set one. */
function alarmOf(projectId: string): Promise<number | null> {
  return runInDurableObject(storeOf(projectId), (_instance, state) => state.storage.getAlarm());
}

/** A sweep that finished, its outcome; anything else is a fault in the test. */
function swept(result: Result<AlarmOutcome, AlarmFailure>): SweepOutcome {
  if (!result.ok) throw new Error(`the alarm failed: ${result.error.kind}`);
  if (result.value.kind !== "swept") throw new Error(`the alarm answered ${result.value.kind}`);
  return result.value.outcome;
}

/** Whether every table, store_meta included, holds no row. */
function storeIsEmpty(projectId: string): Promise<boolean> {
  return inStore(projectId, (sql) => {
    const tables = sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => {
        const name: unknown = row.name;
        if (typeof name !== "string") throw new Error("expected a table name");
        return name;
      })
      .filter((name) => !name.startsWith("sqlite_") && !name.startsWith("_cf_"));
    return tables.every(
      (table) => Number(sql.exec(`SELECT COUNT(*) AS n FROM "${table}"`).one().n) === 0,
    );
  });
}

/** Writes objects of one byte under the real bucket, a hundred at a time. */
async function putObjects(keys: readonly string[]): Promise<void> {
  for (let start = 0; start < keys.length; start += 100) {
    await Promise.all(
      keys.slice(start, start + 100).map((key) => env.RECORDINGS.put(key, new Uint8Array([1]))),
    );
  }
}

/** The project's D1 row, or null. */
function projectRow(projectId: string): Promise<unknown> {
  return env.REGISTRY.prepare("SELECT * FROM projects WHERE id = ?").bind(projectId).first();
}

it("privacy-01 · 105 expired events go in batches, and the 2 inside stay", async () => {
  const cutoff = T0 - 30 * DAY_MS;
  const expired = Array.from({ length: 105 }, (_value, index) => ({
    ts: cutoff - 1000 - index,
    distinctId: `expired-${index}`,
  }));
  const kept = [
    { ts: cutoff + 1, distinctId: "kept-a" },
    { ts: cutoff + 2000, distinctId: "kept-b" },
  ];
  const settings = settingsOf({ events_retention_days: 30 });

  const whole = await freshProject({ settings: { events_retention_days: 30 } });
  await seedEvents(whole.id, [...expired, ...kept]);
  const once = await sweepIn(whole.id, settings, T0, 1000);
  expect(once.deleted.events).toBe(105);
  expect(once.leftRows).toBe(false);
  expect((await storedEvents(whole.id)).map((event) => event.distinctId)).toEqual([
    "kept-a",
    "kept-b",
  ]);

  const batched = await freshProject({ settings: { events_retention_days: 30 } });
  await seedEvents(batched.id, [...expired, ...kept]);
  const passes = [
    await sweepIn(batched.id, settings, T0, 40),
    await sweepIn(batched.id, settings, T0, 40),
    await sweepIn(batched.id, settings, T0, 40),
  ];
  expect(passes.map((outcome) => outcome.deleted.events)).toEqual([40, 40, 25]);
  expect(passes.map((outcome) => outcome.leftRows)).toEqual([true, true, false]);
});

it("privacy-03 · a purge empties the prefix, the store and the D1 rows, and says it finished", async () => {
  const project = await freshProject();
  const person = await seedPerson(project.id, ["purge-3"]);
  await seedEvents(project.id, [{ ts: T0, distinctId: "purge-3", personId: person }]);
  const chunk = await snapshotChunk({ distinctId: "purge-3" });
  const stored = await snapshotsDirect(snapshotRequestOf(project.id, [chunk]));
  expect(stored.ok).toBe(true);
  const keyHash = project.id.padEnd(64, "0");
  await env.REGISTRY.prepare(
    "INSERT INTO secret_keys (hash, project_id, label, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(keyHash, project.id, "purge", T0)
    .run();

  const answer = await purgeIn(project.id, 1000);

  expect(answer).toEqual({ ok: true, value: { finished: true } });
  expect(await r2Keys(`${project.id}/`)).toEqual([]);
  expect(await storeIsEmpty(project.id)).toBe(true);
  expect(await projectRow(project.id)).toBeNull();
  expect(
    await env.REGISTRY.prepare("SELECT hash FROM secret_keys WHERE project_id = ?")
      .bind(project.id)
      .first(),
  ).toBeNull();
});

it("privacy-03 · the alarm of a project marked deleted two minutes ago purges it", async () => {
  const project = await freshProject({ deletedAt: Date.now() - 2 * MINUTE_MS });
  await bindStore(project.id);
  await seedEvents(project.id, [{ ts: T0, distinctId: "purge-3b" }]);
  const chunk = await snapshotChunk({ distinctId: "purge-3b" });
  const stored = await snapshotsDirect(snapshotRequestOf(project.id, [chunk]));
  expect(stored.ok).toBe(true);
  expect(await r2Keys(`${project.id}/`)).toHaveLength(1);

  await runDurableObjectAlarm(storeOf(project.id));

  expect(await r2Keys(`${project.id}/`)).toEqual([]);
  expect(await storeIsEmpty(project.id)).toBe(true);
  expect(await projectRow(project.id)).toBeNull();
});

it("privacy-04 · a person with nothing left goes, and one whose recording stays does not", async () => {
  const project = await freshProject({
    settings: { events_retention_days: 30, recordings_retention_days: 30 },
  });
  const cutoff = T0 - 30 * DAY_MS;
  const expired = await seedPerson(project.id, ["expired-4"]);
  await seedEvents(project.id, [{ ts: cutoff - 1000, distinctId: "expired-4", personId: expired }]);
  await seedPerson(project.id, ["recorded-4"]);
  const chunk = await snapshotChunk({ distinctId: "recorded-4" });
  const stored = await snapshotsDirect(snapshotRequestOf(project.id, [chunk]));
  expect(stored.ok).toBe(true);
  await seedPerson(project.id, ["idle-4"]);

  const outcome = await sweepIn(
    project.id,
    settingsOf({ events_retention_days: 30, recordings_retention_days: 30 }),
    T0,
    1000,
  );

  expect(outcome.deleted.persons).toBe(2);
  expect((await storedPersons(project.id)).map((person) => person.distinctIds)).toEqual([
    ["recorded-4"],
  ]);
});

it("privacy-06 · an event is judged by its own time, not when it arrived", async () => {
  const project = await freshProject({ settings: { events_retention_days: 30 } });
  const cutoff = T0 - 30 * DAY_MS;
  await seedEvents(project.id, [
    { ts: cutoff - 1, distinctId: "just-outside", receivedAt: T0 },
    { ts: cutoff + 1, distinctId: "just-inside", receivedAt: T0 },
  ]);

  const outcome = await sweepIn(project.id, settingsOf({ events_retention_days: 30 }), T0, 1000);

  expect(outcome.deleted.events).toBe(1);
  expect((await storedEvents(project.id)).map((event) => event.distinctId)).toEqual([
    "just-inside",
  ]);
});

it("privacy-07 · a retention lowered in the registry applies at the next alarm", async () => {
  const project = await freshProject({ settings: { events_retention_days: 395 } });
  await bindStore(project.id);
  await seedEvents(project.id, [{ ts: T0 - 100 * DAY_MS, distinctId: "older-than-30" }]);

  const before = swept((await runAlarmAt(project.id, T0)).result);
  expect(before.deleted.events).toBe(0);
  expect(await storedEvents(project.id)).toHaveLength(1);

  await env.REGISTRY.prepare("UPDATE projects SET events_retention_days = 30 WHERE id = ?")
    .bind(project.id)
    .run();

  const after = swept((await runAlarmAt(project.id, T0)).result);
  expect(after.deleted.events).toBe(1);
  expect(await storedEvents(project.id)).toEqual([]);
});

it("privacy-08 · no id row and no event points at a person the sweep deleted", async () => {
  const project = await freshProject({ settings: { events_retention_days: 30 } });
  const cutoff = T0 - 30 * DAY_MS;
  const expired = await seedPerson(project.id, ["expired-8"]);
  await seedEvents(project.id, [{ ts: cutoff - 1000, distinctId: "expired-8", personId: expired }]);
  const kept = await seedPerson(project.id, ["kept-8"]);
  await seedEvents(project.id, [{ ts: cutoff + 1000, distinctId: "kept-8", personId: kept }]);

  await sweepIn(project.id, settingsOf({ events_retention_days: 30 }), T0, 1000);

  const dangling = await inStore(project.id, (sql) => ({
    ids: Number(
      sql
        .exec(
          `SELECT COUNT(*) AS n FROM person_distinct_ids links
           LEFT JOIN persons ON persons.id = links.person_id WHERE persons.id IS NULL`,
        )
        .one().n,
    ),
    events: Number(
      sql
        .exec(
          `SELECT COUNT(*) AS n FROM events
           LEFT JOIN persons ON persons.id = events.person_id
           WHERE events.person_id IS NOT NULL AND persons.id IS NULL`,
        )
        .one().n,
    ),
  }));
  expect(dangling).toEqual({ ids: 0, events: 0 });
});

it("privacy-11 · an expired salt takes its cookieless sessions with it", async () => {
  const project = await freshProject();
  await inStore(project.id, (sql) => {
    sql.exec(
      "INSERT INTO salts (day, salt, expires_at) VALUES (?, ?, ?)",
      "2026-10-19",
      new Uint8Array(16).fill(7),
      Date.UTC(2026, 9, 20, 12, 0, 0),
    );
    sql.exec(
      "INSERT INTO salts (day, salt, expires_at) VALUES (?, ?, ?)",
      "2026-10-20",
      new Uint8Array(16).fill(8),
      Date.UTC(2026, 9, 21, 12, 0, 0),
    );
    sql.exec(
      "INSERT INTO cookieless_sessions (hash, day, session_id, last_ts) VALUES (?, ?, ?, ?)",
      "hash-expired",
      "2026-10-19",
      "session-expired",
      T0,
    );
    sql.exec(
      "INSERT INTO cookieless_sessions (hash, day, session_id, last_ts) VALUES (?, ?, ?, ?)",
      "hash-kept",
      "2026-10-20",
      "session-kept",
      T0,
    );
  });

  const outcome = await sweepIn(project.id, settingsOf(), T0, 1000);

  expect(outcome.deleted.salts).toBe(2);
  expect((await storedSalts(project.id)).map((salt) => salt.day)).toEqual(["2026-10-20"]);
  expect((await storedSessions(project.id)).map((session) => session.sessionId)).toEqual([
    "session-kept",
  ]);
});

it("privacy-12 · a recording's age is its end, and its objects go before its rows", async () => {
  const project = await freshProject({
    settings: { recordings_retention_days: 30 },
  });
  const cutoff = T0 - 30 * DAY_MS;
  const expiredSession = newUuid();
  const keptSession = newUuid();
  const stored = await snapshotsDirect(
    snapshotRequestOf(project.id, [
      await snapshotChunk({
        sessionId: expiredSession,
        distinctId: "recorded-12",
        meta: { firstTs: cutoff - 60_000, lastTs: cutoff - 1000 },
      }),
      await snapshotChunk({
        sessionId: keptSession,
        distinctId: "recorded-12",
        meta: { firstTs: cutoff + 1000, lastTs: cutoff + 2000 },
      }),
    ]),
  );
  expect(stored.ok).toBe(true);

  const outcome = await sweepIn(
    project.id,
    settingsOf({ recordings_retention_days: 30 }),
    T0,
    1000,
  );

  expect(outcome.deleted.recordings).toBe(2);
  expect((await storedRecordings(project.id)).map((row) => row.sessionId)).toEqual([keptSession]);
  const chunks = await storedChunks(project.id);
  expect(chunks.map((chunk) => chunk.sessionId)).toEqual([keptSession]);
  expect(await r2Keys(`${project.id}/`)).toEqual(chunks.map((chunk) => chunk.objectKey));
});

it("privacy-13 · a failed object delete keeps that chunk's rows, and the next sweep finishes", async () => {
  const project = await freshProject({ settings: { recordings_retention_days: 30 } });
  const cutoff = T0 - 30 * DAY_MS;
  const sessionId = newUuid();
  const chunks = await Promise.all(
    [0, 1, 2].map((index) =>
      snapshotChunk({
        sessionId,
        distinctId: "recorded-13",
        meta: {
          firstTs: cutoff - 10_000 + index * 1000,
          lastTs: cutoff - 9000 + index * 1000,
        },
      }),
    ),
  );
  const stored = await snapshotsDirect(snapshotRequestOf(project.id, chunks));
  expect(stored.ok).toBe(true);
  const keys = (await r2Keys(`${project.id}/`)).toSorted();
  const failing = keys[1];
  if (failing === undefined) throw new Error("the recording wrote fewer than two objects");

  const first = await sweepIn(
    project.id,
    settingsOf({ recordings_retention_days: 30 }),
    T0,
    1000,
    refusingDeletes(env.RECORDINGS, [failing]),
  );

  expect(first.failed).toHaveLength(1);
  expect(first.failed[0]?.step).toBe("recordings");
  expect(first.failed[0]?.message).toMatch(/failed/i);
  expect(first.failed[0]?.message).toContain("1");
  expect(first.deleted.recordings).toBe(2);
  expect((await storedChunks(project.id)).map((chunk) => chunk.objectKey)).toEqual([failing]);
  expect(await r2Keys(`${project.id}/`)).toEqual([failing]);
  expect(await storedRecordings(project.id)).toHaveLength(1);

  const second = await sweepIn(project.id, settingsOf({ recordings_retention_days: 30 }), T0, 1000);

  expect(second.failed).toEqual([]);
  expect(second.deleted.recordings).toBe(2);
  expect(await storedChunks(project.id)).toEqual([]);
  expect(await storedRecordings(project.id)).toEqual([]);
  expect(await r2Keys(`${project.id}/`)).toEqual([]);
});

it("privacy-14 · a point 91 days old goes with 90 days' retention, and one 89 days old stays", async () => {
  const project = await freshProject({ settings: { heatmaps_retention_days: 90 } });
  const cutoff = T0 - 90 * DAY_MS;
  await inStore(project.id, (sql) => {
    const insert = (ts: number, x: number): void => {
      sql.exec(
        `INSERT INTO heatmap_points
           (event_uuid, seq, host, path, width_band, x, y, kind, fixed, bot, ts, session_id, distinct_id)
         VALUES (?, 0, ?, ?, ?, ?, ?, ?, 0, 0, ?, NULL, ?)`,
        newUuid(),
        "www.example.com",
        "/heat",
        1200,
        x,
        x,
        "click",
        ts,
        "user-14",
      );
    };
    insert(cutoff - DAY_MS, 1);
    insert(cutoff + DAY_MS, 2);
  });

  const outcome = await sweepIn(project.id, settingsOf({ heatmaps_retention_days: 90 }), T0, 1000);

  expect(outcome.deleted["heatmap points"]).toBe(1);
  expect((await storedPoints(project.id)).map((point) => point.ts)).toEqual([cutoff + DAY_MS]);
});

it("privacy-20 · the alarm waits a minute after the mark before it purges", async () => {
  // Marked half a minute ago, so the purge's time is half a minute ahead.
  const mark = Date.now() - 30_000;
  const project = await freshProject({ deletedAt: mark });
  await bindStore(project.id);
  await seedEvents(project.id, [{ ts: T0, distinctId: "purge-20" }]);

  const early = await runAlarmAt(project.id, mark + 30_000);
  if (!early.result.ok) throw new Error("the alarm failed before the purge");
  expect(early.result.value).toEqual({ kind: "purge waits", at: mark + 60_000 });
  expect(early.alarm).toBe(mark + 60_000);
  expect(await storedEvents(project.id)).toHaveLength(1);
  expect(await projectRow(project.id)).not.toBeNull();

  const due = await runAlarmAt(project.id, mark + 60_000);
  if (!due.result.ok) throw new Error("the purge failed");
  expect(due.result.value).toEqual({ kind: "purged", finished: true });
  expect(await storeIsEmpty(project.id)).toBe(true);
  expect(await projectRow(project.id)).toBeNull();
});

it("privacy-21 · a purge bounded by maxKeys touches no row until the objects are gone", async () => {
  const project = await freshProject();
  await bindStore(project.id);
  await seedEvents(project.id, [{ ts: T0, distinctId: "purge-21" }]);
  const chunks = await Promise.all([0, 1, 2].map(() => snapshotChunk({ distinctId: "purge-21" })));
  const stored = await snapshotsDirect(snapshotRequestOf(project.id, chunks));
  expect(stored.ok).toBe(true);

  const stopped = await purgeIn(project.id, 2);

  expect(stopped).toEqual({ ok: true, value: { finished: false } });
  expect(await storedEvents(project.id)).toHaveLength(1);
  expect(await storedChunks(project.id)).toHaveLength(3);
  expect(await r2Keys(`${project.id}/`)).toHaveLength(1);
  expect(await projectRow(project.id)).not.toBeNull();

  const finished = await purgeIn(project.id, 2);

  expect(finished).toEqual({ ok: true, value: { finished: true } });
  expect(await projectRow(project.id)).toBeNull();
});

it("privacy-21 · a purge that meets a failing registry resumes with the real one", async () => {
  const project = await freshProject();
  await bindStore(project.id);
  await seedEvents(project.id, [{ ts: T0, distinctId: "purge-21b" }]);
  const chunk = await snapshotChunk({ distinctId: "purge-21b" });
  const stored = await snapshotsDirect(snapshotRequestOf(project.id, [chunk]));
  expect(stored.ok).toBe(true);

  const failed = await purgeIn(project.id, 1000, env.RECORDINGS, env.UNMIGRATED_REGISTRY);

  if (failed.ok || failed.error.kind !== "registry failed") {
    throw new Error("the purge did not stop at the registry");
  }
  expect(failed.error.message.length).toBeGreaterThan(0);
  expect(await r2Keys(`${project.id}/`)).toEqual([]);
  expect(await storedEvents(project.id)).toEqual([]);
  expect(await storedChunks(project.id)).toEqual([]);
  expect(
    await inStore(
      project.id,
      (sql) => sql.exec("SELECT value FROM store_meta WHERE key = 'project_id'").one().value,
    ),
  ).toBe(project.id);
  expect(await projectRow(project.id)).not.toBeNull();

  const finished = await purgeIn(project.id, 1000);

  expect(finished).toEqual({ ok: true, value: { finished: true } });
  expect(await projectRow(project.id)).toBeNull();
});

it("privacy-26 · the sweep's log line holds no address a capture request carried", async () => {
  const project = await freshProject();
  const forwarded = "198.51.100.34";
  const realIp = "198.51.100.35";
  const propertyIp = "198.51.100.36";
  const captured = await SELF.fetch(
    await jsRequest(
      jsBatch(project.token, [
        { event: "$pageview", distinctId: "user-26", properties: { $ip: propertyIp } },
      ]),
      "json",
      { ip: CLIENT_IP, headers: { "x-forwarded-for": forwarded, "x-real-ip": realIp } },
    ),
  );
  expect(captured.status).toBe(200);

  const { lines } = await runAlarmAt(project.id, T0);
  const summary = lines.filter((line) => asRecord(JSON.parse(line)).event === "sweep");

  expect(summary).toHaveLength(1);
  const text = summary.join("\n");
  for (const address of [CLIENT_IP, forwarded, realIp, propertyIp]) {
    expect(text).not.toContain(address);
  }
});

it("privacy-27 · more expired rows than a batch take passes, each row deleted once", async () => {
  const project = await freshProject({ settings: { events_retention_days: 30 } });
  await bindStore(project.id);
  // The alarms this test checks lie ahead of the wall clock (runAlarmAt).
  const now = Date.now();
  const cutoff = now - 30 * DAY_MS;
  await seedEvents(
    project.id,
    [0, 1, 2, 3, 4].map((index) => ({
      ts: cutoff - 1000 - index,
      distinctId: `expired-27-${index}`,
    })),
  );

  const first = await runAlarmAt(project.id, now, 2);
  expect(swept(first.result)).toMatchObject({ deleted: { events: 2 }, leftRows: true });
  expect(first.alarm).toBe(now + NEXT_PASS_MS);
  expect(await storedEvents(project.id)).toHaveLength(3);

  const second = await runAlarmAt(project.id, now + NEXT_PASS_MS, 2);
  expect(swept(second.result)).toMatchObject({ deleted: { events: 2 }, leftRows: true });
  expect(second.alarm).toBe(now + 2 * NEXT_PASS_MS);
  expect(await storedEvents(project.id)).toHaveLength(1);

  const third = await runAlarmAt(project.id, now + 2 * NEXT_PASS_MS, 2);
  expect(swept(third.result)).toMatchObject({ deleted: { events: 1 }, leftRows: false });
  expect(await storedEvents(project.id)).toEqual([]);
  // Nothing but store_meta is left, so the alarm is dropped.
  expect(third.alarm).toBeNull();
});

it("privacy-27 · each expired row is deleted once across the passes", async () => {
  const project = await freshProject({ settings: { events_retention_days: 30 } });
  await bindStore(project.id);
  const cutoff = T0 - 30 * DAY_MS;
  await seedEvents(
    project.id,
    [0, 1, 2, 3, 4].map((index) => ({ ts: cutoff - 1000 - index, distinctId: `once-27-${index}` })),
  );
  const deleted: number[] = [];
  for (let pass = 0; pass < 3; pass += 1) {
    const { result } = await runAlarmAt(project.id, T0 + pass * NEXT_PASS_MS, 2);
    deleted.push(swept(result).deleted.events);
  }
  expect(deleted.reduce((sum, count) => sum + count, 0)).toBe(5);
  expect(await storedEvents(project.id)).toEqual([]);
});

it("platform-27 · a finished sweep sets the alarm a day on, one that left rows a minute on", async () => {
  // The alarms this test checks lie ahead of the wall clock (runAlarmAt).
  const now = Date.now();
  const cutoff = now - 30 * DAY_MS;
  const finished = await freshProject({ settings: { events_retention_days: 30 } });
  await bindStore(finished.id);
  // One event inside retention stays, so the store is not empty and keeps an alarm (platform-28).
  await seedEvents(finished.id, [
    { ts: cutoff - 1000, distinctId: "finished-27" },
    { ts: now - 1000, distinctId: "kept-27" },
  ]);
  const { result, alarm } = await runAlarmAt(finished.id, now);
  expect(swept(result)).toMatchObject({ deleted: { events: 1 }, leftRows: false, empty: false });
  expect(alarm).toBe(now + DAY_MS);

  const left = await freshProject({ settings: { events_retention_days: 30 } });
  await bindStore(left.id);
  await seedEvents(
    left.id,
    [0, 1, 2].map((index) => ({ ts: cutoff - 1000 - index, distinctId: `left-27-${index}` })),
  );
  const leftPass = await runAlarmAt(left.id, now, 2);
  expect(swept(leftPass.result)).toMatchObject({ leftRows: true });
  expect(leftPass.alarm).toBe(now + NEXT_PASS_MS);
});

it("platform-28 · an alarm over an empty store drops it, and the next batch sets one", async () => {
  const project = await freshProject();
  await bindStore(project.id);

  const { result, alarm: dropped } = await runAlarmAt(project.id, T0);
  expect(swept(result)).toMatchObject({ empty: true, leftRows: false });
  expect(result.ok && result.value.kind === "swept" ? result.value.next : 1).toBeNull();
  expect(dropped).toBeNull();

  const before = Date.now();
  const answer = await ingestRpc(ingestRequest(project.id, []));
  const after = Date.now();

  expect(answer.ok).toBe(true);
  const alarm = await alarmOf(project.id);
  if (alarm === null) throw new Error("the batch left no alarm");
  expect(alarm).toBeGreaterThanOrEqual(before + DAY_MS);
  expect(alarm).toBeLessThanOrEqual(after + DAY_MS);
});

it("platform-29 · one log line holds a count per step in SWEEP_ORDER and no row content", async () => {
  const project = await freshProject();
  await bindStore(project.id);
  await seedEvents(project.id, [
    { ts: T0 - 396 * DAY_MS, distinctId: "private-29", event: "$pageview" },
  ]);

  const { lines } = await runAlarmAt(project.id, T0);

  expect(lines).toHaveLength(1);
  const line = asRecord(JSON.parse(lines[0] ?? ""));
  expect(line.level).toBe("info");
  expect(line.event).toBe("sweep");
  expect(line.failed).toEqual([]);
  const deleted = asRecord(line.deleted);
  expect(Object.keys(deleted)).toEqual([...SWEEP_ORDER]);
  expect(deleted.events).toBe(1);

  const text = lines[0] ?? "";
  for (const content of [project.id, "private-29", "$pageview", "pageview"]) {
    expect(text).not.toContain(content);
  }
});

it("platform-30 · a failed step names itself, and the other steps still delete", async () => {
  const project = await freshProject();
  await bindStore(project.id);
  await seedEvents(project.id, [{ ts: T0 - 396 * DAY_MS, distinctId: "failed-30" }]);
  await inStore(project.id, (sql) => sql.exec("DROP TABLE heatmap_points"));

  const { result, lines } = await runAlarmAt(project.id, T0);

  if (result.ok || result.error.kind !== "sweep failed") {
    throw new Error("the alarm did not name the failed step");
  }
  const failed = result.error.failed;
  expect(failed).toHaveLength(1);
  expect(failed[0]?.step).toBe("heatmap points");
  expect(failed[0]?.message).toMatch(/heatmap_points/);
  expect(await storedEvents(project.id)).toEqual([]);

  const line = asRecord(JSON.parse(lines[0] ?? ""));
  expect(asRecord(line).failed).toEqual(failed);

  // runAlarmAt deleted the alarm it set; a call sets one a day on, which the
  // pool's runDurableObjectAlarm runs now, through the real ProjectStore.alarm.
  await storeOf(project.id).ready();
  const rejection = await runDurableObjectAlarm(storeOf(project.id)).then(
    () => null,
    (error: unknown) => error,
  );
  if (!(rejection instanceof Error)) throw new Error("the alarm did not reject");
  expect(rejection.message).toContain("sweep failed");
});

it("platform-31 · an alarm run twice at the same moment deletes nothing the second time", async () => {
  const project = await freshProject();
  await bindStore(project.id);
  await seedEvents(project.id, [{ ts: T0 - 396 * DAY_MS, distinctId: "twice-31" }]);

  const first = await runAlarmAt(project.id, T0);
  expect(swept(first.result).deleted.events).toBe(1);

  const second = await runAlarmAt(project.id, T0);
  const outcome = swept(second.result);
  expect(outcome.failed).toEqual([]);
  expect(outcome.deleted.events).toBe(0);
});

it("projects-21 · the registry row stays marked until the purge removes it", async () => {
  const project = await freshProject({ deletedAt: T0 });
  await bindStore(project.id);
  await seedEvents(project.id, [{ ts: T0, distinctId: "marked-21" }]);

  const early = await runAlarmAt(project.id, T0 + 30_000);
  expect(early.result.ok && early.result.value.kind).toBe("purge waits");
  const marked = await env.REGISTRY.prepare(
    "SELECT deleted_at AS deletedAt FROM projects WHERE id = ?",
  )
    .bind(project.id)
    .first<{ deletedAt: number }>();
  expect(marked?.deletedAt).toBe(T0);

  await runAlarmAt(project.id, T0 + 60_000);
  expect(await projectRow(project.id)).toBeNull();
});

it("recordings-06 · an orphan older than the grace goes, a younger one and another project's stay", async () => {
  const project = await freshProject();
  const other = await freshProject();
  const orphan = `${project.id}/orphan-6`;
  const foreign = `${other.id}/orphan-6`;
  await putObjects([orphan, foreign]);

  const young = await sweepIn(project.id, settingsOf(), Date.now(), 1000);
  expect(young.deleted["orphan objects"]).toBe(0);
  expect(await r2Keys(`${project.id}/`)).toEqual([orphan]);

  const old = await sweepIn(
    project.id,
    settingsOf(),
    Date.now() + ORPHAN_GRACE_MS + MINUTE_MS,
    1000,
  );
  expect(old.deleted["orphan objects"]).toBe(1);
  expect(await r2Keys(`${project.id}/`)).toEqual([]);
  expect(await r2Keys(`${other.id}/`)).toEqual([foreign]);
});

it("recordings-06 · 2,501 orphans take two passes, the first leaving rows", async () => {
  const project = await freshProject();
  const keys = Array.from(
    { length: ORPHAN_SWEEP_KEYS + 1 },
    (_value, index) => `${project.id}/orphan-${index}`,
  );
  await putObjects(keys);
  const now = Date.now() + ORPHAN_GRACE_MS + MINUTE_MS;

  const first = await sweepIn(project.id, settingsOf(), now, SWEEP_BATCH_ROWS);
  expect(first.deleted["orphan objects"]).toBe(ORPHAN_SWEEP_KEYS);
  expect(first.leftRows).toBe(true);
  expect(await r2Keys(`${project.id}/`)).toHaveLength(1);

  const second = await sweepIn(project.id, settingsOf(), now, SWEEP_BATCH_ROWS);
  expect(second.deleted["orphan objects"]).toBe(1);
  expect(second.leftRows).toBe(false);
  expect(await r2Keys(`${project.id}/`)).toEqual([]);
});

it("recordings-17 · the orphan of a failed row write goes after the grace, though recordings failed", async () => {
  const project = await freshProject({ settings: { recordings_retention_days: 30 } });
  await inStore(project.id, (sql) => sql.exec("DROP TABLE recordings"));
  const chunk = await snapshotChunk({ distinctId: "orphan-17" });
  const stored = await snapshotsDirect(snapshotRequestOf(project.id, [chunk]));

  if (stored.ok || stored.error.kind !== "row refused") {
    throw new Error("the chunk's row was not refused");
  }
  expect(await r2Keys(`${project.id}/`)).toHaveLength(1);

  const outcome = await sweepIn(
    project.id,
    settingsOf({ recordings_retention_days: 30 }),
    Date.now() + ORPHAN_GRACE_MS + MINUTE_MS,
    1000,
  );

  // The persons step reads recordings too, to keep a person who has one, so it fails as well.
  expect(outcome.failed.map((failure) => failure.step)).toEqual(["recordings", "persons"]);
  expect(outcome.deleted["orphan objects"]).toBe(1);
  expect(await r2Keys(`${project.id}/`)).toEqual([]);
});

it("cookieless-04 · the alarm deletes day D's salt at noon on D+1, and not a millisecond before", async () => {
  const project = await freshProject();
  await bindStore(project.id);
  const expiry = Date.UTC(2026, 9, 22, 12, 0, 0);
  await inStore(project.id, (sql) => {
    sql.exec(
      "INSERT INTO salts (day, salt, expires_at) VALUES (?, ?, ?)",
      "2026-10-21",
      new Uint8Array(16).fill(9),
      expiry,
    );
    sql.exec(
      "INSERT INTO cookieless_sessions (hash, day, session_id, last_ts) VALUES (?, ?, ?, ?)",
      "hash-04",
      "2026-10-21",
      "session-04",
      T0,
    );
  });

  const before = await runAlarmAt(project.id, expiry - 1);
  expect(swept(before.result).deleted.salts).toBe(0);
  expect(await storedSalts(project.id)).toHaveLength(1);

  const at = await runAlarmAt(project.id, expiry);
  expect(swept(at.result).deleted.salts).toBe(2);
  expect(await storedSalts(project.id)).toEqual([]);
  expect(await storedSessions(project.id)).toEqual([]);
});

it("events-09 · the alarm keeps three days of counters and deletes the older ones", async () => {
  const project = await freshProject();
  await bindStore(project.id);
  const days = ["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"];
  await inStore(project.id, (sql) => {
    for (const [index, day] of days.entries()) {
      sql.exec("INSERT INTO counters (day, name, value) VALUES (?, 'events', ?)", day, index + 1);
    }
  });

  const { result } = await runAlarmAt(project.id, T0);

  expect(swept(result).deleted.counters).toBe(3);
  expect((await storedCounters(project.id)).map((row) => row.day)).toEqual([
    "2026-10-19",
    "2026-10-20",
    "2026-10-21",
  ]);
});

it("events-12 · a store whose batch was refused as full is still swept", async () => {
  const project = await freshProject();
  await bindStore(project.id);
  await seedEvents(project.id, [{ ts: T0 - 396 * DAY_MS, distinctId: "full-12" }]);

  const refused = await ingestDirect(
    ingestRequest(project.id, [incomingEvent()]),
    fixedSources({ databaseSize: STORE_GUARD_BYTES }),
  );
  expect(refused).toEqual({ ok: true, value: { stored: 0, quotaLimited: true } });

  const { result } = await runAlarmAt(project.id, T0);

  expect(swept(result).deleted.events).toBe(1);
  expect(await storedEvents(project.id)).toEqual([]);
});
