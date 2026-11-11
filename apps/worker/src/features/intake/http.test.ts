import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { BODY_LIMITS, CLIP, DISTINCT_ID_MAX, isJsonObject } from "@cfanalytics/shared";
import { describe, expect, it } from "vitest";
import { withoutStores } from "../../../test/helpers/bindings.ts";
import {
  answerJson,
  base64Form,
  CLIENT_IP,
  COOKIELESS_SENTINEL,
  capture,
  captureApp,
  cookielessProperties,
  DAY_MS,
  fetchApp,
  gzip,
  handBuiltEvent,
  handBuiltRequest,
  iosBatch,
  iosRequest,
  iso,
  jsBatch,
  jsEvent,
  jsonBytes,
  jsRequest,
  nodeBatch,
  nodeRequest,
  ORIGIN,
  preflightRequest,
  rawRequest,
  storedEvents,
  storedPersons,
  storeOf,
  storeText,
  T0,
  wasContacted,
} from "../../../test/helpers/capture.ts";
import { newToken, seedProject } from "../../../test/helpers/registry.ts";
import worker from "../../index.ts";
import { applySteps } from "../../platform/schema.ts";
import { CAPTURE_PATHS } from "./http.ts";

// Every answer an SDK sees on a capture path (intake-01 to intake-18,
// intake-21 to intake-32, intake-37). SELF runs on the real clock; captureApp
// fixes it where a day boundary or retention is checked.

const encoder = new TextEncoder();
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function expectCors(response: Response, origin: string | null): void {
  expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  expect(response.headers.get("vary")).toBe("Origin");
  if (origin !== null) {
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  }
}

