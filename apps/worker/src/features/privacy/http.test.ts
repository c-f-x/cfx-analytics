import { SELF } from "cloudflare:test";
import { type ErasedCounts, EXPORT_TABLES, PURGE_DELAY_MS } from "@cfanalytics/shared";
import { Hono } from "hono";
import { expect, it } from "vitest";
import {
  CLIENT_IP,
  fetchApp,
  INTAKE,
  jsBatch,
  jsRequest,
  personIdOf,
  T0,
} from "../../../test/helpers/capture.ts";
import { asRecord } from "../../../test/helpers/json.ts";
import { newProjectId, seedProject } from "../../../test/helpers/registry.ts";
import { seedEvents, seedFixture, seedPerson } from "../../../test/helpers/seed.ts";
import { dashboardHeaders, dashboardSession } from "../../../test/helpers/session.ts";
import { realDeps } from "../../platform/deps.ts";
import type { AppEnv } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { mountPrivacy } from "./http.ts";

// The dashboard's privacy routes through the Worker (privacy-02, privacy-17,
// privacy-18, privacy-20, privacy-22, privacy-25, privacy-26): a deletion by
// person, the export's pages and the purge's start, each behind Access.

/** The counts of a deletion that found nothing, zeros included (privacy-17). */
function zeros(): ErasedCounts {
  return {
    events: 0,
    persons: 0,
    person_distinct_ids: 0,
    recordings: 0,
    recording_chunks: 0,
    heatmap_points: 0,
    objects: 0,
  };
}

/** A POST with the dashboard's headers and a JSON body, to `path`. */
function post(path: string, headers: Record<string, string>, body?: string): Promise<Response> {
  const init: RequestInit = { method: "POST", headers };
  if (body !== undefined) init.body = body;
  return SELF.fetch(new Request(new URL(path, INTAKE), init));
}

/** A GET with the dashboard's headers, to `path`. */
function get(path: string, headers: Record<string, string>): Promise<Response> {
  return SELF.fetch(new Request(new URL(path, INTAKE), { headers }));
}

