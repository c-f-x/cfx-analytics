import { DISTINCT_ID_MAX } from "@cfanalytics/shared";
import { describe, expect, it } from "vitest";
import {
  COOKIELESS_SENTINEL,
  cookielessProperties,
  handBuiltEvent,
  iso,
  jsEvent,
  nodeEvent,
  T0,
} from "../../../test/helpers/capture.ts";
import { type Normalized, normalizeBody, type RawEvent } from "./normalize.ts";

// Reading any SDK's body into one event shape (intake-13, intake-16, intake-20,
// intake-21, intake-24, intake-29, intake-34).

const TOKEN = "cfa_pk_testtoken";

const keptEvent = (name: string) => nodeEvent({ event: name, distinctId: `u-${name}` });

function normalized(result: ReturnType<typeof normalizeBody>): Normalized {
  if (!result.ok) throw new Error(`expected events, got ${result.error}`);
  return result.value;
}

function firstEvent(result: ReturnType<typeof normalizeBody>): RawEvent {
  const [event] = normalized(result).events;
  if (event === undefined) throw new Error("expected at least one event");
  return event;
}

describe("normalizeBody", () => {
  it("intake-13 · distinct_id and $set read the same at the top level and inside properties", () => {
    const topLevel = firstEvent(
      normalizeBody(
        {
          api_key: TOKEN,
          batch: [nodeEvent({ event: "$set", distinctId: "person-1", set: { name: "Ada" } })],
        },
        null,
      ),
    );
    const inProperties = firstEvent(
      normalizeBody(
        {
          api_key: TOKEN,
          batch: [
            jsEvent(TOKEN, {
              event: "$set",
              distinctId: "person-1",
              properties: { $set: { name: "Ada" } },
            }),
          ],
        },
        null,
      ),
    );
    expect(topLevel.distinctId).toBe("person-1");
    expect(topLevel.set).toEqual({ name: "Ada" });
    expect(inProperties.distinctId).toBe("person-1");
    expect(inProperties.set).toEqual({ name: "Ada" });
  });

  it("intake-13 · a numeric distinct id becomes its decimal text", () => {
    const event = firstEvent(
      normalizeBody(
        { api_key: TOKEN, batch: [{ event: "$pageview", distinct_id: 42, properties: {} }] },
        null,
      ),
    );
    expect(event.distinctId).toBe("42");
  });

  it("intake-16 · the hand-built client's single event object is one event, with the project from api_key", () => {
    const body = handBuiltEvent(TOKEN, { event: "page_view", distinctId: "job-1" });
    const result = normalized(normalizeBody(body, null));
    expect(result.events).toHaveLength(1);
    expect(result.token).toBe(TOKEN);
    expect(result.events[0]?.event).toBe("page_view");
    expect(result.events[0]?.distinctId).toBe("job-1");
    expect(result.events[0]?.properties).toMatchObject({ $process_person_profile: false });
  });

  it("intake-16 · the cookieless page form keeps the sentinel and its hashing inputs", () => {
    const body = handBuiltEvent(TOKEN, {
      event: "$pageview",
      distinctId: COOKIELESS_SENTINEL,
      properties: cookielessProperties(),
    });
    const event = firstEvent(normalizeBody(body, null));
    expect(event.distinctId).toBe(COOKIELESS_SENTINEL);
    expect(event.properties).toMatchObject({
      $cookieless_mode: true,
      $host: "www.example.com",
    });
    expect(typeof event.properties.$raw_user_agent).toBe("string");
  });

  it("intake-20 · an unknown top-level key is ignored", () => {
    const result = normalized(
      normalizeBody(
        {
          api_key: TOKEN,
          batch: [nodeEvent({ event: "$pageview", distinctId: "u-1" })],
          historical_migration: true,
          unknown_key: { nested: true },
        },
        null,
      ),
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.event).toBe("$pageview");
  });

  it("intake-21 · the token is read from the wrapper, from the events, or from both", () => {
    const wrapperOnly = normalized(
      normalizeBody(
        { api_key: TOKEN, batch: [nodeEvent({ event: "$pageview", distinctId: "u-1" })] },
        null,
      ),
    );
    expect(wrapperOnly.token).toBe(TOKEN);
    const propertiesOnly = normalized(
      normalizeBody({ batch: [jsEvent(TOKEN, { event: "$pageview", distinctId: "u-2" })] }, null),
    );
    expect(propertiesOnly.token).toBe(TOKEN);
    const both = normalized(
      normalizeBody(
        { api_key: TOKEN, batch: [jsEvent(TOKEN, { event: "$pageview", distinctId: "u-3" })] },
        null,
      ),
    );
    expect(both.token).toBe(TOKEN);
  });

  it("intake-24 · a body that is not an object, an event or an array is not events", () => {
    for (const body of ["hello", 7, true, null, {}, { api_key: TOKEN }, { batch: "nope" }]) {
      expect(normalizeBody(body, null)).toEqual({ ok: false, error: "not events" });
    }
  });

  it("intake-24 · a body with no events left is still events, with an empty list", () => {
    expect(normalizeBody({ api_key: TOKEN, batch: [] }, null)).toEqual({
      ok: true,
      value: {
        events: [],
        dropped: { noName: 0, noDistinctId: 0, badProperties: 0, longDistinctId: 0 },
        token: TOKEN,
      },
    });
  });

  it("intake-29 · each faulty event is dropped and counted while the others are kept", () => {
    const result = normalized(
      normalizeBody(
        {
          api_key: TOKEN,
          batch: [
            keptEvent("kept-1"),
            { distinct_id: "u-2", properties: {} },
            { event: "", distinct_id: "u-3" },
            { event: "no-id" },
            { event: "empty-id", distinct_id: "" },
            { event: "object-id", distinct_id: { nested: 1 } },
            { event: "bad-properties", distinct_id: "u-7", properties: "nope" },
            { event: "long-id", distinct_id: "d".repeat(DISTINCT_ID_MAX + 1) },
            "not an object",
            keptEvent("kept-2"),
          ],
        },
        null,
      ),
    );
    expect(result.events.map((event) => event.event)).toEqual(["kept-1", "kept-2"]);
    expect(result.dropped).toEqual({
      noName: 3,
      noDistinctId: 3,
      badProperties: 1,
      longDistinctId: 1,
    });
  });

  it("intake-34 · sent_at in the query is used when neither the event nor the wrapper carries one", () => {
    const body = {
      api_key: TOKEN,
      batch: [{ event: "$pageview", distinct_id: "u-1", properties: {} }],
    };
    expect(firstEvent(normalizeBody(body, String(T0))).sentAt).toBe(String(T0));
    expect(firstEvent(normalizeBody(body, iso(T0))).sentAt).toBe(iso(T0));
  });

  it("intake-34 · the event's own sent_at wins over the wrapper's, and both over the query", () => {
    const eventOwn = {
      api_key: TOKEN,
      batch: [{ event: "$pageview", distinct_id: "u-1", sent_at: iso(T0 - 1) }],
      sent_at: iso(T0),
    };
    expect(firstEvent(normalizeBody(eventOwn, iso(T0 + 1))).sentAt).toBe(iso(T0 - 1));
    const wrapperOwn = {
      api_key: TOKEN,
      batch: [{ event: "$pageview", distinct_id: "u-1" }],
      sent_at: iso(T0),
    };
    expect(firstEvent(normalizeBody(wrapperOwn, iso(T0 + 1))).sentAt).toBe(iso(T0));
    expect(firstEvent(normalizeBody(wrapperOwn, null)).sentAt).toBe(iso(T0));
  });
});
