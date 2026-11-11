import type { Hono } from "hono";
import { type AppContext, type AppEnv, apiError } from "./http.ts";

// GET /healthz for monitoring. It reveals nothing (architecture.md, "Who may call what").

/** The key the bucket check looks up. It is never written, so the lookup reads no visitor's data. */
const PROBE_KEY = "healthz/probe";

/** 200 {"ok":true} when the registry and the bucket answered, else 503 {"ok":false} (platform-12, platform-13). */
export function healthAnswer(answered: boolean): {
  status: 200 | 503;
  body: { ok: boolean };
} {
  return answered ? { status: 200, body: { ok: true } } : { status: 503, body: { ok: false } };
}

/**
 * Mounts /healthz: GET runs `SELECT 1` on the registry and looks up PROBE_KEY
 * in the recordings bucket (never a ProjectStore), and answers healthAnswer's
 * status and body; any other method is 405.
 * Every answer carries Cache-Control: no-store (platform-14).
 */
export function mountHealth(app: Hono<AppEnv>): void {
  app.all("/healthz", handleHealth);
}

/** GET runs the registry check; any other method is 405. */
export async function handleHealth(c: AppContext): Promise<Response> {
  if (c.req.method !== "GET") {
    return apiError(405, "method_not_allowed", "Only GET is allowed on this path.");
  }
  let answered: boolean;
  try {
    // A failed answer says nothing about why, to the caller or the log line.
    const registry = (await c.env.REGISTRY.prepare("SELECT 1").first()) !== null;
    // head answers null for the absent key; only an unreachable bucket throws.
    await c.env.RECORDINGS.head(PROBE_KEY);
    answered = registry;
  } catch {
    answered = false;
  }
  const { status, body } = healthAnswer(answered);
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
