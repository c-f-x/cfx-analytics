import type { Json, JsonObject } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import { HOUR_MS, newUuid, T0 } from "../../../test/helpers/capture.ts";
import {
  addedNode,
  compressed,
  consoleEvent,
  fullSnapshotEvent,
  inputEvent,
  MOUSE,
  metaEvent,
  mouseEvent,
  mutationEvent,
  networkEvent,
  newSessionId,
  styleSheetEvent,
} from "../../../test/helpers/replay.ts";
import { COOKIELESS_SENTINEL, type RawEvent } from "../intake/index.ts";
import {
  chunkMeta,
  decodeChunk,
  isSessionId,
  objectKey,
  type RrwebEvent,
  scrub,
  snapshotOf,
  toNdjson,
} from "./core.ts";

// The recordings slice's pure functions at their own boundary: the `$snapshot`
// event and the chunk as the Worker reads and writes them (recordings-02 to
// recordings-32). Nothing here touches a store, a bucket or the Worker. Each
// test builds its own session id and rrweb events, so no two tests share ids.

const SESSION = "0199a0c0-0000-7000-8000-000000000001";

/**
 * One event as normalizeBody hands it to a feature's core: the fields the
 * snapshot functions read, with everything else at its empty value. Tests
 * override only what they mean.
 */
function rawEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    uuid: null,
    event: "$snapshot",
    token: "cfa_pk_recordings",
    distinctId: "anon-1",
    properties: {},
    set: {},
    setOnce: {},
    unset: [],
    timestamp: null,
    sentAt: null,
    ...overrides,
  };
}

/**
 * A raw $snapshot event. `sessionId` omitted leaves `$session_id` out; any
 * other value is placed as sent, which is how the bad-session cases arrive.
 */
function rawSnapshot(
  options: {
    sessionId?: Json;
    data?: Json;
    event?: string;
    distinctId?: string;
    uuid?: string | null;
  } = {},
): RawEvent {
  const properties: JsonObject = {};
  if (options.sessionId !== undefined) properties.$session_id = options.sessionId;
  if (options.data !== undefined) properties.$snapshot_data = options.data;
  return rawEvent({
    uuid: options.uuid ?? null,
    event: options.event ?? "$snapshot",
    distinctId: options.distinctId ?? "anon-1",
    properties,
  });
}

/** The data an event written by the helpers carries. */
function dataOf(event: JsonObject): JsonObject {
  const data = event.data;
  if (data === undefined || typeof data !== "object" || data === null || Array.isArray(data))
    throw new Error("expected an event with a data object");
  return data;
}

/** The events as the functions take them: each carries rrweb's type and timestamp. */
function rrwebEvent(event: JsonObject): RrwebEvent {
  const { type, timestamp } = event;
  if (typeof type !== "number" || typeof timestamp !== "number")
    throw new Error("expected an rrweb event");
  // A copy in the event's own key order, so its JSON text is the event's.
  return { ...event, type, timestamp };
}

function rrweb(...events: JsonObject[]): RrwebEvent[] {
  return events.map(rrwebEvent);
}

// ------------------------------------------------------------ scrub (02, 32)

it("recordings-02 · an Input event's typed text becomes asterisks of the same length", () => {
  const typed = inputEvent(10, "hunter2", T0);
  const click = mouseEvent(10, T0 + 1);

  const scrubbed = scrub(rrweb(typed, click));

  expect(scrubbed).toEqual(rrweb(inputEvent(10, "*******", T0), click));
  // The events sent in are not changed.
  expect(dataOf(typed).text).toBe("hunter2");
});

it("recordings-32 · a full snapshot's input and textarea values and a mutation's value changes are masked", () => {
  const snapshot = fullSnapshotEvent(T0, [
    { id: 10, tagName: "input", attributes: { type: "text", value: "hunter2" } },
    { id: 11, tagName: "TEXTAREA", attributes: { value: "hello" } },
    { id: 12, tagName: "div", attributes: { title: "keep me" } },
  ]);
  const mutation = mutationEvent(T0 + 1, {
    texts: [{ id: 11, value: "visible text, not an attribute" }],
    attributes: [{ id: 10, attributes: { value: "typed", placeholder: "keep me too" } }],
    removes: [12],
    adds: [addedNode(4, { id: 13, tagName: "input", attributes: { value: "fresh" } })],
  });

  const expectedSnapshot = fullSnapshotEvent(T0, [
    { id: 10, tagName: "input", attributes: { type: "text", value: "*******" } },
    { id: 11, tagName: "TEXTAREA", attributes: { value: "*****" } },
    { id: 12, tagName: "div", attributes: { title: "keep me" } },
  ]);
  const expectedMutation = mutationEvent(T0 + 1, {
    texts: [{ id: 11, value: "visible text, not an attribute" }],
    attributes: [{ id: 10, attributes: { value: "*****", placeholder: "keep me too" } }],
    removes: [12],
    adds: [addedNode(4, { id: 13, tagName: "input", attributes: { value: "*****" } })],
  });

  expect(scrub(rrweb(snapshot, mutation))).toEqual(rrweb(expectedSnapshot, expectedMutation));
});

