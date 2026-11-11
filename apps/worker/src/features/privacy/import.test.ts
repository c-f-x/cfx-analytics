import { SELF } from "cloudflare:test";
import { EXPORT_TABLES, IMPORT_ORDER } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import { INTAKE, inStore, T0 } from "../../../test/helpers/capture.ts";
import { asRecord } from "../../../test/helpers/json.ts";
import { newProjectId, seedProject } from "../../../test/helpers/registry.ts";
import { seedEvents, seedPerson } from "../../../test/helpers/seed.ts";
import { dashboardHeaders, dashboardSession } from "../../../test/helpers/session.ts";

// The import route, the restore's way back in (privacy-30 to privacy-32):
// a backup's lines become the rows they came from.

/** Every exported table of `projectId`, all pages, as the export route gives them. */
async function exportAll(projectId: string, headers: Record<string, string>) {
  const all: Record<string, string[]> = {};
  for (const table of EXPORT_TABLES) {
    const lines: string[] = [];
    let after = 0;
    for (;;) {
      const response = await SELF.fetch(
        `${INTAKE}/api/projects/${projectId}/export/${table}?after=${String(after)}`,
        { headers },
      );
      expect(response.status).toBe(200);
      const page = asRecord(await response.json());
      const got: unknown = page.lines;
      if (!Array.isArray(got)) throw new Error(`${table} answered no lines`);
      for (const line of got) if (typeof line === "string") lines.push(line);
      if (typeof page.next !== "number") break;
      after = page.next;
    }
    all[table] = lines;
  }
  return all;
}

function importLines(
  projectId: string,
  table: string,
  lines: unknown[],
  headers: Record<string, string>,
): Promise<Response> {
  return SELF.fetch(`${INTAKE}/api/projects/${projectId}/import/${table}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ lines }),
  });
}

/** A project with a person, events, a recording with a chunk and a heatmap point. */
async function fullProject(): Promise<string> {
  const project = await seedProject({ id: newProjectId() });
  const person = await seedPerson(project.id, ["import-a", "import-b"], { plan: "pro" });
  await seedEvents(project.id, [
    { ts: T0, distinctId: "import-a", personId: person },
    { ts: T0 + 1000, distinctId: "import-b", personId: person },
  ]);
  await inStore(project.id, (sql) => {
    sql.exec(
      `INSERT INTO recordings (session_id, distinct_id, person_id, start_ts, end_ts, active_ms, first_url, clicks, keypresses, bytes)
       VALUES ('s-1', 'import-a', ?, ?, ?, 900, 'https://x.test/', 2, 1, 400)`,
      person,
      T0,
      T0 + 5000,
    );
    sql.exec(
      `INSERT INTO recording_chunks (uuid, session_id, object_key, first_ts, last_ts, received_at, bytes, snapshot_path, snapshot_width)
       VALUES ('c-1', 's-1', 'k/s-1/1.ndjson.gz', ?, ?, ?, 400, '/', 1280)`,
      T0,
      T0 + 5000,
      T0 + 6000,
    );
    sql.exec(
      `INSERT INTO heatmap_points (event_uuid, seq, host, path, width_band, x, y, kind, fixed, bot, ts, session_id, distinct_id)
       VALUES ('e-1', 0, 'x.test', '/', 1200, 10, 20, 'click', 0, 0, ?, 's-1', 'import-a')`,
      T0,
    );
    return null;
  });
  return project.id;
}

it("privacy-32 · every table exported and imported into an empty project exports the same lines", async () => {
  const headers = dashboardHeaders(await dashboardSession());
  const source = await fullProject();
  const target = await seedProject({ id: newProjectId() });
  const exported = await exportAll(source, headers);
  for (const table of EXPORT_TABLES) expect(exported[table]?.length ?? 0).toBeGreaterThan(0);

  for (const table of IMPORT_ORDER) {
    const response = await importLines(target.id, table, exported[table] ?? [], headers);
    expect({ table, status: response.status }).toEqual({ table, status: 200 });
    expect(asRecord(await response.json()).added).toBe(exported[table]?.length);
  }
  expect(await exportAll(target.id, headers)).toEqual(exported);
});

it("privacy-30 · importing the same lines again adds nothing", async () => {
  const headers = dashboardHeaders(await dashboardSession());
  const source = await fullProject();
  const target = await seedProject({ id: newProjectId() });
  const exported = await exportAll(source, headers);
  for (const table of IMPORT_ORDER) {
    await importLines(target.id, table, exported[table] ?? [], headers);
  }
  for (const table of IMPORT_ORDER) {
    const again = await importLines(target.id, table, exported[table] ?? [], headers);
    expect(asRecord(await again.json()).added).toBe(0);
  }
  expect(await exportAll(target.id, headers)).toEqual(exported);
});

it("privacy-31 · a line with a wrong column is 400 naming it, and nothing of the request is stored", async () => {
  const headers = dashboardHeaders(await dashboardSession());
  const source = await fullProject();
  const target = await seedProject({ id: newProjectId() });
  const exported = await exportAll(source, headers);
  const [good] = exported.persons ?? [];
  if (good === undefined) throw new Error("no person line");
  const extra = JSON.stringify({ ...JSON.parse(good), id: 99, sneaky: 1 });
  const missing = JSON.stringify({ id: 98 });

  for (const lines of [
    [good, extra],
    [good, missing],
    [good, "not json"],
    [good, 7],
  ]) {
    const response = await importLines(target.id, "persons", lines, headers);
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain("line 2");
  }
  const after = await exportAll(target.id, headers);
  expect(after.persons).toEqual([]);

  for (const table of ["salts", "cookieless_sessions", "store_meta", "nothing"]) {
    expect((await importLines(target.id, table, [], headers)).status).toBe(404);
  }
  const tooMany = Array.from({ length: 501 }, () => good);
  expect((await importLines(target.id, "persons", tooMany, headers)).status).toBe(400);
});

it("privacy-30 · a row naming a person not imported yet is 409 naming the order, and nothing is stored", async () => {
  const headers = dashboardHeaders(await dashboardSession());
  const source = await fullProject();
  const target = await seedProject({ id: newProjectId() });
  const exported = await exportAll(source, headers);
  const response = await importLines(target.id, "events", exported.events ?? [], headers);
  expect(response.status).toBe(409);
  expect(JSON.stringify(await response.json())).toContain("persons, person_distinct_ids, events");
  expect((await exportAll(target.id, headers)).events).toEqual([]);
});

it("privacy-31 · the import route needs a session and the dashboard's origin", async () => {
  const target = await seedProject({ id: newProjectId() });
  const session = await dashboardSession();
  const noSession = await importLines(target.id, "persons", [], {});
  expect(noSession.status).toBe(401);
  const otherOrigin = await importLines(target.id, "persons", [], {
    ...dashboardHeaders(session),
    origin: "https://elsewhere.test",
  });
  expect(otherOrigin.status).toBe(403);
});
