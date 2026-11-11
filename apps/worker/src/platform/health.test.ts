import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { poisoned } from "../../test/helpers/bindings.ts";
import worker from "../index.ts";
import { healthAnswer } from "./health.ts";

const healthz = "https://intake.test/healthz";

/** The registry with every answer failing, standing in for Cloudflare's D1 being down. */
const brokenRegistry = new Proxy(env.REGISTRY, {
  get() {
    throw new Error("registry unavailable");
  },
});

async function ask(request: Request, bindings: Cloudflare.Env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("platform-12", () => {
  it('platform-12 · a working registry is 200 with exactly {"ok":true}', async () => {
    const response = await SELF.fetch(healthz);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("platform-12 · credentials make no difference to the answer", async () => {
    const response = await SELF.fetch(healthz, {
      headers: {
        authorization: "Bearer cfa_sk_notarealkey",
        cookie: "__Host-cfa_session=not-a-token",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
  });

  it("platform-12 · the pure answer is 200 and {ok:true}", () => {
    expect(healthAnswer(true)).toEqual({ status: 200, body: { ok: true } });
  });
});

describe("platform-13", () => {
  it('platform-13 · a failed registry is 503 with exactly {"ok":false} and no error text', async () => {
    const response = await ask(new Request(healthz), { ...env, REGISTRY: brokenRegistry });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"ok":false}');
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("platform-13 · the pure answer is 503 and {ok:false}", () => {
    expect(healthAnswer(false)).toEqual({ status: 503, body: { ok: false } });
  });

  it("platform-13 · the check never contacts a ProjectStore", async () => {
    const response = await ask(new Request(healthz), {
      ...env,
      PROJECT_STORE: poisoned(env.PROJECT_STORE, "PROJECT_STORE"),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
  });

  it('platform-13 · a failed recordings bucket is 503 with exactly {"ok":false}', async () => {
    const response = await ask(new Request(healthz), {
      ...env,
      RECORDINGS: poisoned(env.RECORDINGS, "RECORDINGS"),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"ok":false}');
  });
});

describe("platform-14", () => {
  it("platform-14 · a POST is 405 and its answer still says no-store", async () => {
    const response = await SELF.fetch(healthz, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
