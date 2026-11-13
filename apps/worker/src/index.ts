import { Hono } from "hono";
import { mountConfig } from "./features/config/index.ts";
import { mountHeatmaps } from "./features/heatmaps/index.ts";
import { mountCapture } from "./features/intake/index.ts";
import { mountPrivacy } from "./features/privacy/index.ts";
import { mountProjects } from "./features/projects/index.ts";
import { mountQuery } from "./features/query/index.ts";
import { mountRecordings } from "./features/recordings/index.ts";
import { mountDashboard } from "./platform/dashboard.ts";
import { realDeps } from "./platform/deps.ts";
import { mountHealth } from "./platform/health.ts";
import { type AppEnv, apiError } from "./platform/http.ts";
import { storeJurisdiction } from "./platform/project-store-id.ts";
import { requireAdmin } from "./platform/session.ts";
import { mountSignIn } from "./platform/sign-in.ts";

export { ProjectStore } from "./platform/project-store.ts";

// The composition root. Each request gets its own dependencies (clock, random
// source, logger), built here and nowhere else, and each slice mounts its
// routes. The SDK paths come first: capture, /s/, remote config, /flags and
// the pinned scripts; then the dashboard's routes and the external query
// path. See docs/architecture.md.
const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  c.set("deps", realDeps());
  await next();
});

// A region that is no region means a broken deploy. Every request is refused,
// /healthz included, before anything could address a store (platform-53).
app.use("*", async (c, next) => {
  const region = storeJurisdiction(c.env.STORE_JURISDICTION);
  if (!region.ok) {
    c.get("deps").log.error("store_jurisdiction_invalid", { message: region.error });
    return c.req.path === "/healthz"
      ? c.json({ ok: false }, 503, { "cache-control": "no-store" })
      : apiError(503, "unavailable", "This deployment is misconfigured.");
  }
  await next();
  return undefined;
});

mountHealth(app);
mountSignIn(app);
mountCapture(app);
mountRecordings(app);
mountConfig(app);
mountProjects(app);
mountHeatmaps(app);
mountQuery(app);
mountPrivacy(app);
mountDashboard(app);

// Any other dashboard path checks the session first, so a path or project id
// that does not exist is 401 without a valid session, never 404 (platform-01).
app.all("/api/projects/*", requireAdmin(), () => apiError(404, "not_found", "No such path."));

export default app;
