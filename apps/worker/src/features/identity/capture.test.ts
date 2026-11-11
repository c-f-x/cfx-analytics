import { describe, expect, it } from "vitest";
import {
  capture,
  iosBatch,
  iosRequest,
  jsBatch,
  jsRequest,
  nodeBatch,
  nodeRequest,
  storedEvents,
  storedPersons,
  storeRows,
} from "../../../test/helpers/capture.ts";
import { seedProject } from "../../../test/helpers/registry.ts";

// What the SDKs' identity calls do through a capture path (identity-01,
// identity-04, identity-06, identity-08 to identity-10, identity-16,
// identity-17). Each test sends a real SDK-shaped body with its own project,
// then reads what the project's store holds.

describe("an identify through a capture path", () => {
  it("identity-01 · node's $identify with $set joins its anonymous id and their earlier events", async () => {
    const project = await seedProject();
    const body = nodeBatch(project.token, [
      { event: "$pageview", distinctId: "anon-node" },
      {
        event: "$identify",
        distinctId: "user-node",
        set: { plan: "pro" },
        properties: { $anon_distinct_id: "anon-node" },
      },
    ]);
    expect((await capture(await nodeRequest(body))).status).toBe(200);

    const persons = await storedPersons(project.id);
    expect(persons).toHaveLength(1);
    expect(persons[0]?.distinctIds).toEqual(["anon-node", "user-node"]);
    expect(persons[0]?.identified).toBe(true);
    expect(persons[0]?.properties).toEqual({ plan: "pro" });

    const events = await storedEvents(project.id);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.personId === persons[0]?.id)).toBe(true);
  });

  it("identity-01 · iOS's identify with reuseAnonymousId identifies the id it already has", async () => {
    const project = await seedProject();
    const body = iosBatch(project.token, [
      { event: "$screen", distinctId: "ios-user", properties: { $screen_name: "Home" } },
      { event: "$identify", distinctId: "ios-user", set: { plan: "pro" } },
    ]);
    expect((await capture(await iosRequest(body))).status).toBe(200);

    const persons = await storedPersons(project.id);
    expect(persons).toHaveLength(1);
    expect(persons[0]?.distinctIds).toEqual(["ios-user"]);
    expect(persons[0]?.identified).toBe(true);
    expect(persons[0]?.properties).toEqual({ plan: "pro" });

    const events = await storedEvents(project.id);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.personId === persons[0]?.id)).toBe(true);
  });
});

describe("person processing off", () => {
  it("identity-04 · a posthog-js event with a top-level $set and no person processing makes no person", async () => {
    const project = await seedProject();
    const body = jsBatch(project.token, [
      {
        event: "$set",
        distinctId: "anon-js",
        set: { plan: "pro" },
        properties: { $process_person_profile: false },
      },
    ]);
    expect((await capture(await jsRequest(body))).status).toBe(200);

    const events = await storedEvents(project.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.personId).toBeNull();
    expect(await storedPersons(project.id)).toEqual([]);
  });
});

describe("an event with no person flag", () => {
  it("identity-06 · it counts as true and a person is made", async () => {
    const project = await seedProject();
    const body = jsBatch(project.token, [{ event: "$pageview", distinctId: "visitor-1" }]);
    expect((await capture(await jsRequest(body))).status).toBe(200);

    const persons = await storedPersons(project.id);
    expect(persons).toHaveLength(1);
    expect(persons[0]?.distinctIds).toEqual(["visitor-1"]);
    expect(persons[0]?.identified).toBe(false);

    const events = await storedEvents(project.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.personId).toBe(persons[0]?.id);
  });
});

describe("$unset through a capture path", () => {
  it("identity-08 · a top-level $unset and a properties.$unset both remove their keys", async () => {
    const project = await seedProject();
    const body = jsBatch(project.token, [
      { event: "$set", distinctId: "top-level", set: { plan: "pro", beta: true } },
      { event: "$set", distinctId: "top-level", unset: ["plan"] },
      { event: "$set", distinctId: "in-properties", set: { plan: "pro", beta: true } },
      {
        event: "$set",
        distinctId: "in-properties",
        properties: { $unset: ["beta"] },
      },
    ]);
    expect((await capture(await jsRequest(body))).status).toBe(200);

    const persons = await storedPersons(project.id);
    expect(persons).toHaveLength(2);
    const topLevel = persons.find((person) => person.distinctIds.includes("top-level"));
    const inProperties = persons.find((person) => person.distinctIds.includes("in-properties"));
    expect(topLevel?.properties).toEqual({ beta: true });
    expect(inProperties?.properties).toEqual({ plan: "pro" });
  });
});

describe("$set in both places", () => {
  it("identity-09 · the top-level $set wins key by key", async () => {
    const project = await seedProject();
    const body = jsBatch(project.token, [
      {
        event: "$set",
        distinctId: "both",
        set: { plan: "top" },
        properties: { $set: { plan: "props", country: "NO" } },
      },
    ]);
    expect((await capture(await jsRequest(body))).status).toBe(200);

    const persons = await storedPersons(project.id);
    expect(persons).toHaveLength(1);
    expect(persons[0]?.properties).toEqual({ plan: "top", country: "NO" });
  });
});

describe("node's identify person operations", () => {
  it("identity-10 · properties.$set and properties.$set_once are each applied as its key says", async () => {
    const project = await seedProject();
    const body = nodeBatch(project.token, [
      {
        event: "$identify",
        distinctId: "node-user",
        set: { plan: "pro" },
        setOnce: { first_seen: "2026-10-01" },
      },
    ]);
    expect((await capture(await nodeRequest(body))).status).toBe(200);

    const persons = await storedPersons(project.id);
    expect(persons).toHaveLength(1);
    expect(persons[0]?.identified).toBe(true);
    expect(persons[0]?.properties).toEqual({ plan: "pro", first_seen: "2026-10-01" });
    expect(persons[0]?.propertyTimes).toEqual({
      plan: { ts: expect.any(Number), once: false },
      first_seen: { ts: expect.any(Number), once: true },
    });
  });
});

describe("groups", () => {
  it("identity-16 · $groupidentify is an ordinary event and makes no group table", async () => {
    const project = await seedProject();
    const body = jsBatch(project.token, [
      {
        event: "$groupidentify",
        distinctId: "visitor-1",
        properties: {
          $group_type: "company",
          $group_key: "acme",
          $group_set: { name: "Acme" },
        },
      },
      { event: "$pageview", distinctId: "visitor-1" },
    ]);
    expect((await capture(await jsRequest(body))).status).toBe(200);

    const events = await storedEvents(project.id);
    expect(events.map((event) => event.event)).toEqual(["$groupidentify", "$pageview"]);
    expect(events[0]?.properties).toMatchObject({
      $group_type: "company",
      $group_key: "acme",
      $group_set: { name: "Acme" },
    });

    const tables = await storeRows(
      project.id,
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const names = tables
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string");
    expect(names.filter((name) => name.toLowerCase().includes("group"))).toEqual([]);
  });

  it("identity-17 · $groups stays an event property and joins nothing", async () => {
    const project = await seedProject();
    const body = jsBatch(project.token, [
      {
        event: "$pageview",
        distinctId: "visitor-1",
        properties: { $groups: { company: "acme" } },
      },
    ]);
    expect((await capture(await jsRequest(body))).status).toBe(200);

    const events = await storedEvents(project.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.properties).toMatchObject({ $groups: { company: "acme" } });

    const persons = await storedPersons(project.id);
    expect(persons).toHaveLength(1);
    expect(persons[0]?.properties).toEqual({});
  });
});
