import { STORE_GUARD_BYTES } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import {
  counterValue,
  dayIn,
  fixedSources,
  incomingEvent,
  ingestDirect,
  ingestRequest,
  ingestRpc,
  storedCounters,
  storedEvents,
  T0,
} from "../../../test/helpers/capture.ts";
import { seedProject } from "../../../test/helpers/registry.ts";
import type { IngestRequest } from "../../platform/ingest.ts";
import type { IncomingEvent } from "../intake/index.ts";

// One whole batch inside a ProjectStore's transaction (events-01, events-02,
// events-04, events-05, events-07, events-12 to events-14). The cap's day is
// read from the arrival time the test passes in, so no test depends on the
// real clock. Each test seeds its own project.

const OSLO = "Europe/Oslo";
const DAY = dayIn(T0, OSLO);

/**
 * A batch for a seeded project, carrying that project's own settings. The
 * store reads the cap and time zone from the request only, so a cap seeded in
 * the registry reaches the batch through here.
 */
function requestOf(
  project: { id: string; settings: IngestRequest["settings"] },
  events: IncomingEvent[],
  overrides: Partial<Omit<IngestRequest, "projectId" | "events">> = {},
): IngestRequest {
  return ingestRequest(project.id, events, { settings: project.settings, ...overrides });
}

/** `count` ordinary events, each with its own uuid. */
function batch(count: number, event = "$pageview"): IncomingEvent[] {
  return Array.from({ length: count }, () => incomingEvent({ event }));
}

it("events-01 · a batch of 3 under a cap of 5 is stored and the counter reads 3", async () => {
  const project = await seedProject({ settings: { daily_event_cap: 5 } });

  const answer = await ingestDirect(requestOf(project, batch(3)));
  expect(answer).toEqual({ ok: true, value: { stored: 3, quotaLimited: false } });
  expect(await storedEvents(project.id)).toHaveLength(3);
  expect(await counterValue(project.id, DAY)).toBe(3);
});

it("events-02 · with 4 of a cap of 5 taken, only the first event in batch order is stored", async () => {
  const project = await seedProject({ settings: { daily_event_cap: 5 } });
  await ingestDirect(requestOf(project, batch(4)));

  const over = ["first", "second", "third"].map((event) => incomingEvent({ event }));
  const answer = await ingestDirect(requestOf(project, over));
  expect(answer).toEqual({ ok: true, value: { stored: 1, quotaLimited: true } });

  const stored = await storedEvents(project.id);
  expect(stored.map((event) => event.event)).toEqual([
    "$pageview",
    "$pageview",
    "$pageview",
    "$pageview",
    "first",
  ]);
  expect(await counterValue(project.id, DAY)).toBe(5);
});

it("events-04 · ten batches at once take exactly the 3 left under the cap", async () => {
  const project = await seedProject({ settings: { daily_event_cap: 8 } });
  const fill = await ingestRpc(requestOf(project, batch(5)));
  expect(fill).toEqual({ ok: true, value: { stored: 5, quotaLimited: false } });

  const answers = await Promise.all(
    Array.from({ length: 10 }, () => ingestRpc(requestOf(project, [incomingEvent()]))),
  );
  const values = answers.map((answer) => {
    if (!answer.ok) throw new Error(`a batch failed: ${JSON.stringify(answer.error)}`);
    return answer.value;
  });

  expect(values.filter((value) => value.stored === 1)).toHaveLength(3);
  expect(values.filter((value) => value.quotaLimited)).toHaveLength(7);
  expect(values.reduce((sum, value) => sum + value.stored, 0)).toBe(3);
  expect(await storedEvents(project.id)).toHaveLength(8);
  expect(await counterValue(project.id, DAY)).toBe(8);
});

it("events-05 · a stored batch sent again stores nothing and leaves the counter at 3", async () => {
  const project = await seedProject();
  const sent = requestOf(project, batch(3));

  const first = await ingestDirect(sent);
  expect(first).toEqual({ ok: true, value: { stored: 3, quotaLimited: false } });

  const again = await ingestDirect(requestOf(project, sent.events));
  expect(again).toEqual({ ok: true, value: { stored: 0, quotaLimited: false } });
  expect(await storedEvents(project.id)).toHaveLength(3);
  expect(await counterValue(project.id, DAY)).toBe(3);
});

