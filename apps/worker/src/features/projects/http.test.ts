import { env, SELF } from "cloudflare:test";
import { ERROR_CODES, isJsonObject, QUERY } from "@cfanalytics/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  newProjectId as projectId,
  newSecretKey as secretKey,
  seedProject,
  sha256Hex,
} from "../../../test/helpers/registry.ts";
import {
  dashboardHeaders,
  dashboardSession,
  sessionCookie,
} from "../../../test/helpers/session.ts";
import { realDeps } from "../../platform/deps.ts";
import type { AppEnv } from "../../platform/http.ts";
import { createLogger } from "../../platform/log.ts";
import { mountProjects } from "./http.ts";

// The dashboard's project routes, through SELF.fetch with a real signed
// session (platform-01, platform-07, platform-08). Each test makes its own
// project ids, tokens and keys.

const BASE = "https://dashboard.test";

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!isJsonObject(value)) throw new Error("expected a JSON object");
  return value;
}

const messageOf = (body: Record<string, unknown>): string =>
  typeof body.message === "string" ? body.message : "";

function findString(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value === "string") return pattern.test(value) ? value : undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, pattern);
      if (found !== undefined) return found;
    }
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      const found = findString(item, pattern);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

async function projectRow(id: string): Promise<Record<string, unknown> | null> {
  return env.REGISTRY.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
}

async function projectCount(): Promise<number> {
  const row = await env.REGISTRY.prepare("SELECT COUNT(*) AS count FROM projects").first<{
    count: number;
  }>();
  return row?.count ?? -1;
}

async function keyCount(id: string): Promise<number> {
  const row = await env.REGISTRY.prepare(
    "SELECT COUNT(*) AS count FROM secret_keys WHERE project_id = ?",
  )
    .bind(id)
    .first<{ count: number }>();
  return row?.count ?? -1;
}

async function deletedAt(id: string): Promise<number | null> {
  const row = await env.REGISTRY.prepare("SELECT deleted_at FROM projects WHERE id = ?")
    .bind(id)
    .first<{ deleted_at: number | null }>();
  return row?.deleted_at ?? null;
}

