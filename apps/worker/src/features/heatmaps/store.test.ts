import { expect, it } from "vitest";
import { inStore, newUuid, T0 } from "../../../test/helpers/capture.ts";
import { newProjectId } from "../../../test/helpers/registry.ts";
import { storedPoints } from "../../../test/helpers/replay.ts";
import type { HeatmapKind, HeatmapPointInput, PointsQuery } from "./core.ts";
import { insertPoints, readPoints } from "./store.ts";

// The heatmap_points table, reached through `inStore` in a real ProjectStore
// (heatmaps-04, heatmaps-11 to heatmaps-13, query-07, query-08). Each test takes
// a fresh project and seeds its own rows, so no two tests share points.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** One stored point, as a test seeds it. */
interface SeedPoint {
  path?: string;
  widthBand?: number;
  x: number;
  y: number;
  kind?: HeatmapKind;
  host?: string;
  fixed?: boolean;
  bot?: boolean;
  ts?: number;
}

async function seed(projectId: string, points: readonly SeedPoint[]): Promise<void> {
  await inStore(projectId, (sql) => {
    for (const point of points) {
      sql.exec(
        `INSERT INTO heatmap_points
           (event_uuid, seq, host, path, width_band, x, y, kind, fixed, bot, ts,
            session_id, distinct_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newUuid(),
        0,
        point.host ?? "www.example.com",
        point.path ?? "/pricing",
        point.widthBand ?? 1200,
        point.x,
        point.y,
        point.kind ?? "click",
        point.fixed === true ? 1 : 0,
        point.bot === true ? 1 : 0,
        point.ts ?? T0,
        null,
        null,
      );
    }
    return null;
  });
}

/** The query a heatmap request makes for /pricing in band 1200, bots included. */
function queryOf(overrides: Partial<PointsQuery> = {}): PointsQuery {
  return {
    path: "/pricing",
    widthBand: 1200,
    from: T0 - DAY_MS,
    to: T0 + DAY_MS,
    kind: null,
    includeBots: true,
    excludedHosts: [],
    ...overrides,
  };
}

/** One point as ingest hands it to the table. */
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

it("heatmaps-04 · readPoints keeps fixed and unfixed points at the same coordinates apart", async () => {
  const project = newProjectId();
  await seed(project, [
    { x: 30, y: 40, fixed: true },
    { x: 30, y: 40, fixed: false },
  ]);

  const { points } = await inStore(project, (sql) => readPoints(sql, queryOf()));
  expect(points).toEqual([
    { x: 30, y: 40, fixed: false, type: "click", count: 1 },
    { x: 30, y: 40, fixed: true, type: "click", count: 1 },
  ]);
});

it("heatmaps-11 · readPoints for band 1200 answers no point of band 1100 or 1300, unscaled", async () => {
  const project = newProjectId();
  await seed(project, [
    { widthBand: 1100, x: 1, y: 1 },
    { widthBand: 1200, x: 300, y: 400 },
    { widthBand: 1300, x: 5, y: 6 },
    { widthBand: 1200, path: "/other", x: 7, y: 8 },
    { widthBand: 1200, x: 300, y: 400 },
  ]);

  const { points, rowsRead } = await inStore(project, (sql) => readPoints(sql, queryOf()));
  expect(points).toEqual([{ x: 300, y: 400, fixed: false, type: "click", count: 2 }]);
  expect(rowsRead).toBeGreaterThan(0);
});

it("heatmaps-12 · a query that names a kind answers only that kind, and without one all three", async () => {
  const project = newProjectId();
  await seed(project, [
    { x: 10, y: 10, kind: "click" },
    { x: 11, y: 11, kind: "rageclick" },
    { x: 12, y: 12, kind: "deadclick" },
  ]);

  const all = await inStore(project, (sql) => readPoints(sql, queryOf()));
  expect(all.points).toEqual([
    { x: 10, y: 10, fixed: false, type: "click", count: 1 },
    { x: 12, y: 12, fixed: false, type: "deadclick", count: 1 },
    { x: 11, y: 11, fixed: false, type: "rageclick", count: 1 },
  ]);

  const clicks = await inStore(project, (sql) => readPoints(sql, queryOf({ kind: "click" })));
  expect(clicks.points).toEqual([{ x: 10, y: 10, fixed: false, type: "click", count: 1 }]);
});

it("heatmaps-13 · insertPoints answers how many were new, and 0 the second time", async () => {
  const project = newProjectId();
  const eventUuid = newUuid();
  const points = [
    pointOf({ eventUuid, seq: 0, x: 10, y: 20 }),
    pointOf({ eventUuid, seq: 1, x: 30, y: 40 }),
  ];

  expect(await inStore(project, (sql) => insertPoints(sql, points))).toBe(2);
  expect(await inStore(project, (sql) => insertPoints(sql, points))).toBe(0);

  const stored = await storedPoints(project);
  expect(stored).toHaveLength(2);
  expect(stored.map((point) => [point.seq, point.x, point.y])).toEqual([
    [0, 10, 20],
    [1, 30, 40],
  ]);
});

it("query-07 · bot points are left out unless includeBots", async () => {
  const project = newProjectId();
  await seed(project, [
    { x: 10, y: 10, bot: true },
    { x: 20, y: 20 },
  ]);

  const without = await inStore(project, (sql) => readPoints(sql, queryOf({ includeBots: false })));
  expect(without.points).toEqual([{ x: 20, y: 20, fixed: false, type: "click", count: 1 }]);

  const withBots = await inStore(project, (sql) => readPoints(sql, queryOf({ includeBots: true })));
  expect(withBots.points).toEqual([
    { x: 10, y: 10, fixed: false, type: "click", count: 1 },
    { x: 20, y: 20, fixed: false, type: "click", count: 1 },
  ]);
});

it("query-08 · an excluded host's points are left out, and a host that merely starts with it is kept", async () => {
  const project = newProjectId();
  await seed(project, [
    { host: "internal.example", x: 1, y: 1 },
    { host: "www.example.com", x: 2, y: 2 },
    { host: "internal.example.evil.test", x: 3, y: 3 },
  ]);

  const { points } = await inStore(project, (sql) =>
    readPoints(sql, queryOf({ excludedHosts: ["internal.example"] })),
  );
  expect(points).toEqual([
    { x: 2, y: 2, fixed: false, type: "click", count: 1 },
    { x: 3, y: 3, fixed: false, type: "click", count: 1 },
  ]);
});
