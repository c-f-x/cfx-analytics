import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { fetchApp } from "../../test/helpers/capture.ts";
import { hmacToken } from "../../test/helpers/session.ts";
import worker from "../index.ts";
import { SESSION_COOKIE } from "./session.ts";

// A deployment before its secrets are set, as staging was between its first
// deploy and `pnpm ops secrets` (platform-51). It must refuse, never fail.

const HOUR = 60 * 60 * 1000;

/** The Worker's bindings with the named ones taken away (undefined) or changed. */
function bindingsWith(change: Record<string, string | undefined>): Cloudflare.Env {
  const bindings: Cloudflare.Env = { ...env };
  for (const [name, value] of Object.entries(change)) {
    if (value === undefined) Reflect.deleteProperty(bindings, name);
    else Reflect.set(bindings, name, value);
  }
  return bindings;
}

async function ask(path: string, bindings: Cloudflare.Env, cookie?: string): Promise<Response> {
  const headers = cookie === undefined ? {} : { cookie };
  return fetchApp(worker, new Request(`https://dashboard.test${path}`, { headers }), bindings);
}

const UNSET = [
  { AUTH_SECRET: undefined },
  { AUTH_SECRET: "too-short" },
  { ADMIN_EMAIL: undefined },
  { DASHBOARD_ORIGIN: undefined },
];

it("platform-51 · without its secrets the dashboard's data is 401, even for a well-formed session", async () => {
  for (const change of UNSET) {
    // Signed with the secret the test pool sets, and with the one the change leaves, if any.
    const secret = change.AUTH_SECRET ?? env.AUTH_SECRET;
    const session = await hmacToken({ email: env.ADMIN_EMAIL, exp: Date.now() + HOUR }, secret);
    const response = await ask(
      "/api/projects",
      bindingsWith(change),
      `${SESSION_COOKIE}=${session}`,
    );
    expect({ change, status: response.status }).toEqual({ change, status: 401 });
  }
});

it("platform-51 · without its secrets sign-in is not set up: status says so, sign-in and callback are 503", async () => {
  for (const change of UNSET) {
    const bindings = bindingsWith(change);
    const status = await ask("/auth/status", bindings);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ signInReady: false, signedIn: false, email: null });
    for (const path of ["/auth/sign-in", "/auth/callback?state=s&code=c"]) {
      const response = await ask(path, bindings);
      expect({ change, path, status: response.status }).toEqual({ change, path, status: 503 });
    }
  }
});
