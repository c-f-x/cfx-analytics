import { env } from "cloudflare:test";
import { isJsonObject, POSTHOG_JS_VERSION } from "@cfanalytics/shared";
import { describe, expect, it } from "vitest";
import { withoutStores } from "../../../test/helpers/bindings.ts";
import {
  answerJson,
  appAt,
  BROWSER_UA,
  capture,
  fetchApp,
  IOS_UA,
  jsBatch,
  jsRequest,
  MINUTE_MS,
  ORIGIN,
  preflightRequest,
  rawRequest,
  storedEvents,
  T0,
  wasContacted,
} from "../../../test/helpers/capture.ts";
import { asRecord } from "../../../test/helpers/json.ts";
import { newToken, seedProject } from "../../../test/helpers/registry.ts";
import worker from "../../index.ts";
import { SCRIPT_KINDS, SCRIPT_SHA256 } from "./core.ts";
import { mountConfig } from "./http.ts";

// The SDK's load-time routes as the SDKs call them (config-01 to config-32,
// intake-08, intake-12, intake-27). Every request goes through the real
// Worker; each test seeds its own project (docs/test-worker.md).

const FLAGS_KEYS = ["errorsWhileComputingFlags", "featureFlagPayloads", "featureFlags", "flags"];

function allKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, into);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      into.push(key);
      allKeys(item, into);
    }
  }
  return into;
}

function configRequest(token: string, origin: string | null = null): Request {
  return rawRequest(null, {}, { path: `/array/${token}/config`, origin }, "GET");
}

function configScriptRequest(token: string, origin: string | null = null): Request {
  return rawRequest(null, {}, { path: `/array/${token}/config.js`, origin }, "GET");
}

function staticRequest(kind: string, versioned: boolean, origin: string | null = null): Request {
  const path = versioned ? `/static/${POSTHOG_JS_VERSION}/${kind}.js` : `/static/${kind}.js`;
  return rawRequest(null, {}, { path, origin }, "GET");
}

async function configOf(token: string): Promise<Record<string, unknown>> {
  const response = await capture(configRequest(token));
  expect(response.status).toBe(200);
  return asRecord(await answerJson(response));
}

async function flagsKeysOf(response: Response): Promise<string[]> {
  expect(response.status).toBe(200);
  return Object.keys(asRecord(await answerJson(response))).toSorted();
}

function expectCors(response: Response, origin: string): void {
  expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
  expect(response.headers.get("vary")).toContain("Origin");
}

