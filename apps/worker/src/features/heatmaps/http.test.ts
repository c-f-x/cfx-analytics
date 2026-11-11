import { isJsonObject } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import {
  appAt,
  fetchApp,
  inStore,
  newUuid,
  T0,
  wasContacted,
} from "../../../test/helpers/capture.ts";
import { seedProject } from "../../../test/helpers/registry.ts";
import {
  newSessionId,
  snapshotChunk,
  snapshotRequestOf,
  snapshotsDirect,
  storedChunks,
} from "../../../test/helpers/replay.ts";
import { dashboardHeaders, dashboardSession } from "../../../test/helpers/session.ts";
import type { HeatmapKind } from "./core.ts";
import { mountHeatmaps } from "./http.ts";

// POST /api/projects/:id/heatmap on a fixed clock, as the dashboard sends it
// (heatmaps-02, heatmaps-11, heatmaps-12, heatmaps-19, query-07, query-08,
// query-11, query-12, query-14, query-36, query-40). Each test takes its own
// project, and the ones that expect no answer from the store seed nothing.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const BASE = "https://dashboard.test";

const at = (ms: number): string => new Date(ms).toISOString();

function between(from: number, to: number) {
  return { kind: "between" as const, from: at(from), to: at(to) };
}

function single<T>(items: readonly T[]): T {
  const [first] = items;
  if (first === undefined || items.length !== 1) {
    throw new Error(`expected exactly one item, got ${items.length}`);
  }
  return first;
}

/** The routes on T0's clock, and a valid session at that clock. */
async function dashboard(): Promise<{ app: ReturnType<typeof appAt>; session: string }> {
  return { app: appAt(() => T0, mountHeatmaps), session: await dashboardSession(T0) };
}

