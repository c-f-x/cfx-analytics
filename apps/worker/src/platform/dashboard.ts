import type { Hono } from "hono";
import type { AppContext, AppEnv } from "./http.ts";

// The dashboard's page (D-24, platform-50). The web app builds into the
// Worker's assets under /app/ (apps/web/vite.config.ts), and the Worker serves
// it from the ASSETS binding. The page holds no data and asks the API for
// everything, so it needs no session; the API checks the session on every call.

/** The asset a path is served from: the page for the dashboard's own paths, a built file under /app/, else null. */
export function dashboardAsset(pathname: string): string | null {
  if (pathname === "/" || pathname === "/projects" || pathname === "/app/")
    return "/app/index.html";
  if (pathname.startsWith("/p/")) return "/app/index.html";
  if (pathname.startsWith("/app/")) return pathname;
  return null;
}

/** What every dashboard answer carries: it may not be framed (clickjacking), sniffed, or leak its paths. */
const PAGE_HEADERS = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
} as const;

async function serveDashboard(c: AppContext): Promise<Response> {
  const asset = dashboardAsset(new URL(c.req.url).pathname);
  if (asset === null) return c.notFound();
  const found = await c.env.ASSETS.fetch(new URL(asset, c.req.url));
  const response = new Response(found.body, found);
  for (const [name, value] of Object.entries(PAGE_HEADERS)) response.headers.set(name, value);
  // The page names its built files by content hash, so it must never be cached itself.
  if (asset === "/app/index.html" && found.ok) response.headers.set("cache-control", "no-cache");
  return response;
}

export function mountDashboard(app: Hono<AppEnv>): void {
  app.get("/", serveDashboard);
  app.get("/projects", serveDashboard);
  app.get("/p/*", serveDashboard);
  app.get("/app/*", serveDashboard);
}
