import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { fetchApp } from "../../../test/helpers/capture.ts";
import { dashboardHeaders, dashboardSession } from "../../../test/helpers/session.ts";
import { realDeps } from "../../platform/deps.ts";
import type { AppEnv } from "../../platform/http.ts";
import { mountEmails } from "./http.ts";

// Cloudflare's Email Routing API as its docs describe it (email-routing.ts):
// paged lists with a `verified` time or null, and a POST that adds an
// unconfirmed address. A stand-in for the outside service, taken from
// Cloudflare's API reference and checked against the real API after deploy.
function fakeCloudflare(start: { email: string; verified: boolean }[]) {
  const all = [...start];
  const calls: string[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (init?.method === "POST") {
      const sent: unknown = typeof init.body === "string" ? JSON.parse(init.body) : null;
      const email =
        typeof sent === "object" && sent !== null && "email" in sent ? String(sent.email) : "";
      all.push({ email, verified: false });
      return Response.json({ success: true, result: { email, verified: null }, errors: [] });
    }
    const page = Number(url.searchParams.get("page"));
    const per = Number(url.searchParams.get("per_page"));
    const rows = all
      .slice((page - 1) * per, page * per)
      .map((d) => ({ email: d.email, verified: d.verified ? "2026-11-01T00:00:00Z" : null }));
    return Response.json({ success: true, result: rows, errors: [] });
  };
  return { fetch, calls, all };
}

const bindings = {
  ...env,
  ALERT_ADDRESSES: '["owner@example.com"]',
  CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
  CLOUDFLARE_EMAIL_TOKEN: "test-token",
};

function appWith(fetch: (input: string, init?: RequestInit) => Promise<Response>) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("deps", { ...realDeps(), fetch });
    await next();
  });
  mountEmails(app);
  return app;
}

const url = "https://dashboard.test/api/emails/addresses";

async function ask(app: Hono<AppEnv>, method: string, path = url, body?: unknown) {
  const session = await dashboardSession();
  const init: RequestInit = {
    method,
    headers: { ...dashboardHeaders(session), "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetchApp(app, new Request(path, init), bindings);
}

describe("the weekly email's addresses", () => {
  it("alerts-10 · lists the setup's addresses and the added ones, confirmed or waiting as Cloudflare says", async () => {
    const cloudflare = fakeCloudflare([
      { email: "owner@example.com", verified: true },
      { email: "partner@example.com", verified: false },
    ]);
    const app = appWith(cloudflare.fetch);
    expect((await ask(app, "POST", url, { address: "Partner@Example.com" })).status).toBe(201);
    const response = await ask(app, "GET");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      addresses: [
        { address: "owner@example.com", confirmed: true, fromSetup: true },
        { address: "partner@example.com", confirmed: false, fromSetup: false },
      ],
      canAdd: true,
    });
  });

  it("alerts-10 · without the Cloudflare token, the setup's addresses are listed and none can be added", async () => {
    const app = appWith(fakeCloudflare([]).fetch);
    const session = await dashboardSession();
    const { CLOUDFLARE_EMAIL_TOKEN: _token, ...noToken } = bindings;
    const list = await fetchApp(
      app,
      new Request(url, { headers: dashboardHeaders(session) }),
      noToken,
    );
    expect(await list.json()).toEqual({
      addresses: [{ address: "owner@example.com", confirmed: true, fromSetup: true }],
      canAdd: false,
    });
    const add = await fetchApp(
      app,
      new Request(url, {
        method: "POST",
        headers: { ...dashboardHeaders(session), "content-type": "application/json" },
        body: JSON.stringify({ address: "new@example.com" }),
      }),
      noToken,
    );
    expect(add.status).toBe(503);
  });

  it("alerts-11 · a new address is asked of Cloudflare once; one it already has is not asked again", async () => {
    const cloudflare = fakeCloudflare([{ email: "known@example.com", verified: true }]);
    const app = appWith(cloudflare.fetch);
    expect((await ask(app, "POST", url, { address: "new@example.com" })).status).toBe(201);
    expect((await ask(app, "POST", url, { address: "known@example.com" })).status).toBe(201);
    expect(cloudflare.calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
    expect(cloudflare.all.map((d) => d.email)).toEqual(["known@example.com", "new@example.com"]);
    expect((await ask(app, "POST", url, { address: "not an address" })).status).toBe(400);
  });

  it("alerts-12 · an added address leaves the list, and a setup address cannot", async () => {
    const cloudflare = fakeCloudflare([]);
    const app = appWith(cloudflare.fetch);
    await ask(app, "POST", url, { address: "gone@example.com" });
    expect((await ask(app, "DELETE", `${url}/gone%40example.com`)).status).toBe(204);
    expect((await ask(app, "DELETE", `${url}/gone%40example.com`)).status).toBe(404);
    expect((await ask(app, "DELETE", `${url}/owner%40example.com`)).status).toBe(409);
    // Cloudflare's own record stays, for other tools that send to it.
    expect(cloudflare.calls.some((call) => call.startsWith("DELETE"))).toBe(false);
  });

  it("alerts-10 · refused without a session, and 503 when Cloudflare does not answer", async () => {
    const app = appWith(async () => {
      throw new Error("offline");
    });
    const anonymous = await fetchApp(app, new Request(url), bindings);
    expect(anonymous.status).toBe(401);
    expect((await ask(app, "GET")).status).toBe(503);
  });

  it("alerts-10 · an account past the list's last page answers 503, never a cut-off list", async () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({
      email: `person${String(i)}@example.com`,
      verified: true,
    }));
    expect((await ask(appWith(fakeCloudflare(many).fetch), "GET")).status).toBe(503);
  });
});
