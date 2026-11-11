import type { JsonObject } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import {
  answerJson,
  BROWSER_UA,
  COOKIELESS_SENTINEL,
  capture,
  cookielessProperties,
  inStore,
  iso,
  jsBatch,
  jsRequest,
  storedEvents,
  storeText,
  type Transport,
} from "../../../test/helpers/capture.ts";
import { seedProject } from "../../../test/helpers/registry.ts";

// What a cookieless visitor's SDK sees and what reaches the store, through the
// real Worker (cookieless-03, -08, -14, -16, -17). Each batch carries one fixed
// event time, so a run across midnight changes no id.

it("cookieless-03 · a cookieless $identify and $create_alias are dropped, the rest is stored", async () => {
  const project = await seedProject();
  const body = jsBatch(project.token, [
    { event: "$identify", distinctId: COOKIELESS_SENTINEL, properties: cookielessProperties() },
    {
      event: "$create_alias",
      distinctId: COOKIELESS_SENTINEL,
      properties: cookielessProperties("www.example.com", BROWSER_UA, { alias: "alias-1" }),
    },
    { event: "$pageview", distinctId: COOKIELESS_SENTINEL, properties: cookielessProperties() },
  ]);

  const response = await capture(await jsRequest(body, "json"));
  expect(response.status).toBe(200);
  expect(await answerJson(response)).toEqual({ status: 1 });

  const events = await storedEvents(project.id);
  expect(events.map((event) => event.event)).toEqual(["$pageview"]);
  expect(events[0]?.distinctId).toMatch(/^cookieless_[0-9a-f]{16}$/);
});

it("cookieless-08 · the hash reads $raw_user_agent first and the User-Agent header otherwise", async () => {
  const project = await seedProject();
  const at = Date.now();
  const host = "www.example.com";
  const otherAgent = "AnotherAgent/1.0";

  const send = async (properties: JsonObject, userAgent: string) => {
    const body = jsBatch(project.token, [
      { event: "$pageview", distinctId: COOKIELESS_SENTINEL, timestamp: iso(at), properties },
    ]);
    const response = await capture(await jsRequest(body, "json", { userAgent }));
    expect(response.status).toBe(200);
  };

  // The event's own agent wins over a header that disagrees with it.
  await send(cookielessProperties(host, BROWSER_UA), otherAgent);
  // With no $raw_user_agent the header is the agent.
  await send({ $cookieless_mode: true, $host: host }, BROWSER_UA);
  await send({ $cookieless_mode: true, $host: host }, otherAgent);

  const ids = (await storedEvents(project.id)).map((event) => event.distinctId);
  expect(ids).toHaveLength(3);
  expect(ids[0]).toBe(ids[1]);
  expect(ids[2]).not.toBe(ids[0]);
});

it("cookieless-14 · the sentinel without $cookieless_mode is dropped, the answer is 200", async () => {
  const project = await seedProject();
  const body = jsBatch(project.token, [
    {
      event: "$pageview",
      distinctId: COOKIELESS_SENTINEL,
      properties: { $host: "www.example.com" },
    },
    { event: "$pageview", distinctId: "user-1", properties: {} },
  ]);

  const response = await capture(await jsRequest(body, "json"));
  expect(response.status).toBe(200);
  expect(await answerJson(response)).toEqual({ status: 1 });

  const events = await storedEvents(project.id);
  expect(events.map((event) => event.distinctId)).toEqual(["user-1"]);
  expect(await storeText(project.id)).not.toContain(COOKIELESS_SENTINEL);
});

it("cookieless-16 · the hash uses CF-Connecting-IP only, and a missing one drops the event", async () => {
  const project = await seedProject();
  const at = Date.now();

  const send = async (transport: Transport) => {
    const body = jsBatch(project.token, [
      {
        event: "$pageview",
        distinctId: COOKIELESS_SENTINEL,
        timestamp: iso(at),
        properties: cookielessProperties(),
      },
    ]);
    const response = await capture(await jsRequest(body, "json", transport));
    expect(response.status).toBe(200);
  };

  await send({});
  await send({ headers: { "x-forwarded-for": "198.51.100.9", "x-real-ip": "198.51.100.10" } });
  await send({ ip: "198.51.100.11" });
  await send({ ip: null });

  const events = await storedEvents(project.id);
  expect(events).toHaveLength(3);
  expect(events[1]?.distinctId).toBe(events[0]?.distinctId);
  expect(events[2]?.distinctId).not.toBe(events[0]?.distinctId);
});

it("cookieless-17 · a salt that cannot be read answers 503 and stores nothing", async () => {
  const project = await seedProject();
  await inStore(project.id, (sql) => {
    sql.exec("DROP TABLE cookieless_sessions");
    sql.exec("DROP TABLE salts");
  });

  const body = jsBatch(project.token, [
    { event: "$pageview", distinctId: COOKIELESS_SENTINEL, properties: cookielessProperties() },
  ]);
  const response = await capture(await jsRequest(body, "json"));
  expect(response.status).toBe(503);
  expect(await storedEvents(project.id)).toEqual([]);
});
