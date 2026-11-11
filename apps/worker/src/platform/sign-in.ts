import { bytesToBase64url, isJsonObject } from "@cfanalytics/shared";
import type { Hono } from "hono";
import { type AppContext, type AppEnv, apiError, dashboardAnswer } from "./http.ts";
import { messageOf } from "./result.ts";
import {
  type AuthConfig,
  authConfig,
  cookieOf,
  readToken,
  requireSameOrigin,
  SESSION_COOKIE,
  SESSION_MS,
  SIGN_IN_COOKIE,
  sessionEmail,
  setCookieValue,
  signToken,
} from "./session.ts";

// The owner signs in with their Cloudflare account through a private OAuth client in
// their account (D-27, after cfmail's D-13 and D-14). The addresses and the
// token request's shape are Cloudflare's, as Better Auth 1.7's Cloudflare
// provider uses them.

export const AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
export const TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
/** Cloudflare's userinfo answers only `sub`, so the email comes from the API's /user. */
export const USER_URL = "https://api.cloudflare.com/client/v4/user";

/** How long a sign-in may take between Cloudflare's page and the callback. */
const SIGN_IN_MS = 10 * 60 * 1000;

export function mountSignIn(app: Hono<AppEnv>): void {
  app.get("/auth/sign-in", handleSignIn);
  app.get("/auth/callback", handleCallback);
  app.post("/auth/sign-out", requireSameOrigin(), handleSignOut);
  app.get("/auth/status", handleStatus);
}

/** Whether sign-in is set up, and who is signed in, for the dashboard's page (platform-49, platform-51). */
async function handleStatus(c: AppContext): Promise<Response> {
  const auth = authConfig(c.env);
  const email =
    auth === null
      ? null
      : await sessionEmail(
          cookieOf(c.req.header("cookie"), SESSION_COOKIE),
          auth.secret,
          auth.adminEmail,
          c.get("deps").now(),
        );
  return dashboardAnswer({ signInReady: signInOf(c) !== null, signedIn: email !== null, email });
}

/** The callback address registered with the OAuth client: the dashboard's own origin. */
const callbackOf = (auth: AuthConfig): string => `${auth.origin}/auth/callback`;

interface SignIn {
  client: { id: string; secret: string };
  auth: AuthConfig;
}

/** The OAuth client and the session secrets, or null until all are set (platform-51). */
function signInOf(c: AppContext): SignIn | null {
  const id = c.env.CLOUDFLARE_CLIENT_ID;
  const secret = c.env.CLOUDFLARE_CLIENT_SECRET;
  const auth = authConfig(c.env);
  if (id === undefined || id === "" || secret === undefined || secret === "" || auth === null) {
    return null;
  }
  return { client: { id, secret }, auth };
}

const randomText = (c: AppContext, bytes: number): string =>
  bytesToBase64url(c.get("deps").random(bytes));

async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64url(new Uint8Array(digest));
}

/**
 * Starts a sign-in (platform-45): a random state and PKCE verifier kept in a
 * signed cookie for ten minutes, and a redirect to Cloudflare's authorize
 * address with the S256 challenge. Without the client's secrets, 503.
 */
async function handleSignIn(c: AppContext): Promise<Response> {
  const signIn = signInOf(c);
  if (signIn === null) {
    return apiError(503, "unavailable", "Cloudflare sign-in is not set up on this deployment.");
  }
  const state = randomText(c, 24);
  const verifier = randomText(c, 32);
  const now = c.get("deps").now();
  const flow = await signToken({ state, verifier, exp: now + SIGN_IN_MS }, signIn.auth.secret);
  const target = new URL(AUTHORIZE_URL);
  target.search = new URLSearchParams({
    response_type: "code",
    client_id: signIn.client.id,
    redirect_uri: callbackOf(signIn.auth),
    scope: "user-details.read",
    state,
    code_challenge: await challengeOf(verifier),
    code_challenge_method: "S256",
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      "set-cookie": setCookieValue(SIGN_IN_COOKIE, flow, SIGN_IN_MS / 1000),
      "cache-control": "no-store",
    },
  });
}

