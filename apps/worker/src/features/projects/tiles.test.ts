import { env, SELF } from "cloudflare:test";
import { isJsonObject, STANDARD_TILES, TILE_LIMIT } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import { asRecord } from "../../../test/helpers/json.ts";
import { dashboardHeaders, dashboardSession } from "../../../test/helpers/session.ts";
import { removeProjectRows } from "./store.ts";

// The board's tiles through the Worker (D-24, projects-40 to projects-44).
// Each test creates its own project through the route, so its standard tiles
// come from the same batch as the project.

const BASE = "https://dashboard.test";

interface TileAnswer {
  id: string;
  title: string;
  spec: unknown;
  standard: boolean;
}

function isTile(value: unknown): value is TileAnswer {
  return (
    isJsonObject(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.standard === "boolean" &&
    isJsonObject(value.spec)
  );
}

async function send(
  method: string,
  path: string,
  session: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: { ...dashboardHeaders(session), "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return SELF.fetch(`${BASE}${path}`, init);
}

/** A project made through the route, and a session for it. */
async function newProject(): Promise<{ id: string; session: string }> {
  const session = await dashboardSession();
  const response = await send("POST", "/api/projects", session, { name: "Board test" });
  expect(response.status).toBe(201);
  const project = asRecord(await response.json());
  if (typeof project.id !== "string") throw new Error("the create route named no id");
  return { id: project.id, session };
}

async function tilesOf(id: string, session: string): Promise<TileAnswer[]> {
  const response = await send("GET", `/api/projects/${id}/tiles`, session);
  expect(response.status).toBe(200);
  const tiles: unknown = asRecord(await response.json()).tiles;
  if (!Array.isArray(tiles)) throw new Error("not a tile list");
  const all: unknown[] = tiles;
  return all.filter(isTile);
}

const FUNNEL = {
  kind: "funnel",
  windowMs: 86_400_000,
  steps: [
    { id: "view", event: "$pageview" },
    { id: "join", event: "waitlist_submitted" },
  ],
};

it("projects-40 · a new project's board holds the standard tiles in order", async () => {
  const { id, session } = await newProject();
  const tiles = await tilesOf(id, session);
  expect(tiles.map((tile) => tile.title)).toEqual([
    "Visitors",
    "Page views",
    "Sessions",
    "Pages",
    "Sources",
    "Countries",
    "Devices",
  ]);
  expect(tiles.every((tile) => tile.standard)).toBe(true);
});

it("projects-41 · a tile's spec is the query without its range or time zone", async () => {
  const { id, session } = await newProject();
  const tiles = await tilesOf(id, session);
  expect(tiles.map((tile) => tile.spec)).toEqual(STANDARD_TILES.map((tile) => tile.spec));
  for (const tile of tiles) {
    expect(tile.spec).not.toHaveProperty("range");
    expect(tile.spec).not.toHaveProperty("timeZone");
  }
});

it("projects-42 · a saved question is added at the end; a bad spec is 400 naming its path", async () => {
  const { id, session } = await newProject();
  const added = await send("POST", `/api/projects/${id}/tiles`, session, {
    title: "Demo to waitlist",
    spec: FUNNEL,
  });
  expect(added.status).toBe(201);
  const tile = asRecord(await added.json()).tile;
  if (!isTile(tile)) throw new Error("the answer held no tile");
  expect(tile).toMatchObject({ title: "Demo to waitlist", standard: false, spec: FUNNEL });
  expect((await tilesOf(id, session)).at(-1)?.id).toBe(tile.id);

  const badMeasure = await send("POST", `/api/projects/${id}/tiles`, session, {
    title: "Bad",
    spec: { kind: "trend", measure: 7, granularity: "day" },
  });
  expect(badMeasure.status).toBe(400);
  expect(JSON.stringify(await badMeasure.json())).toContain("/spec/measure");

  const withRange = await send("POST", `/api/projects/${id}/tiles`, session, {
    title: "Ranged",
    spec: { kind: "trend", measure: "events", granularity: "day", range: { kind: "today" } },
  });
  expect(withRange.status).toBe(400);

  const blank = await send("POST", `/api/projects/${id}/tiles`, session, {
    title: " ",
    spec: FUNNEL,
  });
  expect(blank.status).toBe(400);
});

it("projects-42 · a board holds at most TILE_LIMIT tiles", async () => {
  const { id, session } = await newProject();
  const have = (await tilesOf(id, session)).length;
  for (let index = have; index < TILE_LIMIT; index += 1) {
    const response = await send("POST", `/api/projects/${id}/tiles`, session, {
      title: `Tile ${index}`,
      spec: FUNNEL,
    });
    expect(response.status).toBe(201);
  }
  const over = await send("POST", `/api/projects/${id}/tiles`, session, {
    title: "One too many",
    spec: FUNNEL,
  });
  expect(over.status).toBe(400);
  expect((await tilesOf(id, session)).length).toBe(TILE_LIMIT);
});

it("projects-43 · a tile is renamed, moved and removed; others keep their order", async () => {
  const { id, session } = await newProject();
  const before = await tilesOf(id, session);
  const sessions = before[2];
  if (sessions === undefined) throw new Error("no third tile");

  const renamed = await send("PATCH", `/api/projects/${id}/tiles/${sessions.id}`, session, {
    title: "Visits",
  });
  expect(renamed.status).toBe(200);

  const moved = await send("PATCH", `/api/projects/${id}/tiles/${sessions.id}`, session, {
    position: 0,
  });
  expect(moved.status).toBe(200);
  const after = await tilesOf(id, session);
  expect(after.map((tile) => tile.title)).toEqual([
    "Visits",
    "Visitors",
    "Page views",
    "Pages",
    "Sources",
    "Countries",
    "Devices",
  ]);

  const respecified = await send("PATCH", `/api/projects/${id}/tiles/${sessions.id}`, session, {
    spec: FUNNEL,
  });
  expect(respecified.status).toBe(200);
  expect((await tilesOf(id, session))[0]?.spec).toEqual(FUNNEL);
  const badSpec = await send("PATCH", `/api/projects/${id}/tiles/${sessions.id}`, session, {
    spec: { kind: "trend", measure: 7, granularity: "day" },
  });
  expect(badSpec.status).toBe(400);

  const removed = await send("DELETE", `/api/projects/${id}/tiles/${sessions.id}`, session);
  expect(removed.status).toBe(204);
  expect((await tilesOf(id, session)).map((tile) => tile.id)).not.toContain(sessions.id);
});

it("projects-43 · a tile of another project, or no tile, is 404 and changes nothing", async () => {
  const mine = await newProject();
  const theirs = await newProject();
  const [foreign] = await tilesOf(theirs.id, theirs.session);
  if (foreign === undefined) throw new Error("no tile");
  for (const tileId of [foreign.id, "no-such-tile"]) {
    const patched = await send("PATCH", `/api/projects/${mine.id}/tiles/${tileId}`, mine.session, {
      title: "Taken",
    });
    expect(patched.status).toBe(404);
    const deleted = await send("DELETE", `/api/projects/${mine.id}/tiles/${tileId}`, mine.session);
    expect(deleted.status).toBe(404);
  }
  expect((await tilesOf(theirs.id, theirs.session))[0]?.title).toBe(foreign.title);
});

it("projects-44 · restore adds back the missing standard tiles at the end and keeps the rest", async () => {
  const { id, session } = await newProject();
  const before = await tilesOf(id, session);
  for (const title of ["Sessions", "Countries"]) {
    const tile = before.find((candidate) => candidate.title === title);
    if (tile === undefined) throw new Error(`no ${title} tile`);
    expect((await send("DELETE", `/api/projects/${id}/tiles/${tile.id}`, session)).status).toBe(
      204,
    );
  }
  const custom = await send("POST", `/api/projects/${id}/tiles`, session, {
    title: "Mine",
    spec: FUNNEL,
  });
  expect(custom.status).toBe(201);

  const restored = await send("POST", `/api/projects/${id}/tiles/restore`, session);
  expect(restored.status).toBe(200);
  expect((await tilesOf(id, session)).map((tile) => tile.title)).toEqual([
    "Visitors",
    "Page views",
    "Pages",
    "Sources",
    "Devices",
    "Mine",
    "Sessions",
    "Countries",
  ]);
});

it("projects-44 · removing a project's rows removes its tiles too", async () => {
  const { id } = await newProject();
  const removed = await removeProjectRows(env.REGISTRY, id);
  expect(removed.ok).toBe(true);
  const left = await env.REGISTRY.prepare(
    "SELECT COUNT(*) AS n FROM board_tiles WHERE project_id = ?",
  )
    .bind(id)
    .first<{ n: number }>();
  expect(left?.n).toBe(0);
});

it("projects-45 · a standard tile with a changed question is the board's own, and restore adds the standard one back once", async () => {
  const { id, session } = await newProject();
  const [visitors, pageViews] = await tilesOf(id, session);
  if (visitors === undefined || pageViews === undefined) throw new Error("no standard tiles");

  const renamed = await send("PATCH", `/api/projects/${id}/tiles/${pageViews.id}`, session, {
    title: "Views",
  });
  expect(renamed.status).toBe(200);
  const changed = await send("PATCH", `/api/projects/${id}/tiles/${visitors.id}`, session, {
    spec: FUNNEL,
  });
  expect(changed.status).toBe(200);
  const after = await tilesOf(id, session);
  expect(after.find((tile) => tile.id === visitors.id)?.standard).toBe(false);
  expect(after.find((tile) => tile.id === pageViews.id)?.standard).toBe(true);

  expect((await send("POST", `/api/projects/${id}/tiles/restore`, session)).status).toBe(200);
  const restored = await tilesOf(id, session);
  // The edited tile keeps its title; restore adds the one standard Visitors tile beside it.
  expect(restored.filter((tile) => tile.title === "Visitors").map((tile) => tile.standard)).toEqual(
    [false, true],
  );
  expect(restored.map((tile) => tile.title)).toContain("Views");
  expect(restored.map((tile) => tile.title)).not.toContain("Page views");

  expect((await send("POST", `/api/projects/${id}/tiles/restore`, session)).status).toBe(200);
  expect((await tilesOf(id, session)).length).toBe(restored.length);
});