async function scriptBytes(path: string): Promise<Uint8Array> {
  const response = await capture(rawRequest(null, {}, { path, origin: null }, "GET"));
  expect(response.status).toBe(200);
  return new Uint8Array(await response.arrayBuffer());
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("GET /array/:token/config", () => {
  it("config-01 · recording on sets the rate, duration and masking", async () => {
    const project = await seedProject({
      settings: {
        recording_enabled: true,
        recording_sample_rate: 0.5,
        recording_min_duration_ms: 5000,
      },
    });
    const recording = asRecord((await configOf(project.token)).sessionRecording);
    expect(recording.endpoint).toBe("/s/");
    expect(recording.sampleRate).toBe("0.5");
    expect(recording.minimumDurationMilliseconds).toBe(5000);
    expect(recording.masking).toEqual({ maskAllInputs: true });
    const keys = allKeys(recording);
    expect(keys).not.toContain("maskTextSelector");
    expect(keys).not.toContain("blockSelector");
  });

  it("config-02 · both switches off are false and the key is present", async () => {
    const project = await seedProject();
    const config = await configOf(project.token);
    expect("sessionRecording" in config).toBe(true);
    expect(config.sessionRecording).toBe(false);
    expect(config.heatmaps).toBe(false);
  });

  it("config-06 · GET /array/<token>/config answers a JSON object", async () => {
    const project = await seedProject();
    const response = await capture(configRequest(project.token));
    expect(response.status).toBe(200);
    expect(isJsonObject(await answerJson(response))).toBe(true);
  });

  it("config-10 · the config names /e/ and a batch to /e/ answers 200", async () => {
    const project = await seedProject();
    expect((await configOf(project.token)).analytics).toEqual({ endpoint: "/e/" });
    const response = await capture(
      await jsRequest(jsBatch(project.token, [{ event: "$pageview", distinctId: "e-1" }])),
    );
    expect(response.status).toBe(200);
    expect(await storedEvents(project.id)).toHaveLength(1);
  });

  it("config-12 · a config read is cached for a minute, then refreshes", async () => {
    const project = await seedProject();
    let now = T0;
    const app = appAt(() => now, mountConfig);
    const read = async (): Promise<Record<string, unknown>> => {
      const response = await fetchApp(app, configRequest(project.token));
      expect(response.status).toBe(200);
      return asRecord(await answerJson(response));
    };

    expect((await read()).sessionRecording).toBe(false);
    await env.REGISTRY.prepare("UPDATE projects SET recording_enabled = 1 WHERE id = ?")
      .bind(project.id)
      .run();

    now = T0 + MINUTE_MS - 1000;
    expect((await read()).sessionRecording).toBe(false);

    now = T0 + MINUTE_MS + 1000;
    expect(asRecord((await read()).sessionRecording).endpoint).toBe("/s/");
  });

  it("config-19 · an iOS config has the recording keys and no refusals", async () => {
    const project = await seedProject({ settings: { recording_enabled: true } });
    const response = await capture(
      rawRequest(
        null,
        { "accept-encoding": "gzip" },
        { path: `/array/${project.token}/config`, origin: null, userAgent: IOS_UA },
        "GET",
      ),
    );
    expect(response.status).toBe(200);
    const config = asRecord(await answerJson(response));
    const recording = asRecord(config.sessionRecording);
    expect(recording.endpoint).toBe("/s/");
    expect("sampleRate" in recording).toBe(true);
    expect(recording.minimumDurationMilliseconds).toBe(2000);
    const keys = allKeys(config);
    expect(keys).not.toContain("linkedFlag");
    expect(keys).not.toContain("quotaLimited");
    expect(keys).not.toContain("push");
  });

  it("config-30 · POST to config or config.js answers 405", async () => {
    const project = await seedProject();
    const paths = [`/array/${project.token}/config`, `/array/${project.token}/config.js`];
    for (const path of paths) {
      const response = await capture(rawRequest(null, {}, { path }, "POST"));
      expect(response.status).toBe(405);
    }
  });

  it("config-31 · the config and config.js answers live one minute", async () => {
    const project = await seedProject();
    const config = await capture(configRequest(project.token));
    expect(config.headers.get("cache-control")).toBe("public, max-age=60");
    const scriptConfig = await capture(configScriptRequest(project.token));
    expect(scriptConfig.headers.get("cache-control")).toBe("public, max-age=60");
  });
});

describe("GET /array/:token/config.js", () => {
  it("config-20 · two hosts get the same body and neither host is named", async () => {
    const project = await seedProject();
    const path = `/array/${project.token}/config.js`;
    const first = await capture(
      rawRequest(null, {}, { path, origin: null, userAgent: BROWSER_UA }, "GET"),
    );
    const second = await capture(
      new Request(new URL(path, "https://second.test"), { headers: { "user-agent": BROWSER_UA } }),
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const body = await first.text();
    expect(body).toBe(await second.text());
    expect(body).toContain(`["${project.token}"]`);
    expect(body).not.toContain("intake.test");
    expect(body).not.toContain("second.test");
    expect(body).not.toMatch(/\{\{|\$\{/);
  });

  it("config-21 · a token holding a script tag is 401 and never echoed", async () => {
    const token = '"><script>alert(1)</script>';
    const response = await capture(
      rawRequest(
        null,
        {},
        { path: `/array/${encodeURIComponent(token)}/config.js`, origin: null },
        "GET",
      ),
    );
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).not.toContain(token);
    expect(body).not.toContain("<script>");
  });

  it("config-22 · config.js and a script answer as JavaScript with CORS", async () => {
    const project = await seedProject();
    const scriptConfig = await capture(configScriptRequest(project.token, ORIGIN));
    expect(scriptConfig.status).toBe(200);
    expect(scriptConfig.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expectCors(scriptConfig, ORIGIN);

    const script = await capture(staticRequest("recorder", true, ORIGIN));
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expectCors(script, ORIGIN);
  });
});

describe("GET /static/*", () => {
  it("config-05 · another version is 404, the plain path is 200", async () => {
    const other = await capture(
      rawRequest(null, {}, { path: "/static/1.0.0/lazy-recorder.js", origin: null }, "GET"),
    );
    expect(other.status).toBe(404);
    const plain = await capture(staticRequest("lazy-recorder", false));
    expect(plain.status).toBe(200);
    const asset = await env.ASSETS.fetch(
      new Request("https://assets.test/posthog/lazy-recorder.js"),
    );
    expect(asset.status).toBe(200);
    expect(new Uint8Array(await plain.arrayBuffer())).toEqual(
      new Uint8Array(await asset.arrayBuffer()),
    );
  });

  it("config-25 · each kind serves the same bytes at both its paths", async () => {
    for (const kind of SCRIPT_KINDS) {
      const atVersion = await scriptBytes(`/static/${POSTHOG_JS_VERSION}/${kind}.js`);
      const plain = await scriptBytes(`/static/${kind}.js`);
      expect(atVersion).toEqual(plain);
      expect(atVersion.byteLength).toBeGreaterThan(0);
    }
  });

  it("config-26 · bad version, kind, file name or depth is 404", async () => {
    const paths = [
      "/static/9.9.9/recorder.js",
      "/static/unknown.js",
      `/static/${POSTHOG_JS_VERSION}/recorder.js.map`,
      `/static/${POSTHOG_JS_VERSION}/deeper/recorder.js`,
    ];
    for (const path of paths) {
      const response = await capture(rawRequest(null, {}, { path, origin: null }, "GET"));
      expect(response.status).toBe(404);
    }
  });

  it("config-27 · each served script hashes to the recorded value", async () => {
    for (const kind of SCRIPT_KINDS) {
      const bytes = await scriptBytes(`/static/${POSTHOG_JS_VERSION}/${kind}.js`);
      expect(await sha256Of(bytes)).toBe(SCRIPT_SHA256[kind]);
    }
  });

  it("config-28 · dead clicks off still leaves every script served", async () => {
    const project = await seedProject({ settings: { dead_clicks_enabled: false } });
    expect(project.settings.dead_clicks_enabled).toBe(false);
    for (const kind of SCRIPT_KINDS) {
      expect((await capture(staticRequest(kind, true))).status).toBe(200);
      expect((await capture(staticRequest(kind, false))).status).toBe(200);
    }
  });

  it("config-31 · each script answer carries its own cache lifetime", async () => {
    const versioned = await capture(staticRequest("recorder", true));
    expect(versioned.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const unversioned = await capture(staticRequest("recorder", false));
    expect(unversioned.headers.get("cache-control")).toBe("public, max-age=3600");
  });
});

describe("POST /flags", () => {
  it("config-03 · /flags/?v=2 answers exactly the four keys", async () => {
    const project = await seedProject();
    const response = await capture(
      await jsRequest({ token: project.token, distinct_id: "user-flags" }, "json", {
        path: "/flags/",
        query: { v: "2" },
      }),
    );
    expect(await flagsKeysOf(response)).toEqual(FLAGS_KEYS);
  });

  it("config-23 · gzip, base64, JSON and extra query keys answer 200", async () => {
    const project = await seedProject();
    const body = { token: project.token, distinct_id: "user-flags" };
    const requests = [
      await jsRequest(body, "gzip", { path: "/flags/?v=2" }),
      await jsRequest(body, "base64", { path: "/flags" }),
      await jsRequest(body, "json", { path: "/flags/" }),
      await jsRequest(body, "json", { path: "/flags", query: { v: "2", ip: "1", _: "1" } }),
    ];
    for (const request of requests) {
      expect(await flagsKeysOf(await capture(request))).toEqual(FLAGS_KEYS);
    }
  });

  it("config-24 · /flags answers 200 with the ProjectStore poisoned", async () => {
    const project = await seedProject();
    const response = await fetchApp(
      worker,
      await jsRequest({ token: project.token }, "json", { path: "/flags/" }),
      withoutStores(),
    );
    expect(await flagsKeysOf(response)).toEqual(FLAGS_KEYS);
    expect(await wasContacted(project.id)).toBe(false);
  });

  it("config-32 · config=true and extra query keys change nothing", async () => {
    const project = await seedProject();
    const response = await capture(
      await jsRequest({ token: project.token }, "json", {
        path: "/flags",
        query: { v: "2", config: "true", ip: "1", _: "1" },
      }),
    );
    expect(await flagsKeysOf(response)).toEqual(FLAGS_KEYS);
  });
});

describe("refusals", () => {
  it("config-07 · an unknown or blank token is 401 on all three paths", async () => {
    const unknown = newToken();
    const requests = [
      configRequest(unknown),
      rawRequest(
        null,
        {},
        { path: "/array/%20%20/config", origin: null, userAgent: IOS_UA },
        "GET",
      ),
      configScriptRequest(unknown),
      rawRequest(null, {}, { path: "/array/%20%20/config.js", origin: null }, "GET"),
      await jsRequest({ token: unknown }, "json", { path: "/flags/" }),
      await jsRequest({ token: " " }, "json", { path: "/flags" }),
    ];
    for (const request of requests) {
      const response = await fetchApp(worker, request, withoutStores());
      expect(response.status).toBe(401);
    }
  });

  it("config-07 · a known token's three paths contact no ProjectStore", async () => {
    const project = await seedProject();
    const requests = [
      configRequest(project.token),
      configScriptRequest(project.token),
      await jsRequest({ token: project.token }, "json", { path: "/flags/" }),
    ];
    for (const request of requests) {
      expect((await capture(request)).status).toBe(200);
    }
    expect(await wasContacted(project.id)).toBe(false);
  });

  it("config-07 · a failing registry answers 503", async () => {
    const response = await fetchApp(worker, configRequest(newToken()), {
      ...withoutStores(),
      REGISTRY: env.UNMIGRATED_REGISTRY,
    });
    expect(response.status).toBe(503);
  });

  it("config-07 · a body that is not JSON or not an object is 400", async () => {
    for (const body of ["not json", "7", '"text"']) {
      const response = await capture(
        rawRequest(body, { "content-type": "application/json" }, { path: "/flags/" }),
      );
      expect(response.status).toBe(400);
    }
  });
});

describe("intake", () => {
  it("intake-08 · a default project's config is valid with both switches off", async () => {
    const project = await seedProject();
    const config = await configOf(project.token);
    expect(Object.keys(config).length).toBeGreaterThan(0);
    expect(config.sessionRecording).toBe(false);
    expect(config.heatmaps).toBe(false);
  });

  it("intake-12 · a preflight on each SDK path answers the CORS headers", async () => {
    const project = await seedProject();
    const paths = [
      "/flags",
      "/flags/",
      `/array/${project.token}/config`,
      `/array/${project.token}/config.js`,
      `/static/${POSTHOG_JS_VERSION}/recorder.js`,
    ];
    for (const path of paths) {
      const response = await capture(preflightRequest(path));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
      expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
      expect(response.headers.get("access-control-allow-headers")).toBe("content-type");
      expect(response.headers.get("access-control-max-age")).toBe("86400");
      expect(response.headers.get("vary")).toContain("Origin");
    }
  });

  it("intake-12 · 401 and 404 answers carry the same CORS headers", async () => {
    const project = await seedProject();
    const accepted = await capture(
      await jsRequest({ token: project.token }, "json", { path: "/flags/" }),
    );
    expect(accepted.status).toBe(200);
    expectCors(accepted, ORIGIN);
    const refused = await capture(configRequest(newToken(), ORIGIN));
    expect(refused.status).toBe(401);
    expectCors(refused, ORIGIN);
    const missing = await capture(staticRequest("unknown", false, ORIGIN));
    expect(missing.status).toBe(404);
    expectCors(missing, ORIGIN);
  });

  it("intake-27 · at the daily cap config and /flags still answer 200", async () => {
    const project = await seedProject({ settings: { daily_event_cap: 1 } });
    const fill = await capture(
      await jsRequest(jsBatch(project.token, [{ event: "$pageview", distinctId: "cap-1" }])),
    );
    expect(fill.status).toBe(200);
    expect(await answerJson(fill)).toEqual({ status: 1 });

    const config = await configOf(project.token);
    expect("analytics" in config).toBe(true);
    const flags = await capture(
      await jsRequest({ token: project.token }, "json", { path: "/flags" }),
    );
    expect(flags.status).toBe(200);
  });
});