describe("capture", () => {
  it("intake-01 · a posthog-js gzip batch is stored and answered 200 with {status:1}", async () => {
    const project = await seedProject();
    const body = jsBatch(project.token, [
      { event: "$pageview", distinctId: "browser-1" },
      { event: "signup", distinctId: "browser-1", properties: { plan: "pro" } },
    ]);
    const response = await capture(await jsRequest(body, "gzip"));
    expect(response.status).toBe(200);
    expect(await answerJson(response)).toEqual({ status: 1 });
    const events = await storedEvents(project.id);
    expect(events.map((event) => event.event)).toEqual(["$pageview", "signup"]);
  });

  it("intake-02 · an unknown token is 401 and no store is contacted", async () => {
    const unknown = newToken();
    const response = await fetchApp(
      worker,
      await jsRequest(jsBatch(unknown, [{ event: "$pageview", distinctId: "unknown" }]), "gzip"),
      withoutStores(),
    );
    expect(response.status).toBe(401);
  });

  it("intake-02 · a missing token is 401 and no store is contacted", async () => {
    const body = { batch: [{ event: "$pageview", distinct_id: "no-token", properties: {} }] };
    const response = await fetchApp(worker, await jsRequest(body, "gzip"), withoutStores());
    expect(response.status).toBe(401);
  });

  it("intake-03 · the same batch sent twice is stored once", async () => {
    const project = await seedProject();
    const body = jsBatch(project.token, [{ event: "$pageview", distinctId: "retry-1" }]);
    const first = await capture(await jsRequest(body, "gzip"));
    expect(first.status).toBe(200);
    const second = await capture(await jsRequest(body, "gzip"));
    expect(second.status).toBe(200);
    expect(await storedEvents(project.id)).toHaveLength(1);
  });

  it("intake-04 · an over-long name and properties are clipped and the event is stored", async () => {
    const project = await seedProject();
    const longName = "n".repeat(CLIP.eventName + 500);
    const longValue = "a".repeat(CLIP.stringValue + 500);
    const body = jsBatch(project.token, [
      {
        event: longName,
        distinctId: "clip-1",
        properties: { long: longValue, keep: "value" },
      },
    ]);
    const response = await capture(await jsRequest(body, "gzip"));
    expect(response.status).toBe(200);
    const [event] = await storedEvents(project.id);
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(encoder.encode(event.event).byteLength).toBeLessThanOrEqual(CLIP.eventName);
    const parsed: unknown = JSON.parse(event.propertiesText);
    expect(isJsonObject(parsed)).toBe(true);
    if (!isJsonObject(parsed)) return;
    expect(parsed.keep).toBe("value");
    const long = parsed.long;
    expect(typeof long).toBe("string");
    if (typeof long !== "string") return;
    expect(encoder.encode(long).byteLength).toBeLessThanOrEqual(CLIP.stringValue);
  });

  it("intake-05 · an event body over the cap is 413 and nothing is stored", async () => {
    const bytes = new Uint8Array(BODY_LIMITS.eventBytes + 1).fill(0x20);
    const response = await fetchApp(
      worker,
      rawRequest(bytes, { "content-type": "application/json" }),
      withoutStores(),
    );
    expect(response.status).toBe(413);
  });

  it("intake-06 · a server event with $process_person_profile false is stored with no person", async () => {
    const project = await seedProject();
    const node = await capture(
      await nodeRequest(
        nodeBatch(project.token, [
          {
            event: "job",
            distinctId: "job-1",
            properties: { $process_person_profile: false },
          },
        ]),
      ),
    );
    expect(node.status).toBe(200);
    const handBuilt = await capture(
      handBuiltRequest(handBuiltEvent(project.token, { event: "page_view", distinctId: "job-2" })),
    );
    expect(handBuilt.status).toBe(200);
    const events = await storedEvents(project.id);
    expect(events).toHaveLength(2);
    for (const event of events) expect(event.personId).toBeNull();
    expect(await storedPersons(project.id)).toEqual([]);
  });

  it("intake-07 · no address from the request is stored anywhere", async () => {
    const project = await seedProject();
    const forwarded = "198.51.100.9";
    const realIp = "198.51.100.8";
    const ipProperty = "198.51.100.7";
    const body = jsBatch(project.token, [
      { event: "$pageview", distinctId: "ip-1", properties: { $ip: ipProperty } },
    ]);
    const request = await jsRequest(body, "gzip", {
      ip: CLIENT_IP,
      headers: { "x-forwarded-for": forwarded, "x-real-ip": realIp },
    });
    const response = await capture(request);
    expect(response.status).toBe(200);
    expect(await storedEvents(project.id)).toHaveLength(1);
    const text = await storeText(project.id);
    for (const address of [CLIENT_IP, forwarded, realIp, ipProperty]) {
      expect(text).not.toContain(address);
    }
  });

  it("intake-09 · two batches at once one below the cap store exactly one more event", async () => {
    const project = await seedProject({ settings: { daily_event_cap: 5 } });
    const warm = await capture(
      await jsRequest(
        jsBatch(
          project.token,
          [0, 1, 2, 3].map((index) => ({ event: "$pageview", distinctId: `warm-${index}` })),
        ),
        "gzip",
      ),
    );
    expect(warm.status).toBe(200);
    const [first, second] = await Promise.all([
      jsRequest(
        jsBatch(project.token, [{ event: "$pageview", distinctId: "race-1" }]),
        "gzip",
      ).then((request) => capture(request)),
      jsRequest(
        jsBatch(project.token, [{ event: "$pageview", distinctId: "race-2" }]),
        "gzip",
      ).then((request) => capture(request)),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const answers = [await answerJson(first), await answerJson(second)];
    const limited = answers.filter(
      (answer) => isJsonObject(answer) && Array.isArray(answer.quota_limited),
    );
    expect(limited).toEqual([{ status: 1, quota_limited: ["events"] }]);
    expect(await storedEvents(project.id)).toHaveLength(5);
  });

  it("intake-10 · gzip is decoded from its first bytes and from its label, for node and iOS", async () => {
    const project = await seedProject();
    const browser = await capture(
      await jsRequest(
        jsBatch(project.token, [{ event: "$pageview", distinctId: "browser-gzip" }]),
        "gzip",
      ),
    );
    expect(browser.status).toBe(200);
    const node = await capture(
      await nodeRequest(
        nodeBatch(project.token, [{ event: "$pageview", distinctId: "node-gzip" }]),
      ),
    );
    expect(node.status).toBe(200);
    const ios = await capture(
      await iosRequest(iosBatch(project.token, [{ event: "$pageview", distinctId: "ios-gzip" }])),
    );
    expect(ios.status).toBe(200);
    expect(await storedEvents(project.id)).toHaveLength(3);
  });

  it("intake-11 · the base64 form body is stored, standard or URL-safe, plain or gzipped inside", async () => {
    const project = await seedProject();
    for (const encoding of ["base64", "base64-url-safe"] as const) {
      const response = await capture(
        await jsRequest(
          jsBatch(project.token, [{ event: "$pageview", distinctId: `form-${encoding}` }]),
          encoding,
        ),
      );
      expect(response.status).toBe(200);
    }
    for (const urlSafe of [false, true]) {
      const body = jsBatch(project.token, [
        { event: "$pageview", distinctId: `form-gzip-${urlSafe}` },
      ]);
      const request = rawRequest(
        base64Form(await gzip(jsonBytes(body)), urlSafe),
        { "content-type": "application/x-www-form-urlencoded" },
        { query: { compression: "base64" } },
      );
      const response = await capture(request);
      expect(response.status).toBe(200);
    }
    expect(await storedEvents(project.id)).toHaveLength(4);
  });

  it("intake-12 · a preflight on every capture path mirrors the origin and echoes the request", async () => {
    const responses = await Promise.all(
      CAPTURE_PATHS.map((path) => capture(preflightRequest(path))),
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
      expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
      expect(response.headers.get("access-control-allow-headers")).toBe("content-type");
      expect(response.headers.get("access-control-max-age")).toBe("86400");
      expect(response.headers.get("vary")).toBe("Origin");
    }
  });

  it("intake-12 · 200, 401 and 413 answers on a capture path all carry the CORS headers", async () => {
    const project = await seedProject();
    const accepted = await capture(
      await jsRequest(
        jsBatch(project.token, [{ event: "$pageview", distinctId: "cors-ok" }]),
        "gzip",
      ),
    );
    expect(accepted.status).toBe(200);
    expectCors(accepted, ORIGIN);
    const rejected = await capture(
      await jsRequest(
        jsBatch(newToken(), [{ event: "$pageview", distinctId: "cors-401" }]),
        "gzip",
      ),
    );
    expect(rejected.status).toBe(401);
    expectCors(rejected, ORIGIN);
    const oversized = await capture(
      rawRequest(new Uint8Array(BODY_LIMITS.eventBytes + 1).fill(0x20), {
        "content-type": "application/json",
      }),
    );
    expect(oversized.status).toBe(413);
    expectCors(oversized, ORIGIN);
  });

  it("intake-12 · with no Origin, or an origin that is not a URL, the POST is still accepted", async () => {
    const project = await seedProject();
    const preflight = await capture(preflightRequest("/e/", null));
    expect(preflight.status).toBe(200);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    const noOrigin = await capture(
      await jsRequest(
        jsBatch(project.token, [{ event: "$pageview", distinctId: "no-origin" }]),
        "gzip",
        { origin: null },
      ),
    );
    expect(noOrigin.status).toBe(200);
    expect(noOrigin.headers.get("access-control-allow-origin")).toBeNull();
    const oddOrigin = await capture(
      await jsRequest(
        jsBatch(project.token, [{ event: "$pageview", distinctId: "odd-origin" }]),
        "gzip",
        { origin: "null" },
      ),
    );
    expect(oddOrigin.status).toBe(200);
    expect(oddOrigin.headers.get("access-control-allow-origin")).toBeNull();
    expect(await storedEvents(project.id)).toHaveLength(2);
  });

  it("intake-15 · every capture path stores the batch and answers 200 with {status:1}, never a redirect", async () => {
    const project = await seedProject();
    for (const [index, path] of CAPTURE_PATHS.entries()) {
      const response = await capture(
        await jsRequest(
          jsBatch(project.token, [{ event: "$pageview", distinctId: `path-${index}` }]),
          "gzip",
          { path },
        ),
      );
      expect(response.status).toBe(200);
      expect(await answerJson(response)).toEqual({ status: 1 });
    }
    const events = await storedEvents(project.id);
    expect(events.map((event) => event.distinctId)).toEqual(
      CAPTURE_PATHS.map((_path, index) => `path-${index}`),
    );
  });

  it("intake-16 · the hand-built client's single object is one event with no person, and its cookieless form is hashed", async () => {
    const project = await seedProject();
    const single = await capture(
      handBuiltRequest(
        handBuiltEvent(project.token, { event: "page_view", distinctId: "hand-built-1" }),
      ),
    );
    expect(single.status).toBe(200);
    expect(await answerJson(single)).toEqual({ status: 1 });
    const cookieless = await capture(
      handBuiltRequest(
        handBuiltEvent(project.token, {
          event: "$pageview",
          distinctId: COOKIELESS_SENTINEL,
          properties: cookielessProperties(),
        }),
      ),
    );
    expect(cookieless.status).toBe(200);
    const events = await storedEvents(project.id);
    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe("page_view");
    expect(events[0]?.personId).toBeNull();
    expect(events[1]?.distinctId).toMatch(/^cookieless_[0-9a-f]{16}$/);
    expect(events[1]?.properties).toMatchObject({ $cookieless_mode: true });
    expect(await storedPersons(project.id)).toEqual([]);
  });

  it("intake-17 · a GET on every capture path is 405 with nothing stored", async () => {
    for (const path of CAPTURE_PATHS) {
      const response = await fetchApp(
        worker,
        rawRequest(null, {}, { path }, "GET"),
        withoutStores(),
      );
      expect(response.status).toBe(405);
    }
  });

  it("intake-18 · historical migration keeps recent events at their time and drops those past retention", async () => {
    const project = await seedProject({ settings: { events_retention_days: 30 } });
    const body = nodeBatch(
      project.token,
      [
        { event: "$pageview", distinctId: "old-1", timestamp: iso(T0 - 60 * DAY_MS) },
        { event: "$pageview", distinctId: "recent-1", timestamp: iso(T0 - 10 * DAY_MS) },
      ],
      { sentAt: iso(T0), historicalMigration: true },
    );
    const response = await fetchApp(
      captureApp(() => T0),
      await nodeRequest(body),
    );
    expect(response.status).toBe(200);
    expect(await answerJson(response)).toEqual({ status: 1 });
    const events = await storedEvents(project.id);
    expect(events.map((event) => event.distinctId)).toEqual(["recent-1"]);
    expect(events[0]?.ts).toBe(T0 - 10 * DAY_MS);
  });

  it("intake-21 · the project is resolved from api_key, from properties.token, or from both", async () => {
    const project = await seedProject();
    const wrapperOnly = await capture(
      await nodeRequest(
        nodeBatch(project.token, [{ event: "$pageview", distinctId: "wrapper-only" }]),
      ),
    );
    expect(wrapperOnly.status).toBe(200);
    const propertiesOnly = await capture(
      await jsRequest(
        {
          batch: [jsEvent(project.token, { event: "$pageview", distinctId: "properties-only" })],
          sent_at: iso(Date.now()),
        },
        "gzip",
      ),
    );
    expect(propertiesOnly.status).toBe(200);
    const both = await capture(
      await jsRequest(jsBatch(project.token, [{ event: "$pageview", distinctId: "both" }]), "gzip"),
    );
    expect(both.status).toBe(200);
    expect((await storedEvents(project.id)).map((event) => event.distinctId)).toEqual([
      "wrapper-only",
      "properties-only",
      "both",
    ]);
  });

  it("intake-22 · an event whose own token belongs to another project is stored nowhere", async () => {
    const projectA = await seedProject();
    const projectB = await seedProject();
    const body = {
      api_key: projectA.token,
      batch: [
        jsEvent(projectA.token, { event: "$pageview", distinctId: "a-1" }),
        jsEvent(projectB.token, { event: "$pageview", distinctId: "b-1" }),
      ],
      sent_at: iso(Date.now()),
    };
    const response = await capture(await jsRequest(body, "gzip"));
    expect(response.status).toBe(200);
    expect((await storedEvents(projectA.id)).map((event) => event.distinctId)).toEqual(["a-1"]);
    expect(await wasContacted(projectB.id)).toBe(false);
  });

  it("intake-23 · an uncompressed JSON body is stored after its preflight", async () => {
    const project = await seedProject();
    const preflight = await capture(preflightRequest("/e/"));
    expect(preflight.status).toBe(200);
    const response = await capture(
      await jsRequest(
        jsBatch(project.token, [{ event: "$pageview", distinctId: "json-1" }]),
        "json",
      ),
    );
    expect(response.status).toBe(200);
    expect(await storedEvents(project.id)).toHaveLength(1);
  });

  it("intake-24 · every unreadable body is 400 before the registry or a store is touched", async () => {
    const unreadable = [
      rawRequest(Uint8Array.from([0x1f, 0x8b, 0xff, 0x00, 0x01]), { "content-type": "text/plain" }),
      rawRequest("compression=base64", { "content-type": "application/x-www-form-urlencoded" }),
      rawRequest("data=!!!not-base64!!!", {
        "content-type": "application/x-www-form-urlencoded",
      }),
      rawRequest(new Uint8Array(0), { "content-type": "application/json" }),
      rawRequest(encoder.encode('"hello"'), { "content-type": "application/json" }),
      rawRequest(encoder.encode("7"), { "content-type": "application/json" }),
    ];
    for (const request of unreadable) {
      const response = await fetchApp(worker, request, {
        ...withoutStores(),
        REGISTRY: env.UNMIGRATED_REGISTRY,
      });
      expect(response.status).toBe(400);
    }
  });

  it("intake-25 · an uncompressed JSON request over the cap is 413 with nothing contacted", async () => {
    const bytes = new Uint8Array(BODY_LIMITS.eventBytes + 1).fill(0x20);
    const response = await fetchApp(
      worker,
      rawRequest(bytes, {
        "content-type": "application/json",
        "content-length": String(bytes.byteLength),
      }),
      withoutStores(),
    );
    expect(response.status).toBe(413);
  });

  it("intake-25 · a gzip or base64 body that decodes over the cap is 413", async () => {
    const over = new Uint8Array(BODY_LIMITS.eventBytes + 1).fill(0x61);
    const gzipped = await fetchApp(
      worker,
      rawRequest(await gzip(over), {
        "content-type": "application/json",
        "content-encoding": "gzip",
      }),
      withoutStores(),
    );
    expect(gzipped.status).toBe(413);
    const form = await fetchApp(
      worker,
      rawRequest(
        base64Form(await gzip(over)),
        { "content-type": "application/x-www-form-urlencoded" },
        { query: { compression: "base64" } },
      ),
      withoutStores(),
    );
    expect(form.status).toBe(413);
  });

  it("intake-28 · a failing registry is 503 with no store contacted, and the retry stores the batch", async () => {
    const project = await seedProject();
    const body = jsBatch(project.token, [
      { event: "$pageview", distinctId: "registry-down" },
      { event: "signup", distinctId: "registry-down" },
    ]);
    const failed = await fetchApp(worker, await jsRequest(body, "gzip"), {
      ...env,
      REGISTRY: env.UNMIGRATED_REGISTRY,
    });
    expect(failed.status).toBe(503);
    expect(await wasContacted(project.id)).toBe(false);
    const retried = await capture(await jsRequest(body, "gzip"));
    expect(retried.status).toBe(200);
    expect(await storedEvents(project.id)).toHaveLength(2);
  });

  it("intake-28 · a store that cannot serve is 503 with nothing stored, and the retry stores the whole batch", async () => {
    const project = await seedProject();
    const stub = storeOf(project.id);
    await stub.ready();
    await runInDurableObject(stub, (_instance, state) =>
      applySteps(state.storage, [
        { number: 1, sql: "SELECT 1" },
        { number: 2, sql: "SELECT 1" },
      ]),
    );
    await evictDurableObject(stub);
    const body = jsBatch(project.token, [
      { event: "$pageview", distinctId: "store-down" },
      { event: "signup", distinctId: "store-down" },
    ]);
    const failed = await capture(await jsRequest(body, "gzip"));
    expect(failed.status).toBe(503);
    expect(await storedEvents(project.id)).toEqual([]);
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAll());
    await evictDurableObject(stub);
    const retried = await capture(await jsRequest(body, "gzip"));
    expect(retried.status).toBe(200);
    expect((await storedEvents(project.id)).map((event) => event.event)).toEqual([
      "$pageview",
      "signup",
    ]);
  });

  it("intake-29 · faulty events are dropped beside the good ones and the answer is still 200", async () => {
    const project = await seedProject();
    const body = {
      api_key: project.token,
      batch: [
        jsEvent(project.token, { event: "$pageview", distinctId: "good-1" }),
        { distinct_id: "no-name" },
        { event: "", distinct_id: "empty-name" },
        { event: "$pageview" },
        { event: "$pageview", distinct_id: "" },
        { event: "$pageview", distinct_id: { nested: 1 } },
        { event: "$pageview", distinct_id: "bad-properties", properties: "nope" },
        { event: "$pageview", distinct_id: "d".repeat(DISTINCT_ID_MAX + 1) },
        "not an object",
        jsEvent(project.token, { event: "signup", distinctId: "good-2" }),
      ],
      sent_at: iso(Date.now()),
    };
    const response = await capture(await jsRequest(body, "gzip"));
    expect(response.status).toBe(200);
    expect(await answerJson(response)).toEqual({ status: 1 });
    expect((await storedEvents(project.id)).map((event) => event.distinctId)).toEqual([
      "good-1",
      "good-2",
    ]);
  });

  it("intake-30 · a batch of only $exception at the cap answers exceptionEvent", async () => {
    const project = await seedProject({ settings: { daily_event_cap: 1 } });
    const warm = await capture(
      await jsRequest(
        jsBatch(project.token, [{ event: "$pageview", distinctId: "cap-1" }]),
        "gzip",
      ),
    );
    expect(warm.status).toBe(200);
    const exceptions = await capture(
      await jsRequest(
        jsBatch(project.token, [
          { event: "$exception", distinctId: "cap-1" },
          { event: "$exception", distinctId: "cap-1" },
        ]),
        "gzip",
      ),
    );
    expect(exceptions.status).toBe(200);
    expect(await answerJson(exceptions)).toEqual({
      status: 1,
      quota_limited: ["exceptionEvent"],
    });
    expect(await storedEvents(project.id)).toHaveLength(1);
  });

  it("intake-31 · two identical events with no uuid are both stored under different ids", async () => {
    const project = await seedProject();
    const timestamp = iso(Date.now());
    const body = nodeBatch(project.token, [
      { event: "$pageview", distinctId: "no-uuid", uuid: null, timestamp },
      { event: "$pageview", distinctId: "no-uuid", uuid: null, timestamp },
    ]);
    const response = await capture(await nodeRequest(body));
    expect(response.status).toBe(200);
    const events = await storedEvents(project.id);
    expect(events).toHaveLength(2);
    expect(events[0]?.uuid).toMatch(UUID_V7);
    expect(events[1]?.uuid).toMatch(UUID_V7);
    expect(events[0]?.uuid).not.toBe(events[1]?.uuid);
  });

  it("intake-32 · an event name holding SQL is stored and read back exactly", async () => {
    const project = await seedProject();
    const name = "contact'); DROP TABLE events;--";
    const response = await capture(
      await jsRequest(jsBatch(project.token, [{ event: name, distinctId: "sql-1" }]), "gzip"),
    );
    expect(response.status).toBe(200);
    const [event] = await storedEvents(project.id);
    expect(event?.event).toBe(name);
  });

  it("intake-37 · received_at is the Worker's clock, never a field of the request", async () => {
    const project = await seedProject();
    const body = jsBatch(project.token, [
      {
        event: "$pageview",
        distinctId: "clock-1",
        properties: { received_at: T0 - DAY_MS },
      },
    ]);
    const request = await jsRequest(body, "gzip", {
      headers: { "x-received-at": String(T0 - DAY_MS) },
    });
    const response = await fetchApp(
      captureApp(() => T0),
      request,
    );
    expect(response.status).toBe(200);
    const [event] = await storedEvents(project.id);
    expect(event?.receivedAt).toBe(T0);
  });
});
