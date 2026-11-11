import { env } from "cloudflare:test";
import { base64urlToBytes, bytesToBase64url, isJsonObject } from "@cfanalytics/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { fetchApp } from "../../test/helpers/capture.ts";
import { hmacToken } from "../../test/helpers/session.ts";
import { realDeps } from "./deps.ts";
import type { AppEnv } from "./http.ts";
import { SESSION_COOKIE, SIGN_IN_COOKIE, sessionEmail } from "./session.ts";
import { AUTHORIZE_URL, mountSignIn, TOKEN_URL, USER_URL } from "./sign-in.ts";

// Signing the owner in with Cloudflare (D-27, platform-45 to platform-48). Cloudflare's
// token and user endpoints are a stand-in passed as deps.fetch, shaped as
// Better Auth 1.7's Cloudflare provider calls them; the staging smoke checks
// the real ones.

const ORIGIN = env.DASHBOARD_ORIGIN;
const decoder = new TextDecoder();

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

/** Cloudflare's two endpoints: a token for any code, and a user with `email`. Records every call. */
function cloudflare(options: { email?: string; tokenStatus?: number } = {}): {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    async fetch(input, init = {}) {
      const request = new Request(input, init);
      calls.push({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: await request.text(),
      });
      if (request.url === TOKEN_URL) {
        if (options.tokenStatus !== undefined && options.tokenStatus !== 200) {
          return Response.json({ error: "invalid_grant" }, { status: options.tokenStatus });
        }
        return Response.json({ access_token: "token-1", token_type: "bearer", expires_in: 3600 });
      }
      if (request.url === USER_URL) {
        return Response.json({
          success: true,
          result: { email: options.email ?? env.ADMIN_EMAIL },
        });
      }
      return new Response("not found", { status: 404 });
    },
  };
}

/** The sign-in routes alone, with `fetch` as the outside world. */
function signInApp(fetch: (input: string, init?: RequestInit) => Promise<Response>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError((error) => {
    throw error;
  });
  app.use("*", async (c, next) => {
    c.set("deps", { ...realDeps(), fetch });
    await next();
  });
  mountSignIn(app);
  return app;
}

/** The value a Set-Cookie header gives `name`, and its attributes. */
function setCookie(
  response: Response,
  name: string,
): { value: string; attributes: string[] } | null {
  for (const header of response.headers.getSetCookie()) {
    const [pair = "", ...attributes] = header.split(";").map((part) => part.trim());
    const at = pair.indexOf("=");
    if (pair.slice(0, at) === name) return { value: pair.slice(at + 1), attributes };
  }
  return null;
}

/** A signed token's payload, read without checking its signature. */
function payloadOf(token: string): Record<string, unknown> {
  const bytes = base64urlToBytes(token.split(".")[0] ?? "");
  if (bytes === null) throw new Error("not a token");
  const payload: unknown = JSON.parse(decoder.decode(bytes));
  if (!isJsonObject(payload)) throw new Error("not a token payload");
  return payload;
}

async function sha256Base64url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return bytesToBase64url(new Uint8Array(digest));
}

/** A sign-in cookie as /auth/sign-in would set it, for `state` and `verifier`, expiring at `exp`. */
function signInCookie(state: string, verifier: string, exp: number): Promise<string> {
  return hmacToken({ state, verifier, exp });
}

function callback(
  app: Hono<AppEnv>,
  query: string,
  cookie: string | null,
  bindings: Cloudflare.Env = env,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== null) headers.cookie = `${SIGN_IN_COOKIE}=${cookie}`;
  return fetchApp(app, new Request(`${ORIGIN}/auth/callback?${query}`, { headers }), bindings);
}

