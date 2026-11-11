import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import { dashboardAsset } from "./dashboard.ts";

// Serving the dashboard's built page (platform-50): which asset a path maps
// to is a pure rule, so it is tested without a build.

it("platform-50 · the dashboard's paths map to its page, and /app/ paths to their files", () => {
  expect(dashboardAsset("/")).toBe("/app/index.html");
  expect(dashboardAsset("/projects")).toBe("/app/index.html");
  expect(dashboardAsset("/p/0190f3b0/board")).toBe("/app/index.html");
  expect(dashboardAsset("/p/0190f3b0/recordings/abc")).toBe("/app/index.html");
  expect(dashboardAsset("/app/assets/index-1a2b.js")).toBe("/app/assets/index-1a2b.js");
  expect(dashboardAsset("/app/")).toBe("/app/index.html");
});

it("platform-50 · every other path is left to the routes", () => {
  for (const path of [
    "/api/projects",
    "/static/x.js",
    "/auth/status",
    "/healthz",
    "/s/",
    "/batch/",
    "/px",
    "/projectsx",
  ]) {
    expect(dashboardAsset(path)).toBeNull();
  }
});

it("platform-50 · a built file that does not exist is 404, and the API still needs a session", async () => {
  const missing = await SELF.fetch("https://dashboard.test/app/assets/does-not-exist.js");
  expect(missing.status).toBe(404);
  const api = await SELF.fetch("https://dashboard.test/api/projects");
  expect(api.status).toBe(401);
});

it("platform-50 · the dashboard's answers cannot be framed or sniffed, built or not", async () => {
  for (const path of ["/", "/p/abc/settings", "/app/assets/does-not-exist.js"]) {
    const response = await SELF.fetch(`https://dashboard.test${path}`);
    expect({
      path,
      frame: response.headers.get("x-frame-options"),
      csp: response.headers.get("content-security-policy"),
      sniff: response.headers.get("x-content-type-options"),
      referrer: response.headers.get("referrer-policy"),
    }).toEqual({
      path,
      frame: "DENY",
      csp: "frame-ancestors 'none'",
      sniff: "nosniff",
      referrer: "same-origin",
    });
  }
});