it("events-07 · a batch after local midnight counts on the new day", async () => {
  const project = await seedProject({
    settings: { daily_event_cap: 5, timezone: OSLO },
  });
  // 23:59:59.999 and 00:00:00 on 22 October in Oslo (UTC+2 until 25 October).
  const before = Date.UTC(2026, 9, 21, 21, 59, 59, 999);
  const after = Date.UTC(2026, 9, 21, 22, 0, 0, 0);
  const dayBefore = dayIn(before, OSLO);
  const dayAfter = dayIn(after, OSLO);
  expect(dayBefore).not.toBe(dayAfter);

  await ingestDirect(requestOf(project, [incomingEvent()], { receivedAt: before }));
  await ingestDirect(requestOf(project, [incomingEvent()], { receivedAt: after }));

  expect(await counterValue(project.id, dayBefore)).toBe(1);
  expect(await counterValue(project.id, dayAfter)).toBe(1);
});

it("events-12 · a store at the size guard stores nothing and answers quota-limited", async () => {
  const project = await seedProject();

  const answer = await ingestDirect(
    requestOf(project, batch(2)),
    fixedSources({ databaseSize: STORE_GUARD_BYTES }),
  );
  expect(answer).toEqual({ ok: true, value: { stored: 0, quotaLimited: true } });
  expect(await storedEvents(project.id)).toEqual([]);
  expect(await storedCounters(project.id)).toEqual([]);
});

it("events-13 · a row the table refuses rolls the whole batch back, the counter included", async () => {
  const project = await seedProject();
  // The table is the last guard: a caller can hand it a row with no uuid, which
  // intake-31 would have replaced before the store sees it. Object.assign puts
  // the null there where a cast would, and the type checker allows it.
  const refused = Object.assign(incomingEvent(), { uuid: null });

  const answer = await ingestDirect(requestOf(project, [incomingEvent(), refused]));
  if (answer.ok) throw new Error("a batch with a row the table refuses was accepted");
  expect(answer.error.kind).toBe("row refused");

  expect(await storedEvents(project.id)).toEqual([]);
  expect(await storedCounters(project.id)).toEqual([]);
});

it("events-14 · an older event stored later keeps its own time and the person's latest does not move back", async () => {
  const project = await seedProject();
  const distinctId = "user-14";
  const latest = incomingEvent({ distinctId, event: "latest", ts: T0 });
  const older = incomingEvent({ distinctId, event: "older", ts: T0 - 2000 });

  await ingestDirect(requestOf(project, [latest], { receivedAt: T0 }));
  await ingestDirect(requestOf(project, [older], { receivedAt: T0 + 1000 }));

  const stored = await storedEvents(project.id);
  expect(stored.map((event) => event.event)).toEqual(["latest", "older"]);

  const [first, second] = stored;
  if (first === undefined || second === undefined) throw new Error("both events must be stored");
  expect(second.ts).toBe(T0 - 2000);
  expect(second.receivedAt).toBe(T0 + 1000);
  expect(second.personId).toBe(first.personId);
  expect(first.personId).not.toBeNull();

  const personLatest = Math.max(...stored.map((event) => event.ts));
  expect(personLatest).toBe(T0);
});

it("events-01 · a batch of 250 events, more than one statement's bound parameters hold, is stored whole", async () => {
  // A statement binds at most 100 parameters, and posthog-js can send a
  // batch far larger than 100 events (docs/waves/w2/map.md, question 7).
  const project = await seedProject({ settings: { daily_event_cap: 1000 } });

  const sent = requestOf(project, batch(250));
  const answer = await ingestDirect(sent);
  expect(answer).toEqual({ ok: true, value: { stored: 250, quotaLimited: false } });
  expect(await storedEvents(project.id)).toHaveLength(250);
  expect(await counterValue(project.id, DAY)).toBe(250);

  // Sent again, every one of the 250 uuids is found already stored.
  const again = await ingestDirect(requestOf(project, sent.events));
  expect(again).toEqual({ ok: true, value: { stored: 0, quotaLimited: false } });
  expect(await counterValue(project.id, DAY)).toBe(250);
});