async function ask(
  app: ReturnType<typeof appAt>,
  session: string,
  projectId: string,
  body: unknown,
): Promise<Response> {
  const request = new Request(`${BASE}/api/projects/${projectId}/heatmap`, {
    method: "POST",
    headers: { ...dashboardHeaders(session), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return fetchApp(app, request);
}

async function answerOf(
  response: Response,
): Promise<{ meta: Record<string, unknown>; result: Record<string, unknown> }> {
  const body: unknown = await response.json();
  if (!isJsonObject(body) || !isJsonObject(body.meta) || !isJsonObject(body.result)) {
    throw new Error(`expected a heatmap answer, got ${JSON.stringify(body)}`);
  }
  return { meta: body.meta, result: body.result };
}

async function errorOf(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (!isJsonObject(body)) throw new Error(`expected an error answer, got ${JSON.stringify(body)}`);
  return body;
}

/** One stored point, as a test seeds it. */
interface SeedPoint {
  path?: string;
  widthBand?: number;
  host?: string;
  kind?: HeatmapKind;
  x: number;
  y: number;
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL)`,
        newUuid(),
        0,
        point.host ?? "www.example.com",
        point.path ?? "/pricing",
        point.widthBand ?? 1200,
        point.x,
        point.y,
        point.kind ?? "click",
        point.bot === true ? 1 : 0,
        point.ts ?? T0,
      );
    }
    return null;
  });
}

const range = between(T0 - DAY_MS, T0 + DAY_MS);

it("heatmaps-02 · the answer holds the path's points and the newest full snapshot of the same band", async () => {
  const project = await seedProject();
  await seed(project.id, [{ x: 10, y: 20 }]);
  const sessionId = newSessionId();

  const stored = await snapshotsDirect(
    snapshotRequestOf(project.id, [
      await snapshotChunk({ sessionId, meta: { snapshotPath: "/pricing", snapshotWidth: 1240 } }),
    ]),
  );
  if (!stored.ok) throw new Error(`the chunk was not stored: ${JSON.stringify(stored.error)}`);
  const chunk = single(await storedChunks(project.id));
  expect([chunk.snapshotPath, chunk.snapshotWidth]).toEqual(["/pricing", 1240]);

  const { app, session } = await dashboard();
  const response = await ask(app, session, project.id, {
    range,
    path: "/pricing",
    widthBand: 1200,
  });

  expect(response.status).toBe(200);
  const { meta, result } = await answerOf(response);
  expect(result.points).toEqual([{ x: 10, y: 20, fixed: false, type: "click", count: 1 }]);
  expect(result.snapshot).toEqual({ sessionId, chunkKey: chunk.objectKey, width: 1240 });
  expect(meta.rowsRead).toEqual(expect.any(Number));
});

it("heatmaps-02 · a page with no full snapshot in the band is answered without one", async () => {
  const project = await seedProject();
  await seed(project.id, [{ path: "/docs", x: 10, y: 20 }]);

  const { app, session } = await dashboard();
  const response = await ask(app, session, project.id, { range, path: "/docs", widthBand: 1200 });

  expect(response.status).toBe(200);
  const { result } = await answerOf(response);
  expect(result.points).toEqual([{ x: 10, y: 20, fixed: false, type: "click", count: 1 }]);
  expect(result.snapshot).toBeNull();
});

it("heatmaps-11 · a request for band 1200 answers no point of band 1100 or 1300, unscaled", async () => {
  const project = await seedProject();
  await seed(project.id, [
    { widthBand: 1100, x: 1, y: 1 },
    { widthBand: 1200, x: 300, y: 400 },
    { widthBand: 1300, x: 5, y: 6 },
  ]);

  const { app, session } = await dashboard();
  const response = await ask(app, session, project.id, {
    range,
    path: "/pricing",
    widthBand: 1200,
  });

  expect(response.status).toBe(200);
  expect((await answerOf(response)).result.points).toEqual([
    { x: 300, y: 400, fixed: false, type: "click", count: 1 },
  ]);
});

it("heatmaps-23 · the answer lists the page's bands with points in range, counted under the same rules", async () => {
  const project = await seedProject();
  await seed(project.id, [
    { widthBand: 1300, x: 1, y: 1 },
    { widthBand: 1300, x: 2, y: 2 },
    { widthBand: 300, x: 3, y: 3 },
    { widthBand: 1200, x: 4, y: 4, bot: true },
    { widthBand: 800, x: 5, y: 5, path: "/other" },
    { widthBand: 1000, x: 6, y: 6, ts: T0 - 3 * DAY_MS },
    { widthBand: 300, x: 7, y: 7, kind: "rageclick" },
  ]);

  const { app, session } = await dashboard();
  const all = await ask(app, session, project.id, { range, path: "/pricing", widthBand: 1300 });
  expect(all.status).toBe(200);
  expect((await answerOf(all)).result.bands).toEqual([
    { widthBand: 300, points: 2 },
    { widthBand: 1300, points: 2 },
  ]);

  const rage = await ask(app, session, project.id, {
    range,
    path: "/pricing",
    widthBand: 1300,
    type: "rageclick",
    includeBots: true,
  });
  expect((await answerOf(rage)).result.bands).toEqual([{ widthBand: 300, points: 1 }]);
});

it("heatmaps-24 · with no band, the answer is the busiest band's, and names it", async () => {
  const project = await seedProject();
  await seed(project.id, [
    { widthBand: 1300, x: 1, y: 1 },
    { widthBand: 1300, x: 2, y: 2 },
    { widthBand: 300, x: 3, y: 3 },
  ]);

  const { app, session } = await dashboard();
  const busiest = await answerOf(await ask(app, session, project.id, { range, path: "/pricing" }));
  expect(busiest.result.widthBand).toBe(1300);
  expect(busiest.result.points).toEqual([
    { x: 1, y: 1, fixed: false, type: "click", count: 1 },
    { x: 2, y: 2, fixed: false, type: "click", count: 1 },
  ]);
  const asked = await answerOf(
    await ask(app, session, project.id, { range, path: "/pricing", widthBand: 300 }),
  );
  expect(asked.result.widthBand).toBe(300);

  const empty = await answerOf(await ask(app, session, project.id, { range, path: "/nothing" }));
  expect(empty.result).toEqual({ widthBand: null, points: [], bands: [], snapshot: null });
});

it("heatmaps-12 · a request that names a type answers only it, and without one all three come back", async () => {
  const project = await seedProject();
  await seed(project.id, [
    { x: 10, y: 10, kind: "click" },
    { x: 11, y: 11, kind: "rageclick" },
    { x: 12, y: 12, kind: "deadclick" },
  ]);

  const { app, session } = await dashboard();
  const all = await answerOf(
    await ask(app, session, project.id, { range, path: "/pricing", widthBand: 1200 }),
  );
  expect(all.result.points).toEqual([
    { x: 10, y: 10, fixed: false, type: "click", count: 1 },
    { x: 12, y: 12, fixed: false, type: "deadclick", count: 1 },
    { x: 11, y: 11, fixed: false, type: "rageclick", count: 1 },
  ]);

  const dead = await answerOf(
    await ask(app, session, project.id, {
      range,
      path: "/pricing",
      widthBand: 1200,
      type: "deadclick",
    }),
  );
  expect(dead.result.points).toEqual([{ x: 12, y: 12, fixed: false, type: "deadclick", count: 1 }]);
});

it("heatmaps-19 · the answer says a person-property rule and a non-$host event rule cannot apply to points", async () => {
  const project = await seedProject({
    settings: {
      internal_rules: [
        { kind: "person_property", property: "email", value: "owner@example.test" },
        { kind: "event_property", property: "$browser", value: "Chrome" },
        { kind: "event_property", property: "$host", value: "internal.example" },
      ],
    },
  });
  await seed(project.id, [{ x: 1, y: 1, host: "www.example.com" }]);

  const { app, session } = await dashboard();
  const response = await ask(app, session, project.id, {
    range,
    path: "/pricing",
    widthBand: 1200,
  });

  expect(response.status).toBe(200);
  const { meta } = await answerOf(response);
  expect(meta.excluded).toEqual({ bots: true, internalRules: [2], notApplicable: [0, 1] });
});

it("query-07 · bot points are left out unless includeBots, and the meta says so", async () => {
  const project = await seedProject();
  await seed(project.id, [
    { x: 10, y: 10, bot: true },
    { x: 20, y: 20 },
  ]);

  const { app, session } = await dashboard();
  const without = await answerOf(
    await ask(app, session, project.id, { range, path: "/pricing", widthBand: 1200 }),
  );
  expect(without.result.points).toEqual([{ x: 20, y: 20, fixed: false, type: "click", count: 1 }]);
  expect(without.meta.excluded).toEqual({ bots: true, internalRules: [], notApplicable: [] });

  const withBots = await answerOf(
    await ask(app, session, project.id, {
      range,
      path: "/pricing",
      widthBand: 1200,
      includeBots: true,
    }),
  );
  expect(withBots.result.points).toEqual([
    { x: 10, y: 10, fixed: false, type: "click", count: 1 },
    { x: 20, y: 20, fixed: false, type: "click", count: 1 },
  ]);
  expect(withBots.meta.excluded).toEqual({ bots: false, internalRules: [], notApplicable: [] });
});

it("query-08 · a $host rule leaves that host's points out and the meta names the rule", async () => {
  const project = await seedProject({
    settings: {
      internal_rules: [{ kind: "event_property", property: "$host", value: "internal.example" }],
    },
  });
  await seed(project.id, [
    { x: 1, y: 1, host: "internal.example" },
    { x: 2, y: 2, host: "www.example.com" },
  ]);

  const { app, session } = await dashboard();
  const response = await ask(app, session, project.id, {
    range,
    path: "/pricing",
    widthBand: 1200,
  });

  expect(response.status).toBe(200);
  const { meta, result } = await answerOf(response);
  expect(result.points).toEqual([{ x: 2, y: 2, fixed: false, type: "click", count: 1 }]);
  expect(meta.excluded).toEqual({ bots: true, internalRules: [0], notApplicable: [] });
});

it("query-11 · a start not before its end, or a negative start, is 400 and the project's store is not contacted", async () => {
  const project = await seedProject();
  const { app, session } = await dashboard();

  for (const bad of [between(T0, T0), between(T0 + DAY_MS, T0)]) {
    const response = await ask(app, session, project.id, {
      range: bad,
      path: "/pricing",
      widthBand: 1200,
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("validation_failed");
  }

  const negative = await ask(app, session, project.id, {
    range: { kind: "between", from: "1969-12-31T23:59:59Z", to: at(T0) },
    path: "/pricing",
    widthBand: 1200,
  });
  expect(negative.status).toBe(400);
  expect((await errorOf(negative)).code).toBe("validation_failed");
  expect(await wasContacted(project.id)).toBe(false);
});

it("query-12 · the meta holds the range as ISO UTC, the time zone, the exclusions and rowsRead", async () => {
  const project = await seedProject();
  await seed(project.id, [{ x: 1, y: 1 }]);

  const { app, session } = await dashboard();
  const response = await ask(app, session, project.id, {
    range,
    path: "/pricing",
    widthBand: 1200,
  });

  expect(response.status).toBe(200);
  const { meta } = await answerOf(response);
  expect(meta.range).toEqual({ from: at(T0 - DAY_MS), to: at(T0 + DAY_MS) });
  expect(meta.timeZone).toBe("Europe/Oslo");
  expect(meta.excluded).toEqual({ bots: true, internalRules: [], notApplicable: [] });
  expect(meta.rowsRead).toEqual(expect.any(Number));
  expect(meta).not.toHaveProperty("requested");
});

it("query-14 · with no timeZone the answer uses the project's", async () => {
  const project = await seedProject({ settings: { timezone: "America/New_York" } });
  await seed(project.id, [{ x: 1, y: 1 }]);

  const { app, session } = await dashboard();
  const response = await ask(app, session, project.id, {
    range,
    path: "/pricing",
    widthBand: 1200,
  });

  expect(response.status).toBe(200);
  expect((await answerOf(response)).meta.timeZone).toBe("America/New_York");
});

it("query-14 · an unknown IANA time zone is 400 naming timeZone, and no store is contacted", async () => {
  const project = await seedProject();
  const { app, session } = await dashboard();

  const response = await ask(app, session, project.id, {
    range,
    timeZone: "Mars/Olympus_Mons",
    path: "/pricing",
    widthBand: 1200,
  });

  expect(response.status).toBe(400);
  const body = await errorOf(response);
  expect(body.code).toBe("validation_failed");
  expect(JSON.stringify(body.issues)).toContain("/timeZone");
  expect(await wasContacted(project.id)).toBe(false);
});

it("query-36 · a date without a time is 400, and a timestamp with an offset is resolved to UTC", async () => {
  const project = await seedProject();
  const { app, session } = await dashboard();

  const bare = await ask(app, session, project.id, {
    range: { kind: "between", from: "2026-10-14", to: "2026-10-20" },
    path: "/pricing",
    widthBand: 1200,
  });
  expect(bare.status).toBe(400);
  expect((await errorOf(bare)).code).toBe("validation_failed");
  expect(await wasContacted(project.id)).toBe(false);

  const offset = await ask(app, session, project.id, {
    range: { kind: "between", from: "2026-10-14T10:00:00+02:00", to: "2026-10-20T00:00:00Z" },
    path: "/pricing",
    widthBand: 1200,
  });
  expect(offset.status).toBe(200);
  expect((await answerOf(offset)).meta.range).toEqual({
    from: "2026-10-14T08:00:00.000Z",
    to: "2026-10-20T00:00:00.000Z",
  });
});

it("query-40 · a range reaching before the heatmap retention is clipped, and requested holds what was asked", async () => {
  const project = await seedProject();
  await seed(project.id, [{ x: 7, y: 8, ts: T0 - 30 * DAY_MS }]);
  const asked = { from: T0 - 100 * DAY_MS, to: T0 - DAY_MS };

  const { app, session } = await dashboard();
  const response = await ask(app, session, project.id, {
    range: between(asked.from, asked.to),
    path: "/pricing",
    widthBand: 1200,
  });

  expect(response.status).toBe(200);
  const { meta, result } = await answerOf(response);
  expect(result.points).toEqual([{ x: 7, y: 8, fixed: false, type: "click", count: 1 }]);
  expect(meta.range).toEqual({ from: at(T0 - 90 * DAY_MS), to: at(asked.to) });
  expect(meta.requested).toEqual({ from: at(asked.from), to: at(asked.to) });
});

it("platform-01 · the heatmap route without a session is 401 and reads no store", async () => {
  const project = await seedProject();
  const { app } = await dashboard();

  const response = await fetchApp(
    app,
    new Request(`${BASE}/api/projects/${project.id}/heatmap`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ range: between(T0 - DAY_MS, T0), path: "/pricing", widthBand: 1200 }),
    }),
  );
  expect(response.status).toBe(401);
  expect(await wasContacted(project.id)).toBe(false);
});
