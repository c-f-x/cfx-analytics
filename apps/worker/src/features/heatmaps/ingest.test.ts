import { expect, it } from "vitest";
import {
  incomingEvent,
  ingestDirect,
  ingestRequest,
  newUuid,
  storedEvents,
  T0,
} from "../../../test/helpers/capture.ts";
import { seedProject } from "../../../test/helpers/registry.ts";
import { storedPoints } from "../../../test/helpers/replay.ts";
import type { HeatmapPointInput } from "./core.ts";

// A batch's points through ingestBatch in a real ProjectStore (heatmaps-01,
// heatmaps-13): the points of a $$heatmap event, stored beside the batch's
// events in its transaction.

/** One point as the capture path builds it for ingestBatch. */
function pointOf(overrides: Partial<HeatmapPointInput> = {}): HeatmapPointInput {
  return {
    eventUuid: newUuid(),
    seq: 0,
    host: "www.example.com",
    path: "/pricing",
    widthBand: 1200,
    x: 1,
    y: 1,
    kind: "click",
    fixed: false,
    bot: false,
    ts: T0,
    sessionId: null,
    distinctId: null,
    ...overrides,
  };
}

it("heatmaps-01 · a batch's points are stored beside its events", async () => {
  const project = await seedProject({ settings: { heatmaps_enabled: true } });
  const eventUuid = newUuid();
  const points = [
    pointOf({ eventUuid, seq: 0, x: 10, y: 20, kind: "click" }),
    pointOf({ eventUuid, seq: 1, x: 30, y: 40, kind: "rageclick", fixed: true }),
  ];

  const answer = await ingestDirect(ingestRequest(project.id, [incomingEvent()], { points }));
  expect(answer).toEqual({ ok: true, value: { stored: 1, quotaLimited: false } });

  expect(await storedEvents(project.id)).toHaveLength(1);
  const stored = await storedPoints(project.id);
  expect(stored.map((point) => [point.seq, point.kind, point.x, point.y, point.fixed])).toEqual([
    [0, "click", 10, 20, false],
    [1, "rageclick", 30, 40, true],
  ]);
  expect(stored.map((point) => [point.eventUuid, point.path, point.widthBand, point.host])).toEqual(
    [
      [eventUuid, "/pricing", 1200, "www.example.com"],
      [eventUuid, "/pricing", 1200, "www.example.com"],
    ],
  );
});

it("heatmaps-13 · the same batch sent twice stores its points once", async () => {
  const project = await seedProject({ settings: { heatmaps_enabled: true } });
  const points = [pointOf({ x: 10, y: 20 })];
  const request = ingestRequest(project.id, [incomingEvent()], { points });

  expect(await ingestDirect(request)).toEqual({
    ok: true,
    value: { stored: 1, quotaLimited: false },
  });
  expect(await ingestDirect(request)).toEqual({
    ok: true,
    value: { stored: 0, quotaLimited: false },
  });

  expect(await storedPoints(project.id)).toHaveLength(1);
});

it("heatmaps-21 · each $$heatmap event takes one from the events cap, after the batch's events", async () => {
  // Points are not event rows, but they cost storage, so the daily cap bounds them too (D-20).
  const project = await seedProject({ settings: { heatmaps_enabled: true, daily_event_cap: 2 } });
  const first = newUuid();
  const second = newUuid();
  const points = [
    pointOf({ eventUuid: first, seq: 0 }),
    pointOf({ eventUuid: first, seq: 1 }),
    pointOf({ eventUuid: second, seq: 0 }),
  ];
  const request = ingestRequest(project.id, [incomingEvent()], {
    points,
    settings: project.settings,
  });

  const answer = await ingestDirect(request);
  expect(answer).toEqual({ ok: true, value: { stored: 1, quotaLimited: true } });
  expect(await storedEvents(project.id)).toHaveLength(1);
  const stored = await storedPoints(project.id);
  expect(stored.map((point) => [point.eventUuid, point.seq])).toEqual([
    [first, 0],
    [first, 1],
  ]);

  // Sent again with a cap raised by one, the stored heatmap event takes nothing: only the second does.
  const again = await ingestDirect(
    ingestRequest(project.id, [], {
      points,
      settings: { ...project.settings, daily_event_cap: 3 },
    }),
  );
  expect(again).toEqual({ ok: true, value: { stored: 0, quotaLimited: false } });
  expect(await storedPoints(project.id)).toHaveLength(3);
});