// ------------------------------------------------------- chunkMeta (05, 27, 28)

it("recordings-05 · chunkMeta reads the times, first URL, clicks, keypresses and active time", () => {
  const sent = [
    metaEvent("https://www.example.com/pricing?plan=pro", 1280, 800, T0),
    fullSnapshotEvent(T0 + 100),
    mouseEvent(10, T0 + 200, MOUSE.mouseDown),
    mouseEvent(10, T0 + 300, MOUSE.mouseUp),
    mouseEvent(10, T0 + 400, MOUSE.click),
    inputEvent(10, "a", T0 + 500),
    inputEvent(10, "ab", T0 + 3000),
    inputEvent(10, "abc", T0 + 9000),
  ];

  expect(chunkMeta(rrweb(...sent), 0)).toEqual({
    ok: true,
    value: {
      firstTs: T0,
      lastTs: T0 + 9000,
      snapshotPath: "/pricing",
      snapshotWidth: 1280,
      firstUrl: "https://www.example.com/pricing?plan=pro",
      // A mousedown and a mouseup are not clicks; only rrweb's Click counts.
      clicks: 1,
      keypresses: 3,
      // Gaps of 100, 100, 100, 2500 and 6000 ms; the 6000 is past the 5 s idle gap.
      activeMs: 2800,
    },
  });
});

it("recordings-27 · chunkMeta takes the path and width from the last Meta and full snapshot pair", () => {
  const sent = [
    metaEvent("https://www.example.com/pricing?plan=pro", 1280, 800, T0),
    fullSnapshotEvent(T0 + 1),
    metaEvent("https://www.example.com/checkout?step=2", 1440, 900, T0 + 2),
    fullSnapshotEvent(T0 + 3),
  ];

  const answer = chunkMeta(rrweb(...sent), 0);
  if (!answer.ok) throw new Error(`chunkMeta refused events it should read: ${answer.error}`);
  expect(answer.value.snapshotPath).toBe("/checkout");
  expect(answer.value.snapshotWidth).toBe(1440);
  expect(answer.value.firstUrl).toBe("https://www.example.com/pricing?plan=pro");
});

it("recordings-28 · chunkMeta moves every time back by the client's clock skew", () => {
  const sent = [metaEvent("https://www.example.com/", 1280, 800, T0), fullSnapshotEvent(T0 + 1000)];

  const answer = chunkMeta(rrweb(...sent), HOUR_MS);
  if (!answer.ok) throw new Error(`chunkMeta refused events it should read: ${answer.error}`);
  expect(answer.value.firstTs).toBe(T0 - HOUR_MS);
  expect(answer.value.lastTs).toBe(T0 + 1000 - HOUR_MS);
});

// ------------------------------------------------------------ objectKey (07)

it("recordings-07 · objectKey is the project, session, arrival time and uuid", () => {
  const uuid = "0199a0c0-0000-7000-8000-0000000000aa";

  expect(objectKey("p_abc", SESSION, 1760000000000, uuid)).toBe(
    `p_abc/${SESSION}/1760000000000-${uuid}.ndjson.gz`,
  );
});

// ------------------------------------------------------- isSessionId (08)

it("recordings-08 · isSessionId accepts a UUID and refuses a path or a short value", () => {
  expect(isSessionId(SESSION)).toBe(true);
  expect(isSessionId(newSessionId())).toBe(true);

  for (const value of ["", "a/b", "..", "../p_other", "12345", "not-a-uuid"]) {
    expect(isSessionId(value)).toBe(false);
  }
  expect(isSessionId(null)).toBe(false);
  expect(isSessionId(7)).toBe(false);
});

it("recordings-08 · snapshotOf refuses a session id that is not a UUID", () => {
  for (const sessionId of ["", "a/b", "..", "../p_other", "not-a-uuid"]) {
    expect(
      snapshotOf(
        rawSnapshot({ sessionId, data: [metaEvent("https://www.example.com/", 1280, 800, T0)] }),
      ),
    ).toEqual({ ok: false, error: "bad session" });
  }
});

