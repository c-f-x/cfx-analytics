import { expect, it } from "vitest";
import {
  BROWSER_UA,
  CLIENT_IP,
  COOKIELESS_SENTINEL,
  cookielessIncoming,
  DAY_MS,
  dayIn,
  fixedSources,
  HOUR_MS,
  incomingEvent,
  ingestDirect,
  ingestRequest,
  ingestRpc,
  MINUTE_MS,
  storedCounters,
  storedEvents,
  storedPersons,
  storedSalts,
  storedSessions,
  storeText,
  T0,
} from "../../../test/helpers/capture.ts";
import { newProjectId } from "../../../test/helpers/registry.ts";
import { cookielessId } from "./core.ts";

// What one batch does with cookieless events inside a ProjectStore
// (cookieless-01, -02, -06, -07, -09, -10, -11, -12, -13, -16, -17), through
// ingestDirect with salts and session ids the test hands in, and through
// ingestRpc where two batches must arrive at once.

const SALT_ONE = new Uint8Array(16).fill(1);
const SALT_TWO = new Uint8Array(16).fill(2);

/** The id a cookieless event of this project must store, from its hash inputs. */
function idOf(project: string, salt: Uint8Array): string {
  return cookielessId({
    salt,
    projectId: project,
    ip: CLIENT_IP,
    host: "www.example.com",
    userAgent: BROWSER_UA,
  });
}

/** A store's sessions without their hashes, which include the project id. */
async function sessionsOf(project: string): Promise<(string | number)[][]> {
  return (await storedSessions(project)).map((row) => [row.sessionId, row.lastTs]);
}

/** Each event's session id by its own time, so batch order cannot hide an answer. */
async function sessionByTs(project: string): Promise<Map<number, string | null>> {
  const events = await storedEvents(project);
  return new Map(events.map((event) => [event.ts, event.sessionId] as const));
}

it("cookieless-01 · a cookieless event is stored under cookieless_ and 16 hex, with no sentinel or IP", async () => {
  const project = newProjectId();
  const result = await ingestDirect(
    ingestRequest(project, [cookielessIncoming()]),
    fixedSources({ salts: [SALT_ONE] }),
  );
  expect(result).toEqual({ ok: true, value: { stored: 1, quotaLimited: false } });

  const events = await storedEvents(project);
  expect(events).toHaveLength(1);
  expect(events[0]?.distinctId).toBe(idOf(project, SALT_ONE));
  expect(events[0]?.distinctId).toMatch(/^cookieless_[0-9a-f]{16}$/);

  const text = await storeText(project);
  expect(text).not.toContain(COOKIELESS_SENTINEL);
  expect(text).not.toContain(CLIENT_IP);
});

it("cookieless-02 · two visits on one day share an id and the next day's visit does not", async () => {
  const project = newProjectId();
  const sameDay = await ingestDirect(
    ingestRequest(project, [
      cookielessIncoming({ ts: T0 }),
      cookielessIncoming({ ts: T0 + HOUR_MS }),
    ]),
    fixedSources({ salts: [SALT_ONE] }),
  );
  expect(sameDay).toEqual({ ok: true, value: { stored: 2, quotaLimited: false } });

  const nextDay = await ingestDirect(
    ingestRequest(project, [cookielessIncoming({ ts: T0 + DAY_MS })], { receivedAt: T0 + DAY_MS }),
    fixedSources({ salts: [SALT_TWO] }),
  );
  expect(nextDay).toEqual({ ok: true, value: { stored: 1, quotaLimited: false } });

  const events = await storedEvents(project);
  expect(events).toHaveLength(3);
  expect(events[0]?.distinctId).toBe(events[1]?.distinctId);
  expect(events[2]?.distinctId).not.toBe(events[0]?.distinctId);
  expect((await storedSalts(project)).map((row) => row.day)).toEqual([
    dayIn(T0, "Europe/Oslo"),
    dayIn(T0 + DAY_MS, "Europe/Oslo"),
  ]);
});

it("cookieless-06 · a batch out of time order gets the sessions it would in order", async () => {
  const t = T0;

  const ordered = newProjectId();
  await ingestDirect(
    ingestRequest(ordered, [
      cookielessIncoming({ ts: t }),
      cookielessIncoming({ ts: t + 20 * MINUTE_MS }),
      cookielessIncoming({ ts: t + 50 * MINUTE_MS + 1 }),
    ]),
    fixedSources({ salts: [SALT_ONE] }),
  );
  const outOfOrder = newProjectId();
  await ingestDirect(
    ingestRequest(outOfOrder, [
      cookielessIncoming({ ts: t + 50 * MINUTE_MS + 1 }),
      cookielessIncoming({ ts: t }),
      cookielessIncoming({ ts: t + 20 * MINUTE_MS }),
    ]),
    fixedSources({ salts: [SALT_ONE] }),
  );

  const expected = new Map([
    [t, "session-1"],
    [t + 20 * MINUTE_MS, "session-1"],
    [t + 50 * MINUTE_MS + 1, "session-2"],
  ]);
  expect(await sessionByTs(ordered)).toEqual(expected);
  expect(await sessionByTs(outOfOrder)).toEqual(expected);
  // Each project hashes its own id, so the rows' hashes differ; the sessions must not.
  expect(await sessionsOf(outOfOrder)).toEqual(await sessionsOf(ordered));
  expect((await storedSessions(outOfOrder)).map((row) => [row.sessionId, row.lastTs])).toEqual([
    ["session-2", t + 50 * MINUTE_MS + 1],
  ]);
});

