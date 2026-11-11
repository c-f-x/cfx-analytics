import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dashboardHeaders, dashboardSession, hmacToken } from "../../test/helpers/session.ts";
import { SESSION_COOKIE, sessionEmail } from "./session.ts";

// The dashboard session (D-27): a cookie holding the admin's email and an
// expiry, signed with HMAC-SHA256 under AUTH_SECRET (platform-44), checked on
// every dashboard path (platform-01).

const NOW = Date.UTC(2027, 0, 1);
const HOUR = 60 * 60 * 1000;

/** `text` with its last character changed. */
const flip = (text: string): string => `${text.slice(0, -1)}${text.endsWith("A") ? "B" : "A"}`;

describe("sessionEmail", () => {
  it("platform-44 · a session signed with AUTH_SECRET for the admin admits its email", async () => {
    const token = await hmacToken({ email: env.ADMIN_EMAIL, exp: NOW + HOUR });
    expect(await sessionEmail(token, env.AUTH_SECRET, env.ADMIN_EMAIL, NOW)).toBe(env.ADMIN_EMAIL);
  });

  it("platform-44 · the admin's email is compared without case", async () => {
    const token = await hmacToken({ email: env.ADMIN_EMAIL.toUpperCase(), exp: NOW + HOUR });
    expect(await sessionEmail(token, env.AUTH_SECRET, env.ADMIN_EMAIL, NOW)).toBe(
      env.ADMIN_EMAIL.toUpperCase(),
    );
  });

  it("platform-44 · one changed byte, another secret, or text that is no token is refused", async () => {
    const token = await hmacToken({ email: env.ADMIN_EMAIL, exp: NOW + HOUR });
    const [body = "", signature = ""] = token.split(".");
    const otherSecret = await hmacToken({ email: env.ADMIN_EMAIL, exp: NOW + HOUR }, "another");
    for (const refused of [
      `${flip(body)}.${signature}`,
      `${body}.${flip(signature)}`,
      otherSecret,
      "not a token",
      "",
      undefined,
    ]) {
      expect(await sessionEmail(refused, env.AUTH_SECRET, env.ADMIN_EMAIL, NOW)).toBeNull();
    }
  });

  it("platform-44 · a session is valid before its expiry and refused at it", async () => {
    const token = await hmacToken({ email: env.ADMIN_EMAIL, exp: NOW });
    expect(await sessionEmail(token, env.AUTH_SECRET, env.ADMIN_EMAIL, NOW - 1)).toBe(
      env.ADMIN_EMAIL,
    );
    expect(await sessionEmail(token, env.AUTH_SECRET, env.ADMIN_EMAIL, NOW)).toBeNull();
  });

  it("platform-44 · a signed session for another email is refused", async () => {
    const token = await hmacToken({ email: "someone@example.test", exp: NOW + HOUR });
    expect(await sessionEmail(token, env.AUTH_SECRET, env.ADMIN_EMAIL, NOW)).toBeNull();
  });

  it("platform-44 · a payload without a text email or a number expiry is refused", async () => {
    for (const payload of [{ exp: NOW + HOUR }, { email: env.ADMIN_EMAIL }, { email: 1, exp: 2 }]) {
      const token = await hmacToken(payload);
      expect(await sessionEmail(token, env.AUTH_SECRET, env.ADMIN_EMAIL, NOW)).toBeNull();
    }
  });
});

describe("the dashboard paths", () => {
  it("platform-01 · no valid session is 401 with one body for every path and host", async () => {
    const hosts = ["https://intake.test", "https://dashboard.test"];
    const paths = [
      "/api/projects",
      "/api/projects/does-not-exist",
      "/api/projects/0190f3b0-7c00-7000-8000-000000000000/keys",
      "/api/projects/0190f3b0-7c00-7000-8000-000000000000/query",
      "/api/projects/0190f3b0-7c00-7000-8000-000000000000/persons/erase",
      "/api/projects/0190f3b0-7c00-7000-8000-000000000000/export/events",
      "/api/projects/0190f3b0-7c00-7000-8000-000000000000/purge",
    ];
    const wrongSecret = await hmacToken(
      { email: env.ADMIN_EMAIL, exp: Date.now() + HOUR },
      "another",
    );
    const cookies = [undefined, `${SESSION_COOKIE}=${wrongSecret}`, `${SESSION_COOKIE}=junk`];
    const responses = await Promise.all(
      hosts.flatMap((host) =>
        paths.flatMap((path) =>
          cookies.map((cookie) =>
            SELF.fetch(`${host}${path}`, cookie === undefined ? {} : { headers: { cookie } }),
          ),
        ),
      ),
    );
    const answers = await Promise.all(
      responses.map(async (response) => ({ status: response.status, body: await response.text() })),
    );
    expect(answers.map((answer) => answer.status)).toEqual(answers.map(() => 401));
    expect(new Set(answers.map((answer) => answer.body)).size).toBe(1);
  });

  it("platform-01 · a valid session reaches the dashboard path", async () => {
    const response = await SELF.fetch("https://dashboard.test/api/projects", {
      headers: dashboardHeaders(await dashboardSession()),
    });
    expect(response.status).toBe(200);
  });
});
