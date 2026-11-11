import { expect, it } from "vitest";
import {
  answerJson,
  capture,
  HOUR_MS,
  jsBatch,
  jsRequest,
  newUuid,
  storedEvents,
  T0,
  type TestEvent,
} from "../../../test/helpers/capture.ts";
import { seedProject } from "../../../test/helpers/registry.ts";
import { heatmapEvent, newSessionId, storedPoints } from "../../../test/helpers/replay.ts";

// posthog-js's $$heatmap and click events on the capture path (heatmaps-01,
// heatmaps-05 to heatmaps-07, heatmaps-13 to heatmaps-15, intake-19). Each test
// takes its own project, session and event uuids.

const at = (ms: number): string => new Date(ms).toISOString();

/** A posthog-js batch with no `sent_at`, so an event's own timestamp decides its time. */
async function send(project: { token: string }, events: readonly TestEvent[]): Promise<Response> {
  return capture(await jsRequest(jsBatch(project.token, events, { sentAt: null })));
}

function single<T>(items: readonly T[]): T {
  const [first] = items;
  if (first === undefined || items.length !== 1) {
    throw new Error(`expected exactly one item, got ${items.length}`);
  }
  return first;
}

it("heatmaps-01 · with heatmaps on a $$heatmap event stores its points and makes no event row", async () => {
  const project = await seedProject({ settings: { heatmaps_enabled: true } });
  const sessionId = newSessionId();

  const response = await send(project, [
    heatmapEvent({
      urls: {
        "https://www.example.com/pricing?plan=pro": [{ x: 12, y: 34, type: "click" }],
      },
      viewportWidth: 1280,
      sessionId,
      timestamp: at(T0),
    }),
  ]);

  expect(response.status).toBe(200);
  expect(await answerJson(response)).toEqual({ status: 1 });

  const point = single(await storedPoints(project.id));
  expect([point.host, point.path, point.widthBand, point.x, point.y, point.kind]).toEqual([
    "www.example.com",
    "/pricing",
    1200,
    12,
    34,
    "click",
  ]);
  expect([point.bot, point.fixed, point.ts, point.sessionId, point.distinctId]).toEqual([
    false,
    false,
    T0,
    sessionId,
    "anon-1",
  ]);
  expect(await storedEvents(project.id)).toEqual([]);
});

it("heatmaps-05 · with heatmaps off a $$heatmap event stores no point and no event row", async () => {
  const project = await seedProject();

  const response = await send(project, [
    heatmapEvent({
      urls: { "https://www.example.com/pricing": [{ x: 12, y: 34, type: "click" }] },
      timestamp: at(T0),
    }),
  ]);

  expect(response.status).toBe(200);
  expect(await answerJson(response)).toEqual({ status: 1 });
  expect(await storedPoints(project.id)).toEqual([]);
  expect(await storedEvents(project.id)).toEqual([]);
});

it("heatmaps-06 · the URL key decides the page, not the event's $current_url or $pathname", async () => {
  const project = await seedProject({ settings: { heatmaps_enabled: true } });

  await send(project, [
    heatmapEvent({
      urls: { "https://shop.example/checkout?step=2": [{ x: 5, y: 6, type: "click" }] },
      timestamp: at(T0),
      properties: { $current_url: "https://elsewhere.example/landing", $pathname: "/ignored" },
    }),
  ]);

  const point = single(await storedPoints(project.id));
  expect([point.host, point.path]).toEqual(["shop.example", "/checkout"]);
});

it("heatmaps-07 · an event with no $viewport_width stores no point, and the batch's other event is stored", async () => {
  const project = await seedProject({ settings: { heatmaps_enabled: true } });

  const response = await send(project, [
    heatmapEvent({
      urls: { "https://www.example.com/pricing": [{ x: 12, y: 34, type: "click" }] },
      viewportWidth: null,
      timestamp: at(T0),
    }),
    { event: "$pageview", distinctId: "user-1", timestamp: at(T0) },
  ]);

  expect(response.status).toBe(200);
  expect(await answerJson(response)).toEqual({ status: 1 });
  expect(await storedPoints(project.id)).toEqual([]);
  expect((await storedEvents(project.id)).map((stored) => stored.event)).toEqual(["$pageview"]);
});

it("heatmaps-13 · the same $$heatmap event sent twice stores its point once", async () => {
  const project = await seedProject({ settings: { heatmaps_enabled: true } });
  const uuid = newUuid();
  const event = heatmapEvent({
    urls: { "https://www.example.com/pricing": [{ x: 12, y: 34, type: "click" }] },
    uuid,
    timestamp: at(T0),
  });

  expect((await send(project, [event])).status).toBe(200);
  expect((await send(project, [event])).status).toBe(200);

  expect(await storedPoints(project.id)).toHaveLength(1);
});

it("heatmaps-14 · $rageclick and $dead_click are stored as ordinary events", async () => {
  const project = await seedProject({
    settings: { heatmaps_enabled: true, dead_clicks_enabled: true },
  });

  const response = await send(project, [
    { event: "$rageclick", distinctId: "user-1", timestamp: at(T0) },
    { event: "$dead_click", distinctId: "user-1", timestamp: at(T0) },
  ]);

  expect(response.status).toBe(200);
  expect((await storedEvents(project.id)).map((stored) => stored.event)).toEqual([
    "$rageclick",
    "$dead_click",
  ]);
  expect(await storedPoints(project.id)).toEqual([]);
});

it("heatmaps-15 · a $dead_click with its own timestamp is ordered by that time, not the receipt time", async () => {
  const project = await seedProject({ settings: { dead_clicks_enabled: true } });
  const ownTime = T0 - HOUR_MS;

  await send(project, [{ event: "$dead_click", distinctId: "user-1", timestamp: at(ownTime) }]);

  const stored = single(await storedEvents(project.id));
  expect(stored.ts).toBe(ownTime);
  expect(stored.receivedAt).not.toBe(ownTime);
});

it("intake-19 · a batch's ordinary events are stored and its $$heatmap event makes no row", async () => {
  const project = await seedProject({ settings: { heatmaps_enabled: true } });
  const names = ["$identify", "$create_alias", "$groupidentify", "$snapshot", "$exception"];

  const response = await send(project, [
    ...names.map((event) => ({ event, distinctId: "user-1", timestamp: at(T0) })),
    heatmapEvent({
      urls: { "https://www.example.com/pricing": [{ x: 12, y: 34, type: "click" }] },
      timestamp: at(T0),
    }),
  ]);

  expect(response.status).toBe(200);
  const stored = (await storedEvents(project.id)).map((event) => event.event);
  expect(stored).toEqual(names);
  expect(stored).not.toContain("$$heatmap");
});