/** The sign-in cookie's state and verifier when it is ours, unexpired and its state is `state`; else null. */
async function flowOf(
  c: AppContext,
  secret: string,
  state: string | undefined,
): Promise<{ verifier: string } | null> {
  const token = cookieOf(c.req.header("cookie"), SIGN_IN_COOKIE);
  if (token === undefined || state === undefined || state === "") return null;
  const flow = await readToken(token, secret);
  if (flow === null) return null;
  const { exp, verifier } = flow;
  if (typeof exp !== "number" || c.get("deps").now() >= exp) return null;
  if (typeof verifier !== "string" || flow.state !== state) return null;
  return { verifier };
}

/** The access token Cloudflare gives for `code`, or null when the exchange fails. */
async function tokenFor(
  c: AppContext,
  signIn: SignIn,
  code: string,
  verifier: string,
): Promise<string | null> {
  const { client } = signIn;
  const response = await c.get("deps").fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${client.id}:${client.secret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackOf(signIn.auth),
      code_verifier: verifier,
    }).toString(),
  });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  return isJsonObject(body) && typeof body.access_token === "string" ? body.access_token : null;
}

/** The signed-in Cloudflare user's email, or null when Cloudflare does not say. */
async function emailFor(c: AppContext, accessToken: string): Promise<string | null> {
  const response = await c.get("deps").fetch(USER_URL, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  if (!isJsonObject(body) || body.success !== true || !isJsonObject(body.result)) return null;
  return typeof body.result.email === "string" ? body.result.email : null;
}

/**
 * Finishes a sign-in. A missing or different state, or a sign-in cookie
 * that is not ours or has expired, is 400 before Cloudflare is asked
 * anything (platform-46). Else the code is exchanged with the client's Basic
 * credentials and the verifier, and the email read from Cloudflare's user
 * address: ADMIN_EMAIL, compared without case, gets a session cookie for 12
 * hours and a redirect to the dashboard; another email is 403; a failed
 * exchange is 502 (platform-47). The sign-in cookie is cleared either way
 * once it has been used.
 */
async function handleCallback(c: AppContext): Promise<Response> {
  const signIn = signInOf(c);
  if (signIn === null) {
    return apiError(503, "unavailable", "Cloudflare sign-in is not set up on this deployment.");
  }
  const flow = await flowOf(c, signIn.auth.secret, c.req.query("state"));
  const code = c.req.query("code");
  if (flow === null || code === undefined || code === "") {
    return apiError(400, "validation_failed", "This sign-in has expired or was not started here.");
  }
  const cleared = setCookieValue(SIGN_IN_COOKIE, "", 0);

  let email: string | null;
  try {
    const accessToken = await tokenFor(c, signIn, code, flow.verifier);
    email = accessToken === null ? null : await emailFor(c, accessToken);
  } catch (cause) {
    c.get("deps").log.error("sign_in_failed", { message: messageOf(cause) });
    email = null;
  }
  if (email === null) {
    const failed = apiError(502, "unavailable", "Cloudflare did not confirm the sign-in.");
    failed.headers.append("set-cookie", cleared);
    return failed;
  }
  if (email.toLowerCase() !== signIn.auth.adminEmail.toLowerCase()) {
    const refused = apiError(
      403,
      "forbidden",
      "This Cloudflare account may not use the dashboard.",
    );
    refused.headers.append("set-cookie", cleared);
    return refused;
  }

  const session = await signToken(
    { email, exp: c.get("deps").now() + SESSION_MS },
    signIn.auth.secret,
  );
  const headers = new Headers({ location: "/", "cache-control": "no-store" });
  headers.append("set-cookie", setCookieValue(SESSION_COOKIE, session, SESSION_MS / 1000));
  headers.append("set-cookie", cleared);
  return new Response(null, { status: 302, headers });
}

/** Signs out: the session cookie is cleared (platform-48). */
function handleSignOut(): Response {
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": setCookieValue(SESSION_COOKIE, "", 0), "cache-control": "no-store" },
  });
}