it("privacy-02 · the erase route deletes the person's rows and answers a count per table", async () => {
  const project = await seedProject({ id: newProjectId() });
  const person = await seedPerson(project.id, ["erase-2a", "erase-2b"]);
  await seedEvents(project.id, [
    { ts: T0, distinctId: "erase-2a", personId: person },
    { ts: T0 + 1000, event: "$pageleave", distinctId: "erase-2b", personId: person },
  ]);
  const headers = {
    ...dashboardHeaders(await dashboardSession()),
    "content-type": "application/json",
  };

  const response = await post(
    `/api/projects/${project.id}/persons/erase`,
    headers,
    JSON.stringify({ distinctId: "erase-2a" }),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({
    counts: { ...zeros(), events: 2, persons: 1, person_distinct_ids: 2 },
  });
  expect(await personIdOf(project.id, "erase-2b")).toBeNull();
});

it("privacy-17 · the erase route answers 200 with zeros for an unknown id and for a repeat", async () => {
  const project = await seedProject({ id: newProjectId() });
  const person = await seedPerson(project.id, ["twice-17"]);
  await seedEvents(project.id, [{ ts: T0, distinctId: "twice-17", personId: person }]);
  const headers = {
    ...dashboardHeaders(await dashboardSession()),
    "content-type": "application/json",
  };
  const erase = (distinctId: string) =>
    post(`/api/projects/${project.id}/persons/erase`, headers, JSON.stringify({ distinctId }));

  const unknown = await erase("nobody-17");
  expect(unknown.status).toBe(200);
  expect(await unknown.json()).toEqual({ counts: zeros() });

  const first = await erase("twice-17");
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({
    counts: { ...zeros(), events: 1, persons: 1, person_distinct_ids: 1 },
  });

  const repeat = await erase("twice-17");
  expect(repeat.status).toBe(200);
  expect(await repeat.json()).toEqual({ counts: zeros() });
});

it("privacy-18 · the distinct id comes from the body, never the URL or the log", async () => {
  const project = await seedProject({ id: newProjectId() });
  await seedPerson(project.id, ["url-18"]);
  const bodyPerson = await seedPerson(project.id, ["body-18"]);
  await seedEvents(project.id, [{ ts: T0, distinctId: "body-18", personId: bodyPerson }]);
  const headers = {
    ...dashboardHeaders(await dashboardSession()),
    "content-type": "application/json",
  };
  const lines: string[] = [];

  // The privacy routes alone, with a logger the test reads.
  const app = new Hono<AppEnv>();
  app.onError((error) => {
    throw error;
  });
  app.use("*", async (c, next) => {
    c.set("deps", { ...realDeps(), log: createLogger((line) => lines.push(line)) });
    await next();
  });
  mountPrivacy(app);

  const url = new URL(`/api/projects/${project.id}/persons/erase`, INTAKE);
  url.searchParams.set("distinctId", "url-18");
  const queryOnly = await fetchApp(app, new Request(url, { method: "POST", headers, body: "{}" }));

  expect(queryOnly.status).toBe(400);
  expect(asRecord(await queryOnly.json()).code).toBe("validation_failed");
  for (const line of lines) expect(line).not.toContain("url-18");

  // A body id wins over the one the URL names.
  const both = await fetchApp(
    app,
    new Request(url, { method: "POST", headers, body: JSON.stringify({ distinctId: "body-18" }) }),
  );
  expect(both.status).toBe(200);
  expect(asRecord(await both.json()).counts).toEqual({
    ...zeros(),
    events: 1,
    persons: 1,
    person_distinct_ids: 1,
  });
  expect(await personIdOf(project.id, "url-18")).not.toBeNull();
  expect(await personIdOf(project.id, "body-18")).toBeNull();
});

it("privacy-20 · the purge route answers 202 at mark plus a minute, 409 unmarked and 404 unknown", async () => {
  // Marked at the wall clock: the route sets the store's alarm to the purge's
  // time, and workerd fires an alarm set in the past at once, which would
  // purge the project while the test runs.
  const deletedAt = Date.now();
  const marked = await seedProject({ id: newProjectId(), deletedAt });
  const unmarked = await seedProject({ id: newProjectId() });
  const headers = dashboardHeaders(await dashboardSession());
  const purge = (projectId: string) => post(`/api/projects/${projectId}/purge`, headers);

  const answer = await purge(marked.id);
  expect(answer.status).toBe(202);
  expect(await answer.json()).toEqual({ purgeAt: new Date(deletedAt + 60_000).toISOString() });
  expect(PURGE_DELAY_MS).toBe(60_000);

  const refused = await purge(unmarked.id);
  expect(refused.status).toBe(409);
  expect(asRecord(await refused.json()).code).toBe("not_deleted");

  const missing = await purge(newProjectId());
  expect(missing.status).toBe(404);
  expect(asRecord(await missing.json()).code).toBe("not_found");
});

it("privacy-22 · the export route answers a page for each exported table and refuses the salts", async () => {
  const project = await seedProject({ id: newProjectId() });
  const person = await seedPerson(project.id, ["export-22"]);
  await seedEvents(project.id, [{ ts: T0, distinctId: "export-22", personId: person }]);
  const headers = dashboardHeaders(await dashboardSession());
  const exportOf = (table: string) => get(`/api/projects/${project.id}/export/${table}`, headers);
  // One person with one id and one event; nothing recorded and no point.
  const rows = new Map<string, number>([
    ["events", 1],
    ["persons", 1],
    ["person_distinct_ids", 1],
    ["recordings", 0],
    ["recording_chunks", 0],
  ]);

  for (const table of [
    "events",
    "persons",
    "person_distinct_ids",
    "recordings",
    "recording_chunks",
  ]) {
    const response = await exportOf(table);
    expect(response.status).toBe(200);
    const page = asRecord(await response.json());
    expect(Array.isArray(page.lines)).toBe(true);
    const expected = rows.get(table);
    if (expected === undefined) throw new Error("the test names an unexpected table");
    expect(page.lines).toHaveLength(expected);
  }
  // heatmap_points is the sixth exported table, and holds nothing either.
  const points = asRecord(await (await exportOf("heatmap_points")).json());
  expect(points.lines).toHaveLength(0);

  for (const table of ["salts", "cookieless_sessions"]) {
    const response = await exportOf(table);
    expect(response.status).toBe(404);
    expect(asRecord(await response.json()).code).toBe("not_found");
  }
});

it("privacy-25 · the export route pages 10,001 events as 10,000 lines and a cursor, then one line", async () => {
  const project = await seedProject({ id: newProjectId() });
  await seedFixture(project.id, { events: 10_001, persons: 50, days: 30, end: T0 });
  const headers = dashboardHeaders(await dashboardSession());
  const exportOf = (after?: number) => {
    const url = new URL(`/api/projects/${project.id}/export/events`, INTAKE);
    if (after !== undefined) url.searchParams.set("after", String(after));
    return SELF.fetch(new Request(url, { headers }));
  };

  const first = asRecord(await (await exportOf()).json());
  expect(first.lines).toHaveLength(10_000);
  const cursor = first.next;
  if (typeof cursor !== "number") throw new Error("the first page named no cursor");

  const second = asRecord(await (await exportOf(cursor)).json());
  expect(second.lines).toHaveLength(1);
  expect(second.next).toBeNull();
});

it("privacy-26 · no export line holds an address a capture request carried", async () => {
  const project = await seedProject({ id: newProjectId() });
  const forwarded = "198.51.100.24";
  const realIp = "198.51.100.25";
  const propertyIp = "198.51.100.26";

  const captured = await SELF.fetch(
    await jsRequest(
      jsBatch(project.token, [
        { event: "$pageview", distinctId: "user-26", properties: { $ip: propertyIp } },
      ]),
      "json",
      {
        ip: CLIENT_IP,
        headers: { "x-forwarded-for": forwarded, "x-real-ip": realIp },
      },
    ),
  );
  expect(captured.status).toBe(200);

  const headers = dashboardHeaders(await dashboardSession());
  for (const table of EXPORT_TABLES) {
    const response = await get(`/api/projects/${project.id}/export/${table}`, headers);
    expect(response.status).toBe(200);
    const text = JSON.stringify(await response.json());
    for (const address of [CLIENT_IP, forwarded, realIp, propertyIp]) {
      expect(text).not.toContain(address);
    }
  }
});