it("cookieless-07 · a cookieless event has no person and makes none", async () => {
  const project = newProjectId();
  const result = await ingestDirect(
    ingestRequest(project, [cookielessIncoming()]),
    fixedSources({ salts: [SALT_ONE] }),
  );
  expect(result).toEqual({ ok: true, value: { stored: 1, quotaLimited: false } });
  expect((await storedEvents(project))[0]?.personId).toBeNull();
  expect(await storedPersons(project)).toEqual([]);
});

it("cookieless-09 · two events whose salt days differ get different ids", async () => {
  const project = newProjectId();
  const result = await ingestDirect(
    ingestRequest(project, [
      cookielessIncoming({ timezone: "Pacific/Kiritimati" }),
      cookielessIncoming({ timezone: "Europe/Oslo" }),
    ]),
    fixedSources({ salts: [SALT_ONE, SALT_TWO] }),
  );
  expect(result).toEqual({ ok: true, value: { stored: 2, quotaLimited: false } });

  const events = await storedEvents(project);
  expect(events[0]?.distinctId).not.toBe(events[1]?.distinctId);
  expect((await storedSalts(project)).map((row) => row.day)).toEqual(
    [dayIn(T0, "Europe/Oslo"), dayIn(T0, "Pacific/Kiritimati")].toSorted(),
  );
});

it("cookieless-10 · a late event whose salt has expired is stored under the arrived day's salt", async () => {
  const project = newProjectId();
  const result = await ingestDirect(
    ingestRequest(project, [cookielessIncoming({ ts: T0 - 3 * DAY_MS })]),
    fixedSources({ salts: [SALT_TWO] }),
  );
  expect(result).toEqual({ ok: true, value: { stored: 1, quotaLimited: false } });
  expect((await storedEvents(project))[0]?.distinctId).toBe(idOf(project, SALT_TWO));

  const salts = await storedSalts(project);
  expect(salts).toHaveLength(1);
  expect(salts[0]?.day).toBe(dayIn(T0, "Europe/Oslo"));
  expect(salts[0]?.salt).toEqual(SALT_TWO);
});

it("cookieless-11 · two first-of-the-day batches at once make one salt row", async () => {
  const project = newProjectId();
  const answers = await Promise.all([
    ingestRpc(ingestRequest(project, [cookielessIncoming()])),
    ingestRpc(ingestRequest(project, [cookielessIncoming()])),
  ]);
  expect(answers).toEqual([
    { ok: true, value: { stored: 1, quotaLimited: false } },
    { ok: true, value: { stored: 1, quotaLimited: false } },
  ]);
  expect(await storedSalts(project)).toHaveLength(1);

  const events = await storedEvents(project);
  expect(events).toHaveLength(2);
  expect(events[1]?.distinctId).toBe(events[0]?.distinctId);
});

it("cookieless-12 · an ordinary event with no session stays without one", async () => {
  const project = newProjectId();
  const result = await ingestDirect(ingestRequest(project, [incomingEvent({ sessionId: null })]));
  expect(result).toEqual({ ok: true, value: { stored: 1, quotaLimited: false } });
  expect((await storedEvents(project))[0]?.sessionId).toBeNull();
  expect(await storedSessions(project)).toEqual([]);
});

it("cookieless-13 · an ordinary event keeps the distinct id and session it was sent with", async () => {
  const project = newProjectId();
  const result = await ingestDirect(
    ingestRequest(project, [incomingEvent({ distinctId: "person-42", sessionId: "browser-42" })]),
  );
  expect(result).toEqual({ ok: true, value: { stored: 1, quotaLimited: false } });

  const events = await storedEvents(project);
  expect(events[0]?.distinctId).toBe("person-42");
  expect(events[0]?.sessionId).toBe("browser-42");
  expect(await storedSessions(project)).toEqual([]);
});

it("cookieless-16 · a cookieless event with no client IP is dropped and nothing is hashed", async () => {
  const project = newProjectId();
  const result = await ingestDirect(
    ingestRequest(project, [cookielessIncoming()], { clientIp: null }),
    fixedSources({ salts: [SALT_ONE] }),
  );
  expect(result).toEqual({ ok: true, value: { stored: 0, quotaLimited: false } });
  expect(await storedEvents(project)).toEqual([]);
  expect(await storedSalts(project)).toEqual([]);
});

it("cookieless-17 · a salt that cannot be made fails the whole batch and stores nothing", async () => {
  const project = newProjectId();
  const result = await ingestDirect(
    ingestRequest(project, [cookielessIncoming()]),
    fixedSources({ salts: [new Uint8Array(15)] }),
  );

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("the batch was stored without a 16-byte salt");
  expect(result.error.kind).toBe("salt unavailable");
  expect(await storedEvents(project)).toEqual([]);
  expect(await storedSalts(project)).toEqual([]);
  expect(await storedCounters(project)).toEqual([]);
});
