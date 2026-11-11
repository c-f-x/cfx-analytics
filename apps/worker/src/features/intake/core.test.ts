import { CLIP, DISTINCT_ID_MAX } from "@cfanalytics/shared";
import { describe, expect, it } from "vitest";
import { BROWSER_UA, DAY_MS, iso, T0 } from "../../../test/helpers/capture.ts";
import { captureAnswer, prepareEvent, quotaKey, retentionStart } from "./core.ts";
import type { RawEvent } from "./normalize.ts";

// From a normalised event to what the ProjectStore stores (intake-01, intake-04,
// intake-18, intake-30, intake-31).

const UUID = "019302a1-7c00-7000-8000-000000000001";
const encoder = new TextEncoder();
const stringBytes = (value: unknown): number =>
  typeof value === "string" ? encoder.encode(value).byteLength : Number.POSITIVE_INFINITY;

function rawEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    uuid: null,
    event: "$pageview",
    token: null,
    distinctId: "user-1",
    properties: {},
    set: {},
    setOnce: {},
    unset: [],
    timestamp: iso(T0),
    sentAt: null,
    ...overrides,
  };
}

function context(
  overrides: Partial<{
    receivedAt: number;
    retentionStart: number;
    newUuid: () => string;
    headerUserAgent: string | null;
  }> = {},
) {
  return {
    receivedAt: T0,
    retentionStart: T0 - 395 * DAY_MS,
    newUuid: () => UUID,
    headerUserAgent: BROWSER_UA,
    ...overrides,
  };
}

describe("captureAnswer", () => {
  it("intake-01 · an ordinary answer is exactly {status: 1}", () => {
    expect(captureAnswer(false, "events")).toEqual({ status: 1 });
    expect(captureAnswer(true, "events")).toEqual({ status: 1, quota_limited: ["events"] });
  });
});

describe("prepareEvent clipping", () => {
  it("intake-04 · an over-long event name is clipped and the event is kept", () => {
    const result = prepareEvent(rawEvent({ event: "n".repeat(CLIP.eventName + 300) }), context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(encoder.encode(result.value.event).byteLength).toBeLessThanOrEqual(CLIP.eventName);
    expect(result.value.event).toBe("n".repeat(CLIP.eventName));
  });

  it("intake-04 · over-long properties, $set and $set_once values are clipped inside the object", () => {
    const long = "a".repeat(CLIP.stringValue + 500);
    const result = prepareEvent(
      rawEvent({ properties: { long, keep: "value" }, set: { long }, setOnce: { long } }),
      context(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(stringBytes(result.value.properties.long)).toBeLessThanOrEqual(CLIP.stringValue);
    expect(result.value.properties.keep).toBe("value");
    expect(stringBytes(result.value.set.long)).toBeLessThanOrEqual(CLIP.stringValue);
    expect(stringBytes(result.value.setOnce.long)).toBeLessThanOrEqual(CLIP.stringValue);
  });
});

describe("retention", () => {
  it("intake-18 · retentionStart is the received time minus the retention days", () => {
    expect(retentionStart(T0, 30)).toBe(T0 - 30 * DAY_MS);
  });

  it("intake-18 · an event older than retention is dropped, and one at the boundary is kept", () => {
    const horizon = T0 - 30 * DAY_MS;
    expect(
      prepareEvent(rawEvent({ timestamp: iso(horizon - 1) }), context({ retentionStart: horizon })),
    ).toEqual({ ok: false, error: "older than retention" });
    const kept = prepareEvent(
      rawEvent({ timestamp: iso(horizon) }),
      context({ retentionStart: horizon }),
    );
    expect(kept.ok).toBe(true);
  });
});

describe("quotaKey", () => {
  it("intake-30 · a batch of only $exception events names exceptionEvent", () => {
    expect(quotaKey(["$exception"])).toBe("exceptionEvent");
    expect(quotaKey(["$exception", "$exception"])).toBe("exceptionEvent");
  });

  it("intake-30 · any other batch, including an empty one, names events", () => {
    expect(quotaKey([])).toBe("events");
    expect(quotaKey(["$exception", "$pageview"])).toBe("events");
    expect(quotaKey(["$pageview"])).toBe("events");
  });
});

describe("prepareEvent uuid", () => {
  it("intake-31 · a missing or malformed uuid is replaced", () => {
    for (const uuid of [null, "not-a-uuid", "019302a1-7c00-7000-8000-00000000000"]) {
      const result = prepareEvent(rawEvent({ uuid }), context());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.uuid).toBe(UUID);
    }
  });

  it("intake-31 · a valid uuid is kept", () => {
    const result = prepareEvent(
      rawEvent({ uuid: "019302a1-7c00-7000-8000-0000000000aa" }),
      context(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.uuid).toBe("019302a1-7c00-7000-8000-0000000000aa");
  });

  it("intake-31 · two identical events with no uuid get different ids", () => {
    let count = 0;
    const newUuid = () => {
      count += 1;
      return `019302a1-7c00-7000-8000-00000000000${count}`;
    };
    const first = prepareEvent(rawEvent(), context({ newUuid }));
    const second = prepareEvent(rawEvent(), context({ newUuid }));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.value.uuid).not.toBe(second.value.uuid);
  });
});

it("identity-21 · an over-long $anon_distinct_id or alias links nothing, and the event is kept", () => {
  const long = "x".repeat(DISTINCT_ID_MAX + 1);
  const identify = prepareEvent(
    rawEvent({ event: "$identify", properties: { $anon_distinct_id: long } }),
    context(),
  );
  const alias = prepareEvent(
    rawEvent({ event: "$create_alias", properties: { alias: long } }),
    context(),
  );
  expect(identify.ok && identify.value.anonDistinctId).toBeNull();
  expect(alias.ok && alias.value.alias).toBeNull();
});
