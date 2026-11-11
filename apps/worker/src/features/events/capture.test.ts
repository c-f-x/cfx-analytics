import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import {
  answerJson,
  capture,
  captureApp,
  fetchApp,
  jsBatch,
  jsRequest,
  MINUTE_MS,
  storedCounters,
  storedEvents,
  T0,
  type TestEvent,
} from "../../../test/helpers/capture.ts";
import { seedProject } from "../../../test/helpers/registry.ts";

// What an SDK sees when the daily cap is in the way (events-02, events-03,
// events-08): the status and answer body, the rows that were stored, and the
// registry cache's 60 seconds. Each test seeds its own project.

/** `names` as ordinary events of one user, each with its own uuid. */
function named(names: readonly string[]): TestEvent[] {
  return names.map((event) => ({ event, distinctId: "user-events" }));
}

it("events-02 · a batch over the cap answers 200 with quota_limited and keeps the first event", async () => {
  const project = await seedProject({ settings: { daily_event_cap: 5 } });

  const fill = await capture(
    await jsRequest(jsBatch(project.token, named(["a-1", "a-2", "a-3", "a-4"]))),
  );
  expect(fill.status).toBe(200);
  expect(await answerJson(fill)).toEqual({ status: 1 });

  const over = await capture(await jsRequest(jsBatch(project.token, named(["b-1", "b-2", "b-3"]))));
  expect(over.status).toBe(200);
  expect(await answerJson(over)).toEqual({ status: 1, quota_limited: ["events"] });

  const stored = await storedEvents(project.id);
  expect(stored.map((event) => event.event)).toEqual(["a-1", "a-2", "a-3", "a-4", "b-1"]);
  const counters = await storedCounters(project.id);
  expect(counters.map((counter) => counter.value)).toEqual([5]);
});

it("events-03 · at the cap the answer is exactly the quota-limited body and nothing is stored", async () => {
  const project = await seedProject({ settings: { daily_event_cap: 5 } });
  const fill = await capture(
    await jsRequest(jsBatch(project.token, named(["a-1", "a-2", "a-3", "a-4", "a-5"]))),
  );
  expect(await answerJson(fill)).toEqual({ status: 1 });

  const atCap = await capture(await jsRequest(jsBatch(project.token, named(["b-1"]))));
  expect(atCap.status).toBe(200);
  expect(await answerJson(atCap)).toEqual({ status: 1, quota_limited: ["events"] });
  expect(await storedEvents(project.id)).toHaveLength(5);
});

it("events-03 · a batch of $exception at the cap answers exceptionEvent", async () => {
  const project = await seedProject({ settings: { daily_event_cap: 2 } });
  const fill = await capture(await jsRequest(jsBatch(project.token, named(["a-1", "a-2"]))));
  expect(await answerJson(fill)).toEqual({ status: 1 });

  const exceptions = await capture(
    await jsRequest(jsBatch(project.token, named(["$exception", "$exception"]))),
  );
  expect(exceptions.status).toBe(200);
  expect(await answerJson(exceptions)).toEqual({ status: 1, quota_limited: ["exceptionEvent"] });
  expect(await storedEvents(project.id)).toHaveLength(2);
});

it("events-08 · the cap comes from the registry cache for 60 seconds, then from the registry", async () => {
  const project = await seedProject({ settings: { daily_event_cap: 5 } });
  let now = T0;
  const app = captureApp(() => now);
  const send = async (names: readonly string[]) =>
    fetchApp(app, await jsRequest(jsBatch(project.token, named(names))));

  const fill = await send(["a-1", "a-2", "a-3", "a-4", "a-5"]);
  expect(fill.status).toBe(200);
  expect(await answerJson(fill)).toEqual({ status: 1 });

  await env.REGISTRY.prepare("UPDATE projects SET daily_event_cap = 10 WHERE id = ?")
    .bind(project.id)
    .run();

  now = T0 + MINUTE_MS - 1000;
  const cached = await send(["b-1"]);
  expect(cached.status).toBe(200);
  expect(await answerJson(cached)).toEqual({ status: 1, quota_limited: ["events"] });

  now = T0 + MINUTE_MS + 1000;
  const fresh = await send(["c-1"]);
  expect(fresh.status).toBe(200);
  expect(await answerJson(fresh)).toEqual({ status: 1 });

  expect(await storedEvents(project.id)).toHaveLength(6);
  const counters = await storedCounters(project.id);
  expect(counters.map((counter) => counter.value)).toEqual([6]);
});
