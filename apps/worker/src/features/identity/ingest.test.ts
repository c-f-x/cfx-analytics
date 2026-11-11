import { describe, expect, it } from "vitest";
import {
  cookielessIncoming,
  HOUR_MS,
  incomingEvent,
  ingestDirect,
  ingestRequest,
  MINUTE_MS,
  storedEvents,
  storedPersons,
  T0,
} from "../../../test/helpers/capture.ts";
import { seedProject } from "../../../test/helpers/registry.ts";

// Identity as one batch in the ProjectStore (identity-01 to identity-03,
// identity-11, identity-13 to identity-15, identity-18, identity-19). Each
// test seeds its own project and passes event times in, so no two tests share
// rows and nothing waits.

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) {
    throw new Error(`expected a value, was refused with ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

const personIdOfEvent = (
  events: { distinctId: string; personId: number | null }[],
  distinctId: string,
): number | null | undefined => events.find((event) => event.distinctId === distinctId)?.personId;

describe("an identify after the anonymous events", () => {
  it("identity-01 · the identify joins both ids and the earlier events count for the person", async () => {
    const project = await seedProject();
    const answer = unwrap(
      await ingestDirect(
        ingestRequest(project.id, [
          incomingEvent({ distinctId: "anon-1", processPerson: false, ts: T0 }),
          incomingEvent({
            distinctId: "anon-1",
            processPerson: false,
            ts: T0 + MINUTE_MS,
          }),
          incomingEvent({
            event: "$identify",
            distinctId: "user-1",
            anonDistinctId: "anon-1",
            set: { plan: "pro" },
            ts: T0 + HOUR_MS,
          }),
        ]),
      ),
    );
    expect(answer.stored).toBe(3);

    const persons = await storedPersons(project.id);
    expect(persons).toHaveLength(1);
    expect(persons[0]?.distinctIds).toEqual(["anon-1", "user-1"]);
    expect(persons[0]?.identified).toBe(true);
    expect(persons[0]?.properties).toEqual({ plan: "pro" });

    const events = await storedEvents(project.id);
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.personId === persons[0]?.id)).toBe(true);
  });
});

describe("two projects with the same distinct id", () => {
  it("identity-02 · an alias in one project links nothing in the other", async () => {
    const first = await seedProject();
    const second = await seedProject();
    unwrap(
      await ingestDirect(
        ingestRequest(first.id, [
          incomingEvent({ distinctId: "1" }),
          incomingEvent({ event: "$create_alias", distinctId: "1", alias: "alias-of-one" }),
        ]),
      ),
    );
    unwrap(await ingestDirect(ingestRequest(second.id, [incomingEvent({ distinctId: "1" })])));

    const personsOfFirst = await storedPersons(first.id);
    expect(personsOfFirst).toHaveLength(1);
    expect(personsOfFirst[0]?.distinctIds).toEqual(["1", "alias-of-one"]);

    const personsOfSecond = await storedPersons(second.id);
    expect(personsOfSecond).toHaveLength(1);
    expect(personsOfSecond[0]?.distinctIds).toEqual(["1"]);
  });
});

describe("an identify before the anonymous events", () => {
  it("identity-03 · later events of either id belong to the identified person", async () => {
    const project = await seedProject();
    unwrap(
      await ingestDirect(
        ingestRequest(project.id, [
          incomingEvent({
            event: "$identify",
            distinctId: "user-1",
            anonDistinctId: "anon-1",
            ts: T0,
          }),
        ]),
      ),
    );
    unwrap(
      await ingestDirect(
        ingestRequest(project.id, [
          incomingEvent({ distinctId: "anon-1", processPerson: false, ts: T0 + MINUTE_MS }),
          incomingEvent({ distinctId: "user-1", ts: T0 + 2 * MINUTE_MS }),
        ]),
      ),
    );

    const persons = await storedPersons(project.id);
    expect(persons).toHaveLength(1);
    expect(persons[0]?.distinctIds).toEqual(["anon-1", "user-1"]);
    const events = await storedEvents(project.id);
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.personId === persons[0]?.id)).toBe(true);
  });
});

describe("an identify of an id that already has events", () => {
  it("identity-11 · the events stay on its person and none is moved", async () => {
    const project = await seedProject();
    unwrap(
      await ingestDirect(
        ingestRequest(project.id, [incomingEvent({ distinctId: "user-1", ts: T0 })]),
      ),
    );
    const before = await storedEvents(project.id);
    expect(before).toHaveLength(1);
    const personId = before[0]?.personId;
    expect(personId).not.toBeNull();

    unwrap(
      await ingestDirect(
        ingestRequest(project.id, [
          incomingEvent({
            event: "$identify",
            distinctId: "user-1",
            set: { plan: "pro" },
            ts: T0 + HOUR_MS,
          }),
        ]),
      ),
    );
    const after = await storedEvents(project.id);
    expect(after).toHaveLength(2);
    expect(after[0]?.personId).toBe(personId);

    const persons = await storedPersons(project.id);
    expect(persons).toHaveLength(1);
    expect(persons[0]?.id).toBe(personId);
    expect(persons[0]?.identified).toBe(true);
    expect(persons[0]?.properties).toEqual({ plan: "pro" });
  });
});

describe("an alias before the events", () => {
  it("identity-13 · the later events of either id join the one person", async () => {
    const project = await seedProject();
    unwrap(
      await ingestDirect(
        ingestRequest(project.id, [
          incomingEvent({ event: "$create_alias", distinctId: "a", alias: "b", ts: T0 }),
        ]),
      ),
    );
    const personsBefore = await storedPersons(project.id);
    expect(personsBefore).toHaveLength(1);
    expect(personsBefore[0]?.distinctIds).toEqual(["a", "b"]);

    unwrap(
      await ingestDirect(
        ingestRequest(project.id, [
          incomingEvent({ distinctId: "a", ts: T0 + MINUTE_MS }),
          incomingEvent({ distinctId: "b", ts: T0 + 2 * MINUTE_MS }),
        ]),
      ),
    );
    const events = await storedEvents(project.id);
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.personId === personsBefore[0]?.id)).toBe(true);
    expect(await storedPersons(project.id)).toHaveLength(1);
  });
});

describe("an identify whose anonymous id is already identified", () => {
  it("identity-14 · the two people stay apart and the event is still stored", async () => {
    const project = await seedProject();
    unwrap(
      await ingestDirect(
        ingestRequest(project.id, [
          incomingEvent({ event: "$identify", distinctId: "alice", ts: T0 }),
          incomingEvent({ event: "$identify", distinctId: "bob", ts: T0 + MINUTE_MS }),
        ]),
      ),
    );
    const answer = unwrap(
      await ingestDirect(
        ingestRequest(project.id, [
          incomingEvent({
            event: "$identify",
            distinctId: "alice",
            anonDistinctId: "bob",
            set: { plan: "pro" },
            ts: T0 + HOUR_MS,
          }),
        ]),
      ),
    );
    expect(answer.stored).toBe(1);

    const persons = await storedPersons(project.id);
    expect(persons).toHaveLength(2);
    expect(persons.map((person) => person.distinctIds)).toEqual([["alice"], ["bob"]]);
    const alice = persons.find((person) => person.distinctIds.includes("alice"));
    expect(alice?.properties).toEqual({ plan: "pro" });

    const events = await storedEvents(project.id);
    expect(events).toHaveLength(3);
    expect(personIdOfEvent(events, "alice")).toBe(alice?.id);
    const bob = persons.find((person) => person.distinctIds.includes("bob"));
    expect(bob?.properties).toEqual({});
  });
});

describe("a new anonymous id after an identify", () => {
  it("identity-15 · it stays apart until a new identify joins it", async () => {
    const project = await seedProject();
    unwrap(
      await ingestDirect(
        ingestRequest(project.id, [
          incomingEvent({ event: "$identify", distinctId: "user-1", ts: T0 }),
          incomingEvent({ distinctId: "anon-2", processPerson: false, ts: T0 + MINUTE_MS }),
        ]),
      ),
    );
    const afterReset = await storedEvents(project.id);
    expect(personIdOfEvent(afterReset, "anon-2")).toBeNull();

    unwrap(
      await ingestDirect(
        ingestRequest(project.id, [
          incomingEvent({
            event: "$identify",
            distinctId: "user-2",
            anonDistinctId: "anon-2",
            ts: T0 + HOUR_MS,
          }),
        ]),
      ),
    );
    const persons = await storedPersons(project.id);
    expect(persons).toHaveLength(2);
    const joined = persons.find((person) => person.distinctIds.includes("anon-2"));
    expect(joined?.distinctIds).toEqual(["anon-2", "user-2"]);
    const afterIdentify = await storedEvents(project.id);
    expect(personIdOfEvent(afterIdentify, "anon-2")).toBe(joined?.id);
    expect(personIdOfEvent(afterIdentify, "anon-2")).not.toBe(
      persons.find((person) => person.distinctIds.includes("user-1"))?.id,
    );
  });
});

describe("the same identify sent twice", () => {
  it("identity-18 · the person is unchanged and one row is stored", async () => {
    const project = await seedProject();
    const identify = incomingEvent({
      event: "$identify",
      distinctId: "user-1",
      set: { plan: "pro" },
      setOnce: { first_seen: "2026-10-01" },
      ts: T0,
    });
    unwrap(await ingestDirect(ingestRequest(project.id, [identify])));
    const personsBefore = await storedPersons(project.id);
    expect(personsBefore).toHaveLength(1);
    expect(personsBefore[0]?.properties).toEqual({ plan: "pro", first_seen: "2026-10-01" });

    const answer = unwrap(await ingestDirect(ingestRequest(project.id, [identify])));
    expect(answer.stored).toBe(0);
    expect(await storedPersons(project.id)).toEqual(personsBefore);
    expect(await storedEvents(project.id)).toHaveLength(1);
  });
});

describe("cookieless events", () => {
  it("identity-19 · a cookieless id never appears in person_distinct_ids", async () => {
    const project = await seedProject();
    const answer = unwrap(
      await ingestDirect(
        ingestRequest(project.id, [
          cookielessIncoming({ ts: T0 }),
          incomingEvent({ distinctId: "user-1", ts: T0 + MINUTE_MS }),
        ]),
      ),
    );
    expect(answer.stored).toBe(2);

    const persons = await storedPersons(project.id);
    expect(persons).toHaveLength(1);
    expect(persons[0]?.distinctIds).toEqual(["user-1"]);

    const events = await storedEvents(project.id);
    const cookieless = events.find((event) => event.distinctId !== "user-1");
    expect(cookieless?.distinctId.startsWith("cookieless_")).toBe(true);
    expect(cookieless?.personId).toBeNull();
  });
});

describe("a merge of two people who both have stored events", () => {
  it("identity-14 · the unidentified person merges into the identified one, and its events move with it", async () => {
    // Events reference their person (events.person_id REFERENCES persons),
    // so the merged person can go only after its events have moved.
    const project = await seedProject();
    unwrap(
      await ingestDirect(
        ingestRequest(project.id, [
          incomingEvent({ distinctId: "anon-1", ts: T0 }),
          incomingEvent({ event: "$identify", distinctId: "user-1", ts: T0 + MINUTE_MS }),
        ]),
      ),
    );
    expect(await storedPersons(project.id)).toHaveLength(2);

    const answer = unwrap(
      await ingestDirect(
        ingestRequest(project.id, [
          incomingEvent({
            event: "$identify",
            distinctId: "user-1",
            anonDistinctId: "anon-1",
            ts: T0 + HOUR_MS,
          }),
        ]),
      ),
    );
    expect(answer.stored).toBe(1);

    const persons = await storedPersons(project.id);
    expect(persons).toHaveLength(1);
    expect(persons[0]?.distinctIds).toEqual(["anon-1", "user-1"]);
    const events = await storedEvents(project.id);
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.personId === persons[0]?.id)).toBe(true);
  });
});
