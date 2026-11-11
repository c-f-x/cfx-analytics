import type { InternalRule, JsonObject, ResolvedRange } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import { newUuid, T0 } from "../../../test/helpers/capture.ts";
import { heatmapEvent } from "../../../test/helpers/replay.ts";
import { heatmapMeta, pointRules, pointsFromEvent, widthBand } from "./core.ts";

// The heatmap slice's pure rules at their own boundary (heatmaps-01,
// heatmaps-04 to heatmaps-10, heatmaps-19, query-08, query-12). The events are
// posthog-js's $$heatmap events, built by the replay helper; what intake hands
// pointsFromEvent is passed in as values.

const SESSION = "0192f0aa-0000-7000-8000-0000000000c0";
const ANON = "anon-1";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** pointsFromEvent's argument: the event's properties as sent, and what intake read from it. */
function eventOf(
  properties: Readonly<JsonObject>,
  overrides: {
    uuid?: string;
    ts?: number;
    bot?: boolean;
    distinctId?: string | null;
    sessionId?: string | null;
  } = {},
) {
  return {
    uuid: overrides.uuid ?? newUuid(),
    properties,
    ts: overrides.ts ?? T0,
    bot: overrides.bot ?? false,
    distinctId: overrides.distinctId === undefined ? ANON : overrides.distinctId,
    sessionId: overrides.sessionId === undefined ? SESSION : overrides.sessionId,
  };
}

/** The $$heatmap event's properties as posthog-js writes them. */
function propertiesOf(options: Parameters<typeof heatmapEvent>[0]): JsonObject {
  return heatmapEvent({ sessionId: SESSION, ...options }).properties ?? {};
}

it("heatmaps-01 · a point carries the URL's host and its path without the query, the width band and the bot flag", () => {
  const event = eventOf(
    propertiesOf({
      urls: { "https://www.example.com/pricing?plan=pro#faq": [{ x: 40, y: 60, type: "click" }] },
      viewportWidth: 1280,
    }),
    { bot: true },
  );

  expect(pointsFromEvent(event, true)).toEqual([
    {
      eventUuid: event.uuid,
      seq: 0,
      host: "www.example.com",
      path: "/pricing",
      widthBand: 1200,
      x: 40,
      y: 60,
      kind: "click",
      fixed: false,
      bot: true,
      ts: T0,
      sessionId: SESSION,
      distinctId: ANON,
    },
  ]);
});

it("heatmaps-01 · the width band is the viewport width rounded down to its hundred pixels", () => {
  expect([widthBand(0), widthBand(99), widthBand(1200), widthBand(1299), widthBand(1300)]).toEqual([
    0, 0, 1200, 1200, 1300,
  ]);
});

it("heatmaps-04 · a fixed point keeps its coordinates as sent, in viewport space, and every point is whole pixels", () => {
  const event = eventOf(
    propertiesOf({
      urls: {
        "https://www.example.com/": [
          { x: 42, y: 84, type: "click", fixed: true },
          { x: 42, y: 84, type: "click" },
          { x: 10.4, y: 20.6, type: "click" },
        ],
      },
      viewportWidth: 1280,
    }),
  );

  expect(pointsFromEvent(event, true).map((point) => [point.x, point.y, point.fixed])).toEqual([
    [42, 84, true],
    [42, 84, false],
    [10, 21, false],
  ]);
});

it("heatmaps-05 · with heatmaps off a $$heatmap event gives no points", () => {
  const event = eventOf(
    propertiesOf({ urls: { "https://www.example.com/": [{ x: 1, y: 2, type: "click" }] } }),
  );

  expect(pointsFromEvent(event, false)).toEqual([]);
});

it("heatmaps-06 · each URL key decides its own page, and $current_url and $pathname are never read", () => {
  const event = eventOf(
    propertiesOf({
      urls: {
        "https://shop.example/one": [{ x: 1, y: 2, type: "click" }],
        "https://other.example/two?ref=mail": [{ x: 3, y: 4, type: "rageclick" }],
      },
      viewportWidth: 1000,
      properties: { $current_url: "https://elsewhere.example/landing", $pathname: "/ignored" },
    }),
  );

  expect(pointsFromEvent(event, true).map((point) => [point.host, point.path])).toEqual([
    ["shop.example", "/one"],
    ["other.example", "/two"],
  ]);
});

it("heatmaps-07 · an event without a usable $viewport_width gives no points and is not refused", () => {
  const urls = { "https://www.example.com/": [{ x: 1, y: 2, type: "click" as const }] };
  const unusable = [
    eventOf(propertiesOf({ urls, viewportWidth: null })),
    eventOf(propertiesOf({ urls, viewportWidth: Number.POSITIVE_INFINITY })),
    eventOf({ ...propertiesOf({ urls, viewportWidth: 1280 }), $viewport_width: "1280" }),
    eventOf({ ...propertiesOf({ urls, viewportWidth: 1280 }), $viewport_width: -1 }),
  ];

  for (const event of unusable) expect(pointsFromEvent(event, true)).toEqual([]);
});

