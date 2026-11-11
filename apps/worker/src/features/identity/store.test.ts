import { describe, expect, it } from "vitest";
import {
  HOUR_MS,
  inStore,
  MINUTE_MS,
  storedPersons,
  storeRows,
  T0,
} from "../../../test/helpers/capture.ts";
import { newProjectId } from "../../../test/helpers/registry.ts";
import { type ResolveInput, resolvePerson } from "./store.ts";

// resolvePerson against a real ProjectStore's `persons` and
// `person_distinct_ids` tables (identity-04 to identity-08, identity-12,
// identity-14, identity-19). Each test makes its own store, and every event
// time arrives as a value.

/** One event for resolvePerson, an ordinary pageview at T0 unless overridden. */
function event(overrides: Partial<ResolveInput> = {}): ResolveInput {
  return {
    event: "$pageview",
    distinctId: "user-1",
    ts: T0,
    processPerson: true,
    anonDistinctId: null,
    alias: null,
    set: {},
    setOnce: {},
    unset: [],
    ...overrides,
  };
}

describe("an event with no person processing", () => {
  it("identity-04 · processPerson false answers no person, makes none and ignores $set", async () => {
    const projectId = newProjectId();
    const resolved = await inStore(projectId, (sql) =>
      resolvePerson(sql, event({ processPerson: false, set: { plan: "pro" } })),
    );
    expect(resolved).toEqual({ personId: null, changes: [] });
    expect(await storedPersons(projectId)).toEqual([]);
    expect(await storeRows(projectId, "SELECT * FROM person_distinct_ids")).toEqual([]);
  });
});

describe("person properties over time", () => {
  it("identity-05 · two $set events in either order leave the later event's value", async () => {
    const projectId = newProjectId();
    await inStore(projectId, (sql) => {
      resolvePerson(sql, event({ distinctId: "early-first", ts: T0, set: { plan: "free" } }));
      resolvePerson(
        sql,
        event({ distinctId: "early-first", ts: T0 + HOUR_MS, set: { plan: "team" } }),
      );
      resolvePerson(
        sql,
        event({ distinctId: "late-first", ts: T0 + HOUR_MS, set: { plan: "team" } }),
      );
      resolvePerson(sql, event({ distinctId: "late-first", ts: T0, set: { plan: "free" } }));
    });
    const persons = await storedPersons(projectId);
    expect(persons).toHaveLength(2);
    for (const person of persons) {
      expect(person.properties).toEqual({ plan: "team" });
      expect(person.propertyTimes).toEqual({ plan: { ts: T0 + HOUR_MS, once: false } });
    }
  });

  it("identity-07 · $set_once in either order keeps the earliest event's value", async () => {
    const projectId = newProjectId();
    await inStore(projectId, (sql) => {
      resolvePerson(sql, event({ distinctId: "early-first", ts: T0, setOnce: { plan: "free" } }));
      resolvePerson(
        sql,
        event({ distinctId: "early-first", ts: T0 + HOUR_MS, setOnce: { plan: "team" } }),
      );
      resolvePerson(
        sql,
        event({ distinctId: "late-first", ts: T0 + HOUR_MS, setOnce: { plan: "team" } }),
      );
      resolvePerson(sql, event({ distinctId: "late-first", ts: T0, setOnce: { plan: "free" } }));
    });
    const persons = await storedPersons(projectId);
    expect(persons).toHaveLength(2);
    for (const person of persons) {
      expect(person.properties).toEqual({ plan: "free" });
      expect(person.propertyTimes).toEqual({ plan: { ts: T0, once: true } });
    }
  });
});

describe("making a person", () => {
  it("identity-06 · resolvePerson makes the person its distinct id has none of", async () => {
    const projectId = newProjectId();
    const resolved = await inStore(projectId, (sql) =>
      resolvePerson(sql, event({ distinctId: "visitor-1", ts: T0 + MINUTE_MS })),
    );
    const persons = await storedPersons(projectId);
    expect(persons).toHaveLength(1);
    const person = persons[0];
    expect(person?.createdAt).toBe(T0 + MINUTE_MS);
    expect(person?.identified).toBe(false);
    expect(person?.properties).toEqual({});
    expect(person?.propertyTimes).toEqual({});
    expect(person?.distinctIds).toEqual(["visitor-1"]);
    expect(resolved).toEqual({
      personId: person?.id,
      changes: [{ kind: "link", distinctId: "visitor-1", personId: person?.id }],
    });
  });
});

describe("aliases", () => {
  it("identity-12 · an alias joins b to a, and a chain a to b to c gives one person", async () => {
    const single = newProjectId();
    await inStore(single, (sql) =>
      resolvePerson(sql, event({ event: "$create_alias", distinctId: "a", alias: "b" })),
    );
    const aliased = await storedPersons(single);
    expect(aliased).toHaveLength(1);
    expect(aliased[0]?.distinctIds).toEqual(["a", "b"]);

    const chain = newProjectId();
    await inStore(chain, (sql) => {
      resolvePerson(sql, event({ event: "$create_alias", distinctId: "a", alias: "b" }));
      resolvePerson(sql, event({ event: "$create_alias", distinctId: "b", alias: "c" }));
    });
    const chained = await storedPersons(chain);
    expect(chained).toHaveLength(1);
    expect(chained[0]?.distinctIds).toEqual(["a", "b", "c"]);
  });
});

describe("two identified people", () => {
  it("identity-14 · resolvePerson keeps them apart and links nothing", async () => {
    const projectId = newProjectId();
    const resolved = await inStore(projectId, (sql) => {
      resolvePerson(sql, event({ event: "$identify", distinctId: "alice", ts: T0 }));
      resolvePerson(sql, event({ event: "$identify", distinctId: "bob", ts: T0 + MINUTE_MS }));
      return resolvePerson(
        sql,
        event({
          event: "$identify",
          distinctId: "alice",
          anonDistinctId: "bob",
          ts: T0 + HOUR_MS,
          set: { plan: "pro" },
        }),
      );
    });
    expect(resolved.changes).toEqual([]);

    const persons = await storedPersons(projectId);
    expect(persons).toHaveLength(2);
    const alice = persons.find((person) => person.distinctIds.includes("alice"));
    const bob = persons.find((person) => person.distinctIds.includes("bob"));
    expect(resolved.personId).toBe(alice?.id);
    expect(alice?.distinctIds).toEqual(["alice"]);
    expect(alice?.properties).toEqual({ plan: "pro" });
    expect(bob?.distinctIds).toEqual(["bob"]);
    expect(bob?.properties).toEqual({});
  });
});

describe("an identify of one anonymous id", () => {
  it("identity-19 · resolvePerson leaves another anonymous id unlinked", async () => {
    const projectId = newProjectId();
    await inStore(projectId, (sql) => {
      resolvePerson(sql, event({ distinctId: "anon-a", ts: T0 }));
      resolvePerson(sql, event({ distinctId: "anon-b", ts: T0 + MINUTE_MS }));
      resolvePerson(sql, event({ event: "$identify", distinctId: "anon-a", ts: T0 + HOUR_MS }));
    });
    const persons = await storedPersons(projectId);
    expect(persons).toHaveLength(2);
    const a = persons.find((person) => person.distinctIds.includes("anon-a"));
    const b = persons.find((person) => person.distinctIds.includes("anon-b"));
    expect(a?.identified).toBe(true);
    expect(a?.distinctIds).toEqual(["anon-a"]);
    expect(b?.identified).toBe(false);
    expect(b?.distinctIds).toEqual(["anon-b"]);
  });
});