it("recordings-08 · snapshotOf keeps a UUID session and the event's own uuid", () => {
  const data = [metaEvent("https://www.example.com/", 1280, 800, T0)];
  const uuid = newUuid();

  expect(snapshotOf(rawSnapshot({ sessionId: SESSION, uuid, data }))).toEqual({
    ok: true,
    value: { uuid, sessionId: SESSION, distinctId: "anon-1", data },
  });
});

// ------------------------------------------------ snapshotOf drops (21, 22, 15c)

it("recordings-21 · a $snapshot with no $session_id is dropped for no session", () => {
  expect(
    snapshotOf(rawSnapshot({ data: [metaEvent("https://www.example.com/", 1280, 800, T0)] })),
  ).toEqual({ ok: false, error: "no session" });
  expect(snapshotOf(rawSnapshot({ sessionId: 7, data: [] }))).toEqual({
    ok: false,
    error: "no session",
  });
});

it("recordings-22 · an event that is not a $snapshot is dropped", () => {
  expect(snapshotOf(rawSnapshot({ event: "$pageview", sessionId: SESSION }))).toEqual({
    ok: false,
    error: "not a snapshot",
  });
});

it("cookieless-15 · a cookieless $snapshot is dropped for cookieless", () => {
  expect(
    snapshotOf(
      rawSnapshot({
        sessionId: SESSION,
        distinctId: COOKIELESS_SENTINEL,
        data: [metaEvent("https://www.example.com/", 1280, 800, T0)],
      }),
    ),
  ).toEqual({ ok: false, error: "cookieless" });
});

// -------------------------------------------------------- decodeChunk (25, 26)

it("recordings-25 · decodeChunk unpacks posthog-js's compressed fields and removes cv", async () => {
  const snapshot = fullSnapshotEvent(T0, [
    { id: 10, tagName: "input", attributes: { value: "hunter2" } },
  ]);
  const mutation = mutationEvent(T0 + 1, {
    texts: [{ id: 11, value: "typed" }],
    attributes: [{ id: 10, attributes: { value: "changed" } }],
    removes: [12],
    adds: [addedNode(4, { id: 13, tagName: "div" })],
  });
  const stylesheet = styleSheetEvent(T0 + 2, [{ rule: "body { color: red }" }]);

  const sent = [
    await compressed(snapshot),
    await compressed(mutation),
    await compressed(stylesheet),
  ];

  expect(await decodeChunk(sent)).toEqual({ ok: true, value: [snapshot, mutation, stylesheet] });
});

it("recordings-25 · decodeChunk refuses a chunk whose compressed field is not latin1 or not gzip", async () => {
  const packed = await compressed(fullSnapshotEvent(T0));

  expect(await decodeChunk([{ ...packed, data: "not a gzip stream" }])).toEqual({
    ok: false,
    error: "undecodable",
  });
  expect(await decodeChunk([{ ...packed, data: "π" }])).toEqual({
    ok: false,
    error: "undecodable",
  });
});

it("recordings-26 · decodeChunk drops network plugin events and keeps console ones", async () => {
  const network = networkEvent(T0);
  const console = consoleEvent(T0 + 1);

  expect(await decodeChunk([network, console])).toEqual({ ok: true, value: [console] });
});

// ------------------------------------------------------------- toNdjson (09)

it("recordings-09 · toNdjson writes each event as one line, in order", () => {
  const meta = metaEvent("https://www.example.com/", 1280, 800, T0);
  const typed = inputEvent(10, "ab", T0 + 1);

  expect(toNdjson(rrweb(meta, typed))).toBe(`${JSON.stringify(meta)}\n${JSON.stringify(typed)}\n`);
});

it("recordings-33 · a timestamp or width no SQLite integer can hold adds nothing to the chunk", async () => {
  const absurd = { ...mouseEvent(MOUSE.click, T0 + 2), timestamp: 1e20 };
  const decoded = await decodeChunk([
    metaEvent("https://www.example.com/pricing", 1e20, 800, T0),
    fullSnapshotEvent(T0 + 1),
    absurd,
  ]);
  if (!decoded.ok) throw new Error("decodeChunk refused a chunk it should keep");
  expect(decoded.value).toHaveLength(2);

  const answer = chunkMeta(decoded.value, 0);
  if (!answer.ok) throw new Error(`chunkMeta refused events it should read: ${answer.error}`);
  expect(answer.value.firstTs).toBe(T0);
  expect(answer.value.lastTs).toBe(T0 + 1);
  expect(answer.value.snapshotWidth).toBeNull();
});
