import { env } from "cloudflare:test";
import { isJsonObject, QUERY, QUERY_KINDS, type QueryKind } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import {
  answerJson,
  appAt,
  DAY_MS,
  fetchApp,
  INTAKE,
  iso,
  preflightRequest,
  T0,
  wasContacted,
} from "../../../test/helpers/capture.ts";
import { newSecretKey, newToken, seedProject, sha256Hex } from "../../../test/helpers/registry.ts";
import { seedEvents } from "../../../test/helpers/seed.ts";
import {
  dashboardHeaders,
  dashboardSession,
  sessionCookie,
} from "../../../test/helpers/session.ts";
import { REGISTRY_UNAVAILABLE } from "../../platform/http.ts";
import { mountQuery } from "./http.ts";

const BASE = "https://dashboard.test";
const LAST_DAY = { kind: "last_days", days: 1 };

function trend(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "trend", range: LAST_DAY, measure: "events", granularity: "day", ...extra };
}

async function dashboard(): Promise<{ app: ReturnType<typeof appAt>; session: string }> {
  return { app: appAt(() => T0, mountQuery), session: await dashboardSession(T0) };
}

async function ask(
  app: ReturnType<typeof appAt>,
  session: string,
  projectId: string,
  body: unknown,
): Promise<Response> {
  return fetchApp(
    app,
    new Request(`${BASE}/api/projects/${projectId}/query`, {
      method: "POST",
      headers: { ...dashboardHeaders(session), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function external(
  app: ReturnType<typeof appAt>,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  return fetchApp(
    app,
    new Request(`${INTAKE}/api/external/query`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

/** Writes a secret key for the project, as the dashboard's key page would, and answers it. */
async function seedKey(projectId: string): Promise<string> {
  const key = newSecretKey();
  await env.REGISTRY.prepare(
    "INSERT INTO secret_keys (hash, project_id, label, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(await sha256Hex(key), projectId, "test", T0)
    .run();
  return key;
}

async function errorOf(response: Response): Promise<Record<string, unknown>> {
  const body = await answerJson(response);
  if (!isJsonObject(body)) throw new Error(`expected an error answer, got ${JSON.stringify(body)}`);
  return body;
}

async function answerOf(
  response: Response,
): Promise<{ meta: Record<string, unknown>; result: Record<string, unknown> }> {
  const body = await answerJson(response);
  if (!isJsonObject(body) || !isJsonObject(body.meta) || !isJsonObject(body.result)) {
    throw new Error(`expected an answer, got ${JSON.stringify(body)}`);
  }
  return { meta: body.meta, result: body.result };
}

function seriesOf(result: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(result.series)) {
    throw new Error(`expected series, got ${JSON.stringify(result.series)}`);
  }
  return result.series.map((entry) => {
    if (!isJsonObject(entry)) throw new Error("expected a series object");
    return entry;
  });
}

function valuesOf(result: Record<string, unknown>): number[] {
  const series = seriesOf(result);
  const [only] = series;
  if (only === undefined || series.length !== 1) {
    throw new Error(`expected one series, got ${series.length}`);
  }
  const values = only.values;
  if (!Array.isArray(values) || !values.every((value) => typeof value === "number")) {
    throw new Error(`expected numeric values, got ${JSON.stringify(values)}`);
  }
  return values;
}

function totalOf(result: Record<string, unknown>): number {
  return seriesOf(result).reduce((sum, entry) => {
    if (typeof entry.total !== "number") throw new Error("expected a series total");
    return sum + entry.total;
  }, 0);
}

function specOf(kind: QueryKind): Record<string, unknown> {
  const range = { kind: "between", from: iso(T0 - DAY_MS), to: iso(T0) };
  if (kind === "trend") return { kind, range, measure: "events", granularity: "day" };
  if (kind === "top") return { kind, range, dimension: { builtin: "page" }, measure: "events" };
  if (kind === "funnel") {
    return {
      kind,
      range,
      windowMs: 60_000,
      steps: [
        { id: "a", event: "one" },
        { id: "b", event: "two" },
      ],
    };
  }
  if (kind === "retention") return { kind, range, granularity: "day" };
  if (kind === "scroll_depth") return { kind, range, path: "/pricing" };
  return { kind, range };
}

it("query-01 · a project's key on the external path counts only that project's events", async () => {
  const a = await seedProject();
  const b = await seedProject();
  await seedEvents(a.id, [{ ts: T0 - 1000 }, { ts: T0 - 2000 }]);
  await seedEvents(b.id, [{ ts: T0 - 3000 }]);
  const key = await seedKey(b.id);

  const { app } = await dashboard();
  const response = await external(app, { authorization: `Bearer ${key}` }, trend());
  expect(response.status).toBe(200);
  const { meta, result } = await answerOf(response);
  expect(meta.excluded).toEqual({ bots: true, internalRules: [], notApplicable: [] });
  expect(totalOf(result)).toBe(1);
});

it("query-01 · a spec naming a project is 400 on the external path", async () => {
  const project = await seedProject();
  const key = await seedKey(project.id);
  const { app } = await dashboard();
  const response = await external(
    app,
    { authorization: `Bearer ${key}` },
    { ...trend(), project: project.id },
  );
  expect(response.status).toBe(400);
  expect((await errorOf(response)).code).toBe("validation_failed");
});

it("query-01 · a project's key as a Bearer token on either dashboard path is 401", async () => {
  const a = await seedProject();
  const b = await seedProject();
  const key = await seedKey(b.id);
  const { app, session } = await dashboard();
  for (const projectId of [a.id, b.id]) {
    const response = await fetchApp(
      app,
      new Request(`${BASE}/api/projects/${projectId}/query`, {
        method: "POST",
        headers: {
          ...dashboardHeaders(session),
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(trend()),
      }),
    );
    expect(response.status).toBe(401);
  }
});

it("query-06 · the hand-built client's last day is one value per day, counted as seeded", async () => {
  const project = await seedProject();
  const key = await seedKey(project.id);
  await seedEvents(project.id, [
    { ts: T0 - 1000 },
    { ts: T0 - 2000 },
    { ts: T0 - DAY_MS },
    { ts: T0 - 89 * DAY_MS },
    { ts: T0 - 90 * DAY_MS },
  ]);
  const { app } = await dashboard();
  const response = await external(
    app,
    { authorization: `Bearer ${key}` },
    trend({ event: "$pageview" }),
  );
  expect(response.status).toBe(200);
  const { meta, result } = await answerOf(response);
  expect(meta.range).toEqual({ from: iso(Date.parse("2026-10-21T00:00:00+02:00")), to: iso(T0) });
  expect(valuesOf(result)).toEqual([2]);
});

it("query-06 · the hand-built client's last 90 days holds 90 buckets and counts the seeded days", async () => {
  const project = await seedProject();
  const key = await seedKey(project.id);
  await seedEvents(project.id, [
    { ts: T0 - 1000 },
    { ts: T0 - 2000 },
    { ts: T0 - DAY_MS },
    { ts: T0 - 89 * DAY_MS },
    { ts: T0 - 90 * DAY_MS },
  ]);
  const { app } = await dashboard();
  const response = await external(
    app,
    { authorization: `Bearer ${key}` },
    trend({ range: { kind: "last_days", days: 90 }, event: "$pageview" }),
  );
  expect(response.status).toBe(200);
  const { result } = await answerOf(response);
  if (!Array.isArray(result.buckets)) throw new Error("expected buckets");
  expect(result.buckets).toHaveLength(90);
  const values = valuesOf(result);
  expect(values).toHaveLength(90);
  expect(values.reduce((sum, value) => sum + value, 0)).toBe(4);
  expect(values.slice(0, 1)).toEqual([1]);
  expect(values.slice(-1)).toEqual([2]);
});

it("query-07 · bots are left out of an answer unless includeBots is asked for", async () => {
  const project = await seedProject();
  await seedEvents(project.id, [
    { ts: T0 - 1000, bot: false },
    { ts: T0 - 2000, bot: true },
  ]);
  const { app, session } = await dashboard();

  const quiet = await ask(app, session, project.id, trend());
  expect(quiet.status).toBe(200);
  const quietAnswer = await answerOf(quiet);
  expect(quietAnswer.meta.excluded).toEqual({ bots: true, internalRules: [], notApplicable: [] });
  expect(totalOf(quietAnswer.result)).toBe(1);

  const loud = await ask(app, session, project.id, trend({ includeBots: true }));
  expect(loud.status).toBe(200);
  const loudAnswer = await answerOf(loud);
  expect(loudAnswer.meta.excluded).toEqual({ bots: false, internalRules: [], notApplicable: [] });
  expect(totalOf(loudAnswer.result)).toBe(2);
});

it("query-08 · the project's internal rules leave their matches out and are named in the meta", async () => {
  const project = await seedProject({
    settings: { internal_rules: [{ kind: "event_property", property: "internal", value: true }] },
  });
  await seedEvents(project.id, [
    { ts: T0 - 2000, properties: { internal: true } },
    { ts: T0 - 1000, properties: {} },
  ]);
  const { app, session } = await dashboard();

  const quiet = await ask(app, session, project.id, trend());
  expect(quiet.status).toBe(200);
  const quietAnswer = await answerOf(quiet);
  expect(quietAnswer.meta.excluded).toEqual({ bots: true, internalRules: [0], notApplicable: [] });
  expect(totalOf(quietAnswer.result)).toBe(1);

  const included = await ask(app, session, project.id, trend({ includeInternal: true }));
  expect(included.status).toBe(200);
  const includedAnswer = await answerOf(included);
  expect(includedAnswer.meta.excluded).toEqual({
    bots: true,
    internalRules: [],
    notApplicable: [],
  });
  expect(totalOf(includedAnswer.result)).toBe(2);
});

it("query-60 · with no filter the route counts every event but bots and internal traffic", async () => {
  const project = await seedProject({
    settings: { internal_rules: [{ kind: "event_property", property: "internal", value: true }] },
  });
  await seedEvents(project.id, [
    { ts: T0 - 3000, properties: {} },
    { ts: T0 - 2000, bot: true },
    { ts: T0 - 1000, properties: { internal: true } },
  ]);
  const { app, session } = await dashboard();
  const response = await ask(app, session, project.id, trend());
  expect(response.status).toBe(200);
  const { meta, result } = await answerOf(response);
  expect(meta.excluded).toEqual({ bots: true, internalRules: [0], notApplicable: [] });
  expect(totalOf(result)).toBe(1);
});

it("query-11 · a range whose start is not before its end, or is before 1970, is 400 and contacts no store", async () => {
  const project = await seedProject();
  const { app, session } = await dashboard();
  const ranges = [
    { kind: "between", from: iso(T0), to: iso(T0) },
    { kind: "between", from: iso(T0), to: iso(T0 - DAY_MS) },
    { kind: "between", from: "1969-12-31T00:00:00Z", to: iso(T0) },
  ];
  for (const range of ranges) {
    const response = await ask(app, session, project.id, trend({ range }));
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("validation_failed");
  }
  expect(await wasContacted(project.id)).toBe(false);
});

it("query-14 · no timeZone uses the project's, a named one wins, and an unknown one is 400 at /timeZone", async () => {
  const project = await seedProject({ settings: { timezone: "America/New_York" } });
  const { app, session } = await dashboard();

  // The unknown zone first, while the store has never been contacted.
  const unknown = await ask(app, session, project.id, trend({ timeZone: "Mars/Olympus" }));
  expect(unknown.status).toBe(400);
  const body = await errorOf(unknown);
  expect(body.code).toBe("validation_failed");
  if (!Array.isArray(body.issues)) throw new Error("expected issues");
  const [first] = body.issues;
  if (!isJsonObject(first)) throw new Error("expected an issue");
  expect(first.path).toBe("/timeZone");
  expect(await wasContacted(project.id)).toBe(false);

  const followed = await ask(app, session, project.id, trend());
  expect(followed.status).toBe(200);
  expect((await answerOf(followed)).meta.timeZone).toBe("America/New_York");

  const named = await ask(app, session, project.id, trend({ timeZone: "Asia/Tokyo" }));
  expect(named.status).toBe(200);
  expect((await answerOf(named)).meta.timeZone).toBe("Asia/Tokyo");
});

it("query-17 · a project with no events answers every kind 200 with the full meta", async () => {
  const project = await seedProject();
  const { app, session } = await dashboard();
  for (const kind of QUERY_KINDS) {
    const response = await ask(app, session, project.id, specOf(kind));
    expect(response.status).toBe(200);
    const { meta, result } = await answerOf(response);
    expect(meta.range).toEqual({ from: iso(T0 - DAY_MS), to: iso(T0) });
    expect(meta.timeZone).toBe("Europe/Oslo");
    expect(meta.excluded).toEqual({ bots: true, internalRules: [], notApplicable: [] });
    if (kind === "trend") {
      if (!Array.isArray(result.buckets)) throw new Error("expected buckets");
      expect(result.buckets).toHaveLength(2);
    }
    if (kind === "top" || kind === "events") expect(result.rows).toEqual([]);
    if (kind === "properties") expect(result.properties).toEqual([]);
    // Each bucket with a later one is a cohort, empty here, so the table keeps its shape (query-62).
    if (kind === "retention") {
      if (!Array.isArray(result.cohorts)) throw new Error("expected cohorts");
      expect(result.cohorts.length).toBeGreaterThan(0);
      expect(result.cohorts.map((cohort) => (isJsonObject(cohort) ? cohort.size : null))).toEqual(
        result.cohorts.map(() => 0),
      );
    }
    if (kind === "scroll_depth") expect(result.views).toBe(0);
    if (kind === "funnel") {
      if (!Array.isArray(result.steps)) throw new Error("expected steps");
      expect(result.steps.map((step) => (isJsonObject(step) ? step.count : null))).toEqual([0, 0]);
    }
  }
});

it("query-18 · an unknown key, a wrong type or a missing field is 400 with the first bad path", async () => {
  const project = await seedProject();
  const { app, session } = await dashboard();
  const bodies = [
    { ...trend(), project: project.id },
    trend({ measure: 7 }),
    { kind: "trend", range: LAST_DAY, granularity: "day" },
  ];
  for (const body of bodies) {
    const response = await ask(app, session, project.id, body);
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe("validation_failed");
    if (!Array.isArray(error.issues)) throw new Error("expected issues");
    expect(error.issues.length).toBeGreaterThan(0);
    const [first] = error.issues;
    if (!isJsonObject(first)) throw new Error("expected an issue");
    expect(typeof first.path).toBe("string");
  }
  expect(await wasContacted(project.id)).toBe(false);
});

it("query-19 · a GET on the query path is 405 and the store is untouched", async () => {
  const project = await seedProject();
  const { app, session } = await dashboard();
  const response = await fetchApp(
    app,
    new Request(`${BASE}/api/projects/${project.id}/query`, {
      method: "GET",
      headers: dashboardHeaders(session),
    }),
  );
  expect(response.status).toBe(405);
  expect((await errorOf(response)).code).toBe("method_not_allowed");
  expect(await wasContacted(project.id)).toBe(false);
});

it("query-19 · a body that is not JSON is 400 and the store is untouched", async () => {
  const project = await seedProject();
  const { app, session } = await dashboard();
  const response = await fetchApp(
    app,
    new Request(`${BASE}/api/projects/${project.id}/query`, {
      method: "POST",
      headers: { ...dashboardHeaders(session), "content-type": "application/json" },
      body: '{"kind": "trend",',
    }),
  );
  expect(response.status).toBe(400);
  expect((await errorOf(response)).code).toBe("validation_failed");
  expect(await wasContacted(project.id)).toBe(false);
});

it("query-19 · an empty body is 400 and the store is untouched", async () => {
  const project = await seedProject();
  const { app, session } = await dashboard();
  const response = await fetchApp(
    app,
    new Request(`${BASE}/api/projects/${project.id}/query`, {
      method: "POST",
      headers: { ...dashboardHeaders(session), "content-type": "application/json" },
      body: "",
    }),
  );
  expect(response.status).toBe(400);
  expect((await errorOf(response)).code).toBe("validation_failed");
  expect(await wasContacted(project.id)).toBe(false);
});

it("query-19 · a text/plain body is 415 and the store is untouched", async () => {
  const project = await seedProject();
  const { app, session } = await dashboard();
  const response = await fetchApp(
    app,
    new Request(`${BASE}/api/projects/${project.id}/query`, {
      method: "POST",
      headers: { ...dashboardHeaders(session), "content-type": "text/plain" },
      body: JSON.stringify(trend()),
    }),
  );
  expect(response.status).toBe(415);
  expect((await errorOf(response)).code).toBe("unsupported_media_type");
  expect(await wasContacted(project.id)).toBe(false);
});

it("query-25 · a funnel of one step or without a window is 400 before the store is contacted", async () => {
  const project = await seedProject();
  const { app, session } = await dashboard();
  const oneStep = {
    kind: "funnel",
    range: LAST_DAY,
    windowMs: 60_000,
    steps: [{ id: "a", event: "one" }],
  };
  const noWindow = {
    kind: "funnel",
    range: LAST_DAY,
    steps: [
      { id: "a", event: "one" },
      { id: "b", event: "two" },
    ],
  };
  for (const body of [oneStep, noWindow]) {
    const response = await ask(app, session, project.id, body);
    expect(response.status).toBe(400);
    expect((await errorOf(response)).code).toBe("validation_failed");
  }
  expect(await wasContacted(project.id)).toBe(false);
});

it("query-36 · a bare date is 400, and an offset time is answered as its UTC instant", async () => {
  const project = await seedProject();
  await seedEvents(project.id, [{ ts: Date.parse("2026-10-14T09:00:00Z") }]);
  const { app, session } = await dashboard();

  const bare = await ask(
    app,
    session,
    project.id,
    trend({ range: { kind: "between", from: "2026-10-14", to: "2026-10-20" } }),
  );
  expect(bare.status).toBe(400);
  expect((await errorOf(bare)).code).toBe("validation_failed");

  const offset = await ask(
    app,
    session,
    project.id,
    trend({
      range: { kind: "between", from: "2026-10-14T10:00:00+02:00", to: "2026-10-20T00:00:00Z" },
    }),
  );
  expect(offset.status).toBe(200);
  expect((await answerOf(offset)).meta.range).toEqual({
    from: "2026-10-14T08:00:00.000Z",
    to: "2026-10-20T00:00:00.000Z",
  });
});

it("query-40 · a range reaching before retention is clipped, and requested holds the ask", async () => {
  const project = await seedProject();
  const asked = { from: T0 - 400 * DAY_MS, to: T0 - DAY_MS };
  const { app, session } = await dashboard();
  const response = await ask(
    app,
    session,
    project.id,
    trend({
      range: { kind: "between", from: iso(asked.from), to: iso(asked.to) },
      granularity: "month",
    }),
  );
  expect(response.status).toBe(200);
  const { meta } = await answerOf(response);
  expect(meta.range).toEqual({ from: iso(T0 - 395 * DAY_MS), to: iso(asked.to) });
  expect(meta.requested).toEqual({ from: iso(asked.from), to: iso(asked.to) });
});

it("query-49 · a cursor that is not a cursor is 400 invalid_cursor before any read", async () => {
  const project = await seedProject();
  const { app, session } = await dashboard();
  const response = await ask(app, session, project.id, {
    kind: "top",
    range: LAST_DAY,
    dimension: { builtin: "page" },
    measure: "events",
    cursor: "not a cursor",
  });
  expect(response.status).toBe(400);
  expect((await errorOf(response)).code).toBe("invalid_cursor");
  expect(await wasContacted(project.id)).toBe(false);
});

it("query-59 · a body over 100 KB is 413 before parsing or a read", async () => {
  const project = await seedProject();
  const { app, session } = await dashboard();
  const response = await ask(app, session, project.id, {
    ...trend(),
    pad: "x".repeat(QUERY.bodyBytes),
  });
  expect(response.status).toBe(413);
  expect((await errorOf(response)).code).toBe("body_too_large");
  expect(await wasContacted(project.id)).toBe(false);
});

it("query-61 · a body over bodyBytes with a Content-Length is 413", async () => {
  const project = await seedProject();
  const { app, session } = await dashboard();
  const bytes = new TextEncoder().encode(
    JSON.stringify({ ...trend(), pad: "x".repeat(QUERY.bodyBytes) }),
  );
  const response = await fetchApp(
    app,
    new Request(`${BASE}/api/projects/${project.id}/query`, {
      method: "POST",
      headers: {
        ...dashboardHeaders(session),
        "content-type": "application/json",
        "content-length": String(bytes.byteLength),
      },
      body: bytes,
    }),
  );
  expect(response.status).toBe(413);
  expect((await errorOf(response)).code).toBe("body_too_large");
  expect(await wasContacted(project.id)).toBe(false);
});

it("query-61 · the same size as a stream with no Content-Length is 413", async () => {
  const project = await seedProject();
  const { app, session } = await dashboard();
  const encoder = new TextEncoder();
  const chunk = encoder.encode(JSON.stringify({ ...trend(), pad: "x".repeat(QUERY.bodyBytes) }));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
  const request = new Request(`${BASE}/api/projects/${project.id}/query`, {
    method: "POST",
    headers: { ...dashboardHeaders(session), "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit);
  const response = await fetchApp(app, request);
  expect(response.status).toBe(413);
  expect((await errorOf(response)).code).toBe("body_too_large");
  expect(await wasContacted(project.id)).toBe(false);
});

it("query-73 · a dashboard answer is Cache-Control: private, no-store", async () => {
  const project = await seedProject();
  await seedEvents(project.id, [{ ts: T0 - 1000 }]);
  const { app, session } = await dashboard();
  const response = await ask(app, session, project.id, trend());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});

it("query-73 · an external answer is Cache-Control: private, no-store", async () => {
  const project = await seedProject();
  const key = await seedKey(project.id);
  await seedEvents(project.id, [{ ts: T0 - 1000 }]);
  const { app } = await dashboard();
  const response = await external(app, { authorization: `Bearer ${key}` }, trend());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});

it("query-126 · the dashboard and the external path answer one spec with equal bodies", async () => {
  const project = await seedProject();
  const key = await seedKey(project.id);
  await seedEvents(project.id, [
    { ts: T0 - 3000, event: "one", distinctId: "user-126" },
    { ts: T0 - 2000, event: "two", distinctId: "user-126" },
    { ts: T0 - 1000, distinctId: "user-126" },
  ]);
  const { app, session } = await dashboard();
  for (const kind of QUERY_KINDS) {
    const spec = specOf(kind);
    const fromDashboard = await ask(app, session, project.id, spec);
    const fromExternal = await external(app, { authorization: `Bearer ${key}` }, spec);
    expect(fromDashboard.status).toBe(200);
    expect(fromExternal.status).toBe(200);
    expect(await answerJson(fromExternal)).toEqual(await answerJson(fromDashboard));
  }
});

it("platform-07 · a secret key as a Bearer token on the dashboard path is 401", async () => {
  const project = await seedProject();
  const key = await seedKey(project.id);
  const { app, session } = await dashboard();
  // The key beside a valid session: the key alone decides, and it is refused.
  const response = await fetchApp(
    app,
    new Request(`${BASE}/api/projects/${project.id}/query`, {
      method: "POST",
      headers: {
        ...dashboardHeaders(session),
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(trend()),
    }),
  );
  expect(response.status).toBe(401);
  expect(await wasContacted(project.id)).toBe(false);
});

it("platform-09 · a session, a public token, Basic auth and a revoked key are one 401 body", async () => {
  const project = await seedProject();
  const revoked = await seedKey(project.id);
  await env.REGISTRY.prepare("DELETE FROM secret_keys WHERE hash = ?")
    .bind(await sha256Hex(revoked))
    .run();
  const session = await dashboardSession(T0);
  const { app } = await dashboard();
  const headers = [
    { cookie: sessionCookie(session) },
    { authorization: `Bearer ${newToken()}` },
    { authorization: "Basic dXNlcjpwYXNz" },
    { authorization: `Bearer ${revoked}` },
  ];
  const bodies: string[] = [];
  for (const sent of headers) {
    const response = await external(app, sent, trend());
    expect(response.status).toBe(401);
    bodies.push(await response.text());
  }
  expect(new Set(bodies).size).toBe(1);
});

it("platform-11 · a preflight on either query path carries no allow-origin header", async () => {
  const project = await seedProject();
  const { app } = await dashboard();
  for (const path of [`/api/projects/${project.id}/query`, "/api/external/query"]) {
    const response = await fetchApp(app, preflightRequest(path, "https://evil.example"));
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  }
});

it("platform-34 · an unknown kind is 400 unknown_kind, naming the kinds, before any read", async () => {
  const project = await seedProject();
  const { app, session } = await dashboard();
  const response = await ask(app, session, project.id, { ...trend(), kind: "cohorts" });
  expect(response.status).toBe(400);
  const error = await errorOf(response);
  expect(error.code).toBe("unknown_kind");
  if (typeof error.message !== "string") throw new Error("expected a message");
  for (const kind of QUERY_KINDS) expect(error.message).toContain(kind);
  expect(await wasContacted(project.id)).toBe(false);
});

it("platform-34 · a 4xx body is JSON, with one sentence naming the bad input", async () => {
  const project = await seedProject();
  const { app, session } = await dashboard();
  const response = await ask(app, session, project.id, trend({ measure: 7 }));
  expect(response.status).toBe(400);
  expect(response.headers.get("content-type")).toContain("application/json");
  const error = await errorOf(response);
  if (typeof error.message !== "string") throw new Error("expected a message");
  expect(error.message.endsWith(".")).toBe(true);
  expect(error.message).toContain("/measure");
});

it("platform-42 · a failing registry is 503 unavailable with one fixed sentence", async () => {
  const project = await seedProject();
  const { app, session } = await dashboard();
  const response = await fetchApp(
    app,
    new Request(`${BASE}/api/projects/${project.id}/query`, {
      method: "POST",
      headers: { ...dashboardHeaders(session), "content-type": "application/json" },
      body: JSON.stringify(trend()),
    }),
    { ...env, REGISTRY: env.UNMIGRATED_REGISTRY },
  );
  expect(response.status).toBe(503);
  const error = await errorOf(response);
  expect(error.code).toBe("unavailable");
  expect(error.message).toBe(REGISTRY_UNAVAILABLE);
});
