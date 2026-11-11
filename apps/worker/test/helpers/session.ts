import { env } from "cloudflare:test";
import { bytesToBase64url } from "@cfanalytics/shared";
import { SESSION_COOKIE } from "../../src/platform/session.ts";

// A dashboard session for tests (platform-44, D-27): the token is built here
// with WebCrypto, not with the code under test, so a test of the session check
// does not check the code against itself.

const encoder = new TextEncoder();

/** `payload` signed as a session token: base64url(JSON) "." base64url(HMAC-SHA256 of that text). */
export async function hmacToken(
  payload: Record<string, unknown>,
  secret: string = env.AUTH_SECRET,
): Promise<string> {
  const body = bytesToBase64url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return `${body}.${bytesToBase64url(signature)}`;
}

/** A valid session for the admin at `nowMs`, good for 12 hours. */
export function dashboardSession(
  nowMs: number = Date.now(),
  email: string = env.ADMIN_EMAIL,
): Promise<string> {
  return hmacToken({ email, exp: nowMs + 12 * 60 * 60 * 1000 });
}

/** The Cookie header that carries `session`. */
export function sessionCookie(session: string): string {
  return `${SESSION_COOKIE}=${session}`;
}

/** Headers of a dashboard request: the session cookie and the dashboard's own origin. */
export function dashboardHeaders(session: string): Record<string, string> {
  return { cookie: sessionCookie(session), origin: env.DASHBOARD_ORIGIN };
}
