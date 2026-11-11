import {
  base64urlToBytes,
  bytesToBase64url,
  isJsonObject,
  type JsonObject,
} from "@cfanalytics/shared";
import type { MiddlewareHandler } from "hono";
import { type AppEnv, apiError } from "./http.ts";

// The dashboard session (D-27): the owner signs in with Cloudflare (sign-in.ts),
// and the Worker keeps who they are in a cookie signed with HMAC-SHA256 under
// AUTH_SECRET. Nothing is stored server-side; rotating AUTH_SECRET signs
// everyone out.

/** The session cookie. `__Host-` makes the browser require Secure and Path=/, with no Domain. */
export const SESSION_COOKIE = "__Host-cfa_session";

/** The cookie that carries a sign-in's state and PKCE verifier to its callback. */
export const SIGN_IN_COOKIE = "__Host-cfa_signin";

/** How long a session lasts (platform-47). */
export const SESSION_MS = 12 * 60 * 60 * 1000;

/** The shortest AUTH_SECRET admitted; `pnpm ops secrets` draws 43 characters. */
export const AUTH_SECRET_MIN = 32;

/** What a session needs from the deployment's secrets. */
export interface AuthConfig {
  secret: string;
  adminEmail: string;
  origin: string;
}

/**
 * The deployment's session secrets, or null while any is unset or AUTH_SECRET
 * is shorter than AUTH_SECRET_MIN. Until then no session is admitted and
 * sign-in is not set up (platform-51). The secrets are typed as present, but a
 * deployment has none until `pnpm ops secrets` runs, so each is checked here.
 */
export function authConfig(env: Cloudflare.Env): AuthConfig | null {
  const secret: unknown = env.AUTH_SECRET;
  const adminEmail: unknown = env.ADMIN_EMAIL;
  const origin: unknown = env.DASHBOARD_ORIGIN;
  if (typeof secret !== "string" || secret.length < AUTH_SECRET_MIN) return null;
  if (typeof adminEmail !== "string" || adminEmail === "") return null;
  if (typeof origin !== "string" || origin === "") return null;
  return { secret, adminEmail, origin };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** `payload` as a token: base64url of its JSON, ".", base64url of that text's HMAC-SHA256 under `secret`. */
export async function signToken(payload: JsonObject, secret: string): Promise<string> {
  const body = bytesToBase64url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  return `${body}.${bytesToBase64url(new Uint8Array(signature))}`;
}

/** A token's payload when its signature holds under `secret`, else null. The signature is checked in constant time. */
export async function readToken(token: string, secret: string): Promise<JsonObject | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body = "", signature = ""] = parts;
  const bytes = base64urlToBytes(signature);
  if (bytes === null || body === "") return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    bytes,
    encoder.encode(body),
  );
  if (!valid) return null;
  const json = base64urlToBytes(body);
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(decoder.decode(json));
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The email a session cookie's token admits at `now`: its signature holds
 * under `secret`, it has a text email and a number expiry after `now`, and
 * the email is `adminEmail` compared without case. Else null (platform-44).
 */
export async function sessionEmail(
  token: string | undefined,
  secret: string,
  adminEmail: string,
  now: number,
): Promise<string | null> {
  if (token === undefined || token === "") return null;
  const payload = await readToken(token, secret);
  if (payload === null) return null;
  const { email, exp } = payload;
  if (typeof email !== "string" || typeof exp !== "number" || now >= exp) return null;
  return email.toLowerCase() === adminEmail.toLowerCase() ? email : null;
}

/** The value of cookie `name` in a Cookie header, or undefined. */
export function cookieOf(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/** A Set-Cookie value for one of the dashboard's cookies: Path=/, HttpOnly, Secure, SameSite=Lax. */
export function setCookieValue(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/** The one 401 every dashboard path answers without a valid session (platform-01). */
function unauthorized(): Response {
  return apiError(401, "unauthorized", "This request needs a valid dashboard sign-in.");
}

/** A secret key sent as a Bearer token never reaches a dashboard path (platform-07, platform-08). */
function isSecretKeyBearer(authorization: string | undefined): boolean {
  return authorization !== undefined && /^bearer\s+cfa_sk_/i.test(authorization);
}

/**
 * Middleware for every dashboard path. Reads the session cookie and admits
 * it with sessionEmail under AUTH_SECRET and ADMIN_EMAIL at deps.now(). Any
 * failure answers 401, and so does a deployment whose secrets are not set
 * (authConfig, platform-51), and so does a request carrying a secret key as a
 * Bearer token, even beside a valid session, since no dashboard path takes
 * one. Every 401 has one body for every path and project id, existing or not
 * (platform-01, platform-07, platform-08). On success sets `caller`.
 */
export function requireAdmin(): MiddlewareHandler<AppEnv> {
  return async (c, next): Promise<Response | undefined> => {
    if (isSecretKeyBearer(c.req.header("authorization"))) return unauthorized();
    const config = authConfig(c.env);
    if (config === null) return unauthorized();
    const token = cookieOf(c.req.header("cookie"), SESSION_COOKIE);
    const email = await sessionEmail(token, config.secret, config.adminEmail, c.get("deps").now());
    if (email === null) return unauthorized();
    c.set("caller", { email });
    await next();
    return undefined;
  };
}

/** The one 403 of a state change that did not come from the dashboard. */
function forbiddenOrigin(): Response {
  return apiError(403, "forbidden_origin", "State changes must come from the dashboard.");
}

/**
 * Middleware for dashboard requests that change state (POST, PATCH, PUT,
 * DELETE). Accepts the request when its Origin equals DASHBOARD_ORIGIN, or,
 * with no Origin, when its Referer starts with DASHBOARD_ORIGIN + "/";
 * otherwise 403 "forbidden_origin". The browser sends the session cookie on
 * its own, so this stops cross-site requests (projects-26).
 */
export function requireSameOrigin(): MiddlewareHandler<AppEnv> {
  return async (c, next): Promise<Response | undefined> => {
    const dashboardOrigin = c.env.DASHBOARD_ORIGIN;
    const origin = c.req.header("origin");
    if (origin !== undefined) {
      if (origin !== dashboardOrigin) return forbiddenOrigin();
    } else {
      const referer = c.req.header("referer");
      if (referer === undefined || !referer.startsWith(`${dashboardOrigin}/`))
        return forbiddenOrigin();
    }
    await next();
    return undefined;
  };
}