it("heatmaps-08 · click, rageclick and deadclick points are kept", () => {
  const event = eventOf(
    propertiesOf({
      urls: {
        "https://www.example.com/": [
          { x: 1, y: 1, type: "click" },
          { x: 2, y: 2, type: "rageclick" },
          { x: 3, y: 3, type: "deadclick", fixed: true },
        ],
      },
    }),
  );

  expect(pointsFromEvent(event, true).map((point) => point.kind)).toEqual([
    "click",
    "rageclick",
    "deadclick",
  ]);
});

it("heatmaps-09 · a mousemove point, and any other type, is not kept", () => {
  const event = eventOf(
    propertiesOf({
      urls: {
        "https://www.example.com/": [
          { x: 1, y: 1, type: "mousemove" },
          { x: 2, y: 2, type: "click" },
        ],
      },
    }),
  );
  expect(pointsFromEvent(event, true).map((point) => point.kind)).toEqual(["click"]);

  const other = eventOf({
    $viewport_width: 1280,
    $heatmap_data: {
      "https://www.example.com/": [{ x: 5, y: 6, target_fixed: false, type: "touch" }],
    },
  });
  expect(pointsFromEvent(other, true)).toEqual([]);
});

it("heatmaps-10 · a point with a missing, non-number or negative coordinate is skipped and the others kept", () => {
  const event = eventOf({
    $viewport_width: 1280,
    $heatmap_data: {
      "https://www.example.com/": [
        { type: "click", y: 10 },
        { type: "click", x: "30", y: 10 },
        { type: "click", x: null, y: 10 },
        { type: "click", x: 10, y: -1 },
        { type: "click", x: 20, y: 30 },
        { type: "click", x: 40, y: 50 },
      ],
    },
  });

  expect(pointsFromEvent(event, true).map((point) => [point.x, point.y, point.seq])).toEqual([
    [20, 30, 0],
    [40, 50, 1],
  ]);
});

it("heatmaps-19 · only an event-property rule on $host applies to points", () => {
  const rules: InternalRule[] = [
    { kind: "person_property", property: "email", value: "owner@example.test" },
    { kind: "event_property", property: "$browser", value: "Chrome" },
    { kind: "event_property", property: "$host", value: "internal.example" },
  ];

  expect(pointRules(rules)).toEqual({
    excludedHosts: ["internal.example"],
    applied: [2],
    notApplicable: [0, 1],
  });
});

it("heatmaps-19 · a $host rule with a non-string value applies and excludes nothing, and no rules exclude nothing", () => {
  expect(pointRules([])).toEqual({ excludedHosts: [], applied: [], notApplicable: [] });
  expect(pointRules([{ kind: "event_property", property: "$host", value: 42 }])).toEqual({
    excludedHosts: [],
    applied: [0],
    notApplicable: [],
  });
});

it("query-08 · each $host rule names a host whose points are left out, and all of them apply", () => {
  expect(
    pointRules([
      { kind: "event_property", property: "$host", value: "internal.example" },
      { kind: "person_property", property: "email", value: "owner@example.test" },
      { kind: "event_property", property: "$host", value: "www.example.com" },
    ]),
  ).toEqual({
    excludedHosts: ["internal.example", "www.example.com"],
    applied: [0, 2],
    notApplicable: [1],
  });
});

it("query-12 · the meta holds the range as ISO UTC, the time zone, the exclusions applied and rowsRead", () => {
  const range: ResolvedRange = {
    from: Date.UTC(2026, 9, 14, 8, 0, 0),
    to: T0,
    timeZone: "Europe/Oslo",
    requested: null,
  };
  const rules = pointRules([{ kind: "event_property", property: "$host", value: "internal" }]);

  expect(heatmapMeta(range, false, rules, 37)).toEqual({
    range: { from: "2026-10-14T08:00:00.000Z", to: "2026-10-21T10:00:00.000Z" },
    timeZone: "Europe/Oslo",
    excluded: { bots: true, internalRules: [0], notApplicable: [] },
    rowsRead: 37,
  });
});

it("query-12 · a clipped range carries what was asked, and a statement that did not report is null", () => {
  const range: ResolvedRange = {
    from: T0 - 90 * DAY_MS,
    to: T0,
    timeZone: "Europe/Oslo",
    requested: { from: T0 - 200 * DAY_MS, to: T0 },
  };

  const meta = heatmapMeta(range, true, pointRules([]), null);
  expect(meta.requested).toEqual({
    from: new Date(T0 - 200 * DAY_MS).toISOString(),
    to: new Date(T0).toISOString(),
  });
  expect(meta.excluded).toEqual({ bots: false, internalRules: [], notApplicable: [] });
  expect(meta.rowsRead).toBeNull();
});

it("heatmaps-22 · a coordinate or width no SQLite integer can hold leaves its points out", () => {
  const event = eventOf(
    propertiesOf({
      urls: {
        "https://www.example.com/pricing": [
          { x: 1e20, y: 60, type: "click" },
          { x: 40, y: 60, type: "click" },
        ],
      },
      viewportWidth: 1280,
    }),
  );
  expect(pointsFromEvent(event, true).map((point) => [point.x, point.y])).toEqual([[40, 60]]);

  const wide = eventOf(
    propertiesOf({
      urls: { "https://www.example.com/pricing": [{ x: 40, y: 60, type: "click" }] },
      viewportWidth: 1e300,
    }),
  );
  expect(pointsFromEvent(wide, true)).toEqual([]);
});