function createRequest(session: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: { ...dashboardHeaders(session), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchRequest(session: string, id: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}/api/projects/${id}`, {
    method: "PATCH",
    headers: { ...dashboardHeaders(session), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deleteRequest(session: string, id: string, body?: unknown): Promise<Response> {
  const headers = { ...dashboardHeaders(session), "content-type": "application/json" };
  if (body === undefined) {
    return SELF.fetch(`${BASE}/api/projects/${id}`, { method: "DELETE", headers });
  }
  return SELF.fetch(`${BASE}/api/projects/${id}`, {
    method: "DELETE",
    headers,
    body: JSON.stringify(body),
  });
}

describe("creating a project", () => {
  it("projects-01 · creating a project writes the documented settings", async () => {
    const session = await dashboardSession();
    const response = await createRequest(session, { name: "  The owner's site  " });
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);

    const body = await bodyOf(response);
    const id = findString(body, /^p_[a-z2-7]{16}$/);
    const token = findString(body, /^cfa_pk_[A-Za-z0-9_-]{43}$/);
    if (id === undefined || token === undefined) throw new Error("the answer holds no project");

    const row = await projectRow(id);
    expect(row?.name).toBe("The owner's site");
    expect(row?.token).toBe(token);
    const expected: Record<string, string | number> = {
      timezone: "Europe/Oslo",
      events_retention_days: 395,
      recordings_retention_days: 30,
      heatmaps_retention_days: 90,
      daily_event_cap: 40_000,
      daily_recording_bytes_cap: 500_000_000,
      recording_enabled: 0,
      recording_sample_rate: 1,
      recording_min_duration_ms: 2000,
      heatmaps_enabled: 0,
      autocapture_enabled: 1,
      dead_clicks_enabled: 0,
      internal_rules: "[]",
    };
    for (const [column, value] of Object.entries(expected)) {
      expect(row?.[column]).toBe(value);
    }
  });

  it("projects-03 · a blank name is refused and no project is written", async () => {
    const session = await dashboardSession();
    for (const name of ["", "   "]) {
      const before = await projectCount();
      const response = await createRequest(session, { name });
      expect(response.status).toBe(400);
      expect(messageOf(await bodyOf(response))).toMatch(/name/i);
      expect(await projectCount()).toBe(before);
    }
  });

  it("projects-04 · an unknown time zone is refused and no project is written", async () => {
    const session = await dashboardSession();
    const before = await projectCount();
    const response = await createRequest(session, {
      name: "Site",
      settings: { timezone: "Mars/Olympus" },
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await bodyOf(response))).toContain("timezone");
    expect(await projectCount()).toBe(before);
  });

  it("projects-05 · an out-of-range setting is 400 naming it, and nothing is written", async () => {
    const session = await dashboardSession();
    const before = await projectCount();
    const response = await createRequest(session, {
      name: "Site",
      settings: { recordings_retention_days: 366 },
    });
    expect(response.status).toBe(400);
    const body = JSON.stringify(await bodyOf(response));
    expect(body).toContain("recordings_retention_days");
    expect(body).toContain("365");
    expect(await projectCount()).toBe(before);

    const seeded = await seedProject();
    const patch = await patchRequest(session, seeded.id, { recording_sample_rate: 1.5 });
    expect(patch.status).toBe(400);
    expect(JSON.stringify(await bodyOf(patch))).toContain("recording_sample_rate");
    expect((await projectRow(seeded.id))?.recording_sample_rate).toBe(1);
  });

  it("projects-39 · a body over 100 KB is 413 and no project is written", async () => {
    const session = await dashboardSession();
    const before = await projectCount();
    const response = await createRequest(session, { name: "x".repeat(QUERY.bodyBytes) });
    expect(response.status).toBe(413);
    expect((await bodyOf(response)).code).toBe("body_too_large");
    expect(await projectCount()).toBe(before);
  });

  it("projects-07 · an internal rule that is not valid JSON is 400", async () => {
    const session = await dashboardSession();
    const response = await createRequest(session, {
      name: "Site",
      settings: { internal_rules: '[{"kind":"event_property",' },
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await bodyOf(response))).toContain("internal_rules");
  });
});

describe("updating a project", () => {
  it("projects-08 · a partial update changes only the setting it names", async () => {
    const session = await dashboardSession();
    const seeded = await seedProject();
    const response = await patchRequest(session, seeded.id, { recording_min_duration_ms: 5000 });
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);

    const row = await projectRow(seeded.id);
    expect(row?.recording_min_duration_ms).toBe(5000);
    expect(row?.daily_event_cap).toBe(40_000);
    expect(row?.timezone).toBe("Europe/Oslo");
    expect(row?.recording_enabled).toBe(0);
  });

  it("projects-08 · an unknown setting name is 400 and changes nothing", async () => {
    const session = await dashboardSession();
    const seeded = await seedProject();
    const response = await patchRequest(session, seeded.id, { retention_days: 5 });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await bodyOf(response))).toContain("retention_days");
    expect((await projectRow(seeded.id))?.events_retention_days).toBe(395);
  });
});

describe("secret keys", () => {
  it("projects-14 · creating a key shows it once and stores only its hash", async () => {
    const session = await dashboardSession();
    const seeded = await seedProject();
    const response = await SELF.fetch(`${BASE}/api/projects/${seeded.id}/keys`, {
      method: "POST",
      headers: { ...dashboardHeaders(session), "content-type": "application/json" },
      body: JSON.stringify({ label: "Production" }),
    });
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);

    const shown = findString(await bodyOf(response), /^cfa_sk_[A-Za-z0-9_-]{43}$/);
    if (shown === undefined) throw new Error("the answer shows no key");

    const rows = await env.REGISTRY.prepare("SELECT * FROM secret_keys WHERE project_id = ?")
      .bind(seeded.id)
      .all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.hash).toBe(await sha256Hex(shown));
    expect(rows.results[0]?.label).toBe("Production");
    expect(JSON.stringify(rows.results)).not.toContain(shown);
  });

  it("projects-16 · listing a project's keys never shows a hash or plaintext", async () => {
    const session = await dashboardSession();
    const seeded = await seedProject();
    const key = secretKey();
    const hash = await sha256Hex(key);
    await env.REGISTRY.prepare(
      "INSERT INTO secret_keys (hash, project_id, label, created_at, last_used_day) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(hash, seeded.id, "CLI", 1_700_000_000_000, "2026-10-20")
      .run();

    const response = await SELF.fetch(`${BASE}/api/projects/${seeded.id}/keys`, {
      headers: dashboardHeaders(session),
    });
    expect(response.status).toBe(200);
    const text = JSON.stringify(await bodyOf(response));
    expect(text).toContain("CLI");
    expect(text).toContain("2026-10-20");
    expect(text).toContain(hash.slice(0, 12));
    expect(text).not.toContain(key);
    expect(text).not.toContain(hash);
  });

  it("projects-20 · revoking another project's key is 404 and the key stays", async () => {
    const session = await dashboardSession();
    const first = await seedProject();
    const second = await seedProject();
    const key = secretKey();
    const hash = await sha256Hex(key);
    await env.REGISTRY.prepare(
      "INSERT INTO secret_keys (hash, project_id, label, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(hash, second.id, "Second project's key", 1_700_000_000_000)
      .run();

    const response = await SELF.fetch(
      `${BASE}/api/projects/${first.id}/keys/${hash.slice(0, 12)}`,
      {
        method: "DELETE",
        headers: dashboardHeaders(session),
      },
    );
    expect(response.status).toBe(404);
    expect(await keyCount(second.id)).toBe(1);
  });
});

describe("deleting a project", () => {
  it("projects-21 · delete asks for the project's name, repeats idempotently, and an unknown id is 404", async () => {
    const session = await dashboardSession();
    const seeded = await seedProject({ name: "Alpha" });

    const ask = await deleteRequest(session, seeded.id, {});
    expect(ask.status).toBe(400);
    expect(messageOf(await bodyOf(ask))).toMatch(/confirm/i);
    expect(await deletedAt(seeded.id)).toBeNull();

    const wrong = await deleteRequest(session, seeded.id, { confirm: "Beta" });
    expect(wrong.status).toBe(400);
    expect(await deletedAt(seeded.id)).toBeNull();

    const first = await deleteRequest(session, seeded.id, { confirm: "Alpha" });
    expect(first.status).toBeGreaterThanOrEqual(200);
    expect(first.status).toBeLessThan(300);
    const marked = await deletedAt(seeded.id);
    expect(marked).not.toBeNull();

    const second = await deleteRequest(session, seeded.id, { confirm: "Alpha" });
    expect(second.status).toBeGreaterThanOrEqual(200);
    expect(second.status).toBeLessThan(300);
    expect(await deletedAt(seeded.id)).toBe(marked);

    const unknown = await deleteRequest(session, projectId(), { confirm: "Alpha" });
    expect(unknown.status).toBe(404);
  });
});

describe("state changes and the dashboard's origin", () => {
  it("projects-26 · create, update, delete and revoke need the dashboard's origin", async () => {
    const session = await dashboardSession();
    const seeded = await seedProject({ name: "Alpha" });
    const key = secretKey();
    const hash = await sha256Hex(key);
    await env.REGISTRY.prepare(
      "INSERT INTO secret_keys (hash, project_id, label, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(hash, seeded.id, "CLI", 1_700_000_000_000)
      .run();
    const evil = {
      cookie: sessionCookie(session),
      origin: "https://evil.test",
      "content-type": "application/json",
    };

    const before = await projectCount();
    const create = await SELF.fetch(`${BASE}/api/projects`, {
      method: "POST",
      headers: evil,
      body: JSON.stringify({ name: "Evil" }),
    });
    expect(create.status).toBe(403);
    expect((await bodyOf(create)).code).toBe("forbidden_origin");
    expect(await projectCount()).toBe(before);

    const update = await SELF.fetch(`${BASE}/api/projects/${seeded.id}`, {
      method: "PATCH",
      headers: evil,
      body: JSON.stringify({ daily_event_cap: 999 }),
    });
    expect(update.status).toBe(403);
    expect((await projectRow(seeded.id))?.daily_event_cap).toBe(40_000);

    const remove = await SELF.fetch(`${BASE}/api/projects/${seeded.id}`, {
      method: "DELETE",
      headers: evil,
      body: JSON.stringify({ confirm: "Alpha" }),
    });
    expect(remove.status).toBe(403);
    expect(await deletedAt(seeded.id)).toBeNull();

    const revoke = await SELF.fetch(`${BASE}/api/projects/${seeded.id}/keys/${hash.slice(0, 12)}`, {
      method: "DELETE",
      headers: evil,
    });
    expect(revoke.status).toBe(403);
    expect(await keyCount(seeded.id)).toBe(1);

    const addKey = await SELF.fetch(`${BASE}/api/projects/${seeded.id}/keys`, {
      method: "POST",
      headers: evil,
      body: JSON.stringify({ label: "Evil" }),
    });
    expect(addKey.status).toBe(403);
    expect(await keyCount(seeded.id)).toBe(1);
  });

  it("projects-26 · a missing Origin is accepted with a dashboard Referer and refused with neither", async () => {
    const session = await dashboardSession();
    const body = JSON.stringify({ name: "Referer project" });

    const withReferer = await SELF.fetch(`${BASE}/api/projects`, {
      method: "POST",
      headers: {
        cookie: sessionCookie(session),
        referer: `${env.DASHBOARD_ORIGIN}/projects`,
        "content-type": "application/json",
      },
      body,
    });
    expect(withReferer.status).toBeGreaterThanOrEqual(200);
    expect(withReferer.status).toBeLessThan(300);

    const foreignReferer = await SELF.fetch(`${BASE}/api/projects`, {
      method: "POST",
      headers: {
        cookie: sessionCookie(session),
        referer: "https://evil.test/projects",
        "content-type": "application/json",
      },
      body,
    });
    expect(foreignReferer.status).toBe(403);

    const neither = await SELF.fetch(`${BASE}/api/projects`, {
      method: "POST",
      headers: { cookie: sessionCookie(session), "content-type": "application/json" },
      body,
    });
    expect(neither.status).toBe(403);
  });
});

describe("a secret key on the dashboard", () => {
  it("platform-07 · a key sent as a Bearer token is 401 on every dashboard path", async () => {
    const session = await dashboardSession();
    const seeded = await seedProject({ name: "Alpha" });
    const headers = {
      ...dashboardHeaders(session),
      authorization: `Bearer ${secretKey()}`,
      "content-type": "application/json",
    };

    const list = await SELF.fetch(`${BASE}/api/projects`, { headers });
    expect(list.status).toBe(401);
    const one = await SELF.fetch(`${BASE}/api/projects/${seeded.id}`, { headers });
    expect(one.status).toBe(401);

    const before = await projectCount();
    const create = await SELF.fetch(`${BASE}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Bearer" }),
    });
    expect(create.status).toBe(401);
    expect(await projectCount()).toBe(before);

    const remove = await SELF.fetch(`${BASE}/api/projects/${seeded.id}`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ confirm: "Alpha" }),
    });
    expect(remove.status).toBe(401);
    expect(await deletedAt(seeded.id)).toBeNull();
  });

  it("platform-08 · another project's key gets one identical 401 for an existing and an unknown id", async () => {
    const session = await dashboardSession();
    const first = await seedProject();
    const second = await seedProject();
    const key = secretKey();
    await env.REGISTRY.prepare(
      "INSERT INTO secret_keys (hash, project_id, label, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(await sha256Hex(key), second.id, "Second project's key", 1_700_000_000_000)
      .run();
    const headers = { ...dashboardHeaders(session), authorization: `Bearer ${key}` };

    const existing = await SELF.fetch(`${BASE}/api/projects/${first.id}`, { headers });
    const unknown = await SELF.fetch(`${BASE}/api/projects/${projectId()}`, { headers });
    expect(existing.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await existing.text()).toBe(await unknown.text());
    expect(await deletedAt(first.id)).toBeNull();
  });
});