describe("GET /auth/sign-in", () => {
  it("platform-45 · redirects to Cloudflare with the client, scope, state and an S256 challenge", async () => {
    const stand = cloudflare();
    const response = await fetchApp(signInApp(stand.fetch), new Request(`${ORIGIN}/auth/sign-in`));

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(AUTHORIZE_URL);
    expect(location.searchParams.get("client_id")).toBe(env.CLOUDFLARE_CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("scope")).toBe("user-details.read");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");

    const cookie = setCookie(response, SIGN_IN_COOKIE);
    if (cookie === null) throw new Error("no sign-in cookie");
    expect(cookie.attributes).toEqual(
      expect.arrayContaining(["Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=600"]),
    );
    const flow = payloadOf(cookie.value);
    expect(location.searchParams.get("state")).toBe(flow.state);
    expect(String(flow.state).length).toBeGreaterThanOrEqual(22);
    expect(location.searchParams.get("code_challenge")).toBe(
      await sha256Base64url(String(flow.verifier)),
    );
    expect(stand.calls).toEqual([]);
  });

  it("platform-45 · two sign-ins get different states and verifiers", async () => {
    const app = signInApp(cloudflare().fetch);
    const first = setCookie(
      await fetchApp(app, new Request(`${ORIGIN}/auth/sign-in`)),
      SIGN_IN_COOKIE,
    );
    const second = setCookie(
      await fetchApp(app, new Request(`${ORIGIN}/auth/sign-in`)),
      SIGN_IN_COOKIE,
    );
    expect(payloadOf(first?.value ?? "").state).not.toBe(payloadOf(second?.value ?? "").state);
    expect(payloadOf(first?.value ?? "").verifier).not.toBe(
      payloadOf(second?.value ?? "").verifier,
    );
  });

  it("platform-45 · without the client's secrets, sign-in is 503 and sets nothing", async () => {
    const { CLOUDFLARE_CLIENT_ID: _id, CLOUDFLARE_CLIENT_SECRET: _secret, ...unset } = env;
    const response = await fetchApp(
      signInApp(cloudflare().fetch),
      new Request(`${ORIGIN}/auth/sign-in`),
      unset,
    );
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe("GET /auth/callback", () => {
  it("platform-46 · a missing or different state, or no sign-in cookie, is 400 and asks for no token", async () => {
    const stand = cloudflare();
    const app = signInApp(stand.fetch);
    const cookie = await signInCookie("state-1", "verifier-1", Date.now() + 60_000);
    for (const [query, sent] of [
      ["code=c1", cookie],
      ["code=c1&state=state-2", cookie],
      ["code=c1&state=state-1", null],
    ] as const) {
      const response = await callback(app, query, sent);
      expect(response.status).toBe(400);
      expect(setCookie(response, SESSION_COOKIE)).toBeNull();
    }
    expect(stand.calls).toEqual([]);
  });

  it("platform-46 · an expired sign-in cookie, or one signed with another secret, is 400", async () => {
    const stand = cloudflare();
    const app = signInApp(stand.fetch);
    const expired = await signInCookie("state-1", "verifier-1", Date.now() - 1);
    const forged = await hmacToken(
      { state: "state-1", verifier: "verifier-1", exp: Date.now() + 60_000 },
      "another",
    );
    for (const cookie of [expired, forged]) {
      const response = await callback(app, "code=c1&state=state-1", cookie);
      expect(response.status).toBe(400);
      expect(setCookie(response, SESSION_COOKIE)).toBeNull();
    }
    expect(stand.calls).toEqual([]);
  });

  it("platform-47 · the right state exchanges the code with Basic credentials and the verifier, then signs the admin in", async () => {
    const stand = cloudflare({ email: env.ADMIN_EMAIL.toUpperCase() });
    const app = signInApp(stand.fetch);
    const cookie = await signInCookie("state-1", "verifier-1", Date.now() + 60_000);
    const before = Date.now();
    const response = await callback(app, "code=code-1&state=state-1", cookie);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");

    const [token, user] = stand.calls;
    expect(token?.url).toBe(TOKEN_URL);
    expect(token?.method).toBe("POST");
    expect(token?.headers.get("authorization")).toBe(
      `Basic ${btoa(`${env.CLOUDFLARE_CLIENT_ID}:${env.CLOUDFLARE_CLIENT_SECRET}`)}`,
    );
    const form = new URLSearchParams(token?.body ?? "");
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: `${ORIGIN}/auth/callback`,
      code_verifier: "verifier-1",
    });
    expect(user?.url).toBe(USER_URL);
    expect(user?.headers.get("authorization")).toBe("Bearer token-1");

    const session = setCookie(response, SESSION_COOKIE);
    if (session === null) throw new Error("no session cookie");
    expect(session.attributes).toEqual(
      expect.arrayContaining(["Path=/", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=43200"]),
    );
    const exp = Number(payloadOf(session.value).exp);
    expect(exp).toBeGreaterThanOrEqual(before + 12 * 60 * 60 * 1000);
    expect(await sessionEmail(session.value, env.AUTH_SECRET, env.ADMIN_EMAIL, before)).toBe(
      env.ADMIN_EMAIL.toUpperCase(),
    );
    // The sign-in cookie has done its work and is cleared.
    expect(setCookie(response, SIGN_IN_COOKIE)?.attributes).toContain("Max-Age=0");
  });

  it("platform-47 · another Cloudflare account is 403 and gets no session", async () => {
    const app = signInApp(cloudflare({ email: "someone@example.test" }).fetch);
    const cookie = await signInCookie("state-1", "verifier-1", Date.now() + 60_000);
    const response = await callback(app, "code=code-1&state=state-1", cookie);
    expect(response.status).toBe(403);
    expect(setCookie(response, SESSION_COOKIE)).toBeNull();
  });

  it("platform-47 · a failing code exchange is 502 and gets no session", async () => {
    const stand = cloudflare({ tokenStatus: 400 });
    const app = signInApp(stand.fetch);
    const cookie = await signInCookie("state-1", "verifier-1", Date.now() + 60_000);
    const response = await callback(app, "code=code-1&state=state-1", cookie);
    expect(response.status).toBe(502);
    expect(setCookie(response, SESSION_COOKIE)).toBeNull();
    expect(stand.calls.map((call) => call.url)).toEqual([TOKEN_URL]);
  });
});

describe("POST /auth/sign-out", () => {
  it("platform-48 · from the dashboard's origin it clears the session; from another it is 403", async () => {
    const app = signInApp(cloudflare().fetch);
    const signedOut = await fetchApp(
      app,
      new Request(`${ORIGIN}/auth/sign-out`, { method: "POST", headers: { origin: ORIGIN } }),
    );
    expect(signedOut.status).toBe(204);
    expect(setCookie(signedOut, SESSION_COOKIE)?.attributes).toContain("Max-Age=0");

    const foreign = await fetchApp(
      app,
      new Request(`${ORIGIN}/auth/sign-out`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
      }),
    );
    expect(foreign.status).toBe(403);
    expect(setCookie(foreign, SESSION_COOKIE)).toBeNull();
  });
});

describe("GET /auth/status", () => {
  it("platform-49 · says whether sign-in is set up and who is signed in, and never caches", async () => {
    const app = signInApp(cloudflare().fetch);
    const status = async (headers: Record<string, string>, bindings: Cloudflare.Env = env) => {
      const response = await fetchApp(
        app,
        new Request(`${ORIGIN}/auth/status`, { headers }),
        bindings,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      return response.json();
    };

    expect(await status({})).toEqual({ signInReady: true, signedIn: false, email: null });
    const session = await hmacToken({ email: env.ADMIN_EMAIL, exp: Date.now() + 60_000 });
    expect(await status({ cookie: `${SESSION_COOKIE}=${session}` })).toEqual({
      signInReady: true,
      signedIn: true,
      email: env.ADMIN_EMAIL,
    });
    const { CLOUDFLARE_CLIENT_ID: _id, CLOUDFLARE_CLIENT_SECRET: _secret, ...unset } = env;
    expect(await status({}, unset)).toEqual({ signInReady: false, signedIn: false, email: null });
  });
});