describe("bad input", () => {
  it("platform-34 · a bad request answers JSON with one sentence naming the bad input", async () => {
    const session = await dashboardSession();
    const response = await createRequest(session, {
      name: "Site",
      settings: { daily_event_cap: 0 },
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await bodyOf(response);
    expect(ERROR_CODES.some((code) => code === body.code)).toBe(true);
    const message = messageOf(body);
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain("\n");
    expect((message.match(/[.!?](\s|$)/g) ?? []).length).toBeLessThanOrEqual(1);
    expect(JSON.stringify(body)).toContain("daily_event_cap");

    const missing = await SELF.fetch(`${BASE}/api/projects/${projectId()}`, {
      headers: dashboardHeaders(session),
    });
    expect(missing.status).toBe(404);
    expect((await bodyOf(missing)).code).toBe("not_found");
  });
});

describe("a registry that fails", () => {
  it("platform-42 · a failed registry query is 503 with a fixed sentence, and its message is logged only", async () => {
    const lines: string[] = [];
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("deps", { ...realDeps(), log: createLogger((line) => lines.push(line)) });
      await next();
    });
    mountProjects(app);

    const response = await app.request(
      "/api/projects",
      { headers: dashboardHeaders(await dashboardSession()) },
      { ...env, REGISTRY: env.UNMIGRATED_REGISTRY },
    );
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      code: "unavailable",
      message: "The registry is unavailable.",
    });
    expect(body).not.toMatch(/no such table/i);
    expect(lines.join("\n")).toMatch(/no such table/i);
  });
});
