import { describe, expect, it } from "vitest";
import { DAY_MS, HOUR_MS, iso, T0 } from "../../../test/helpers/capture.ts";
import { clockSkew, eventTime } from "./time.ts";

// An event's stored time from what the SDK sent (intake-14, intake-33 to intake-37).

describe("eventTime", () => {
  it("intake-14 · a sent_at two hours behind corrects the event's time", () => {
    const receivedAt = T0;
    const skew = 2 * HOUR_MS;
    // The client's clock is two hours behind. It sends at its T0 - 2 h, ten seconds after the event.
    const clientSentAt = T0 - skew;
    const clientTimestamp = clientSentAt - 10_000;
    const time = eventTime({
      timestamp: iso(clientTimestamp),
      sentAt: iso(clientSentAt),
      receivedAt,
      ignoreSentAt: false,
    });
    // Received minus (sent_at minus timestamp): exact, since every time is passed in.
    expect(time).toBe(T0 - 10_000);
  });

  it("intake-33 · a timestamp with no sent_at is stored as sent", () => {
    const timestamp = T0 - DAY_MS;
    expect(
      eventTime({ timestamp: iso(timestamp), sentAt: null, receivedAt: T0, ignoreSentAt: false }),
    ).toBe(timestamp);
  });

  it("intake-33 · no timestamp, or an unparseable one, stores the received time", () => {
    for (const timestamp of [null, undefined, "not a time", "2026-10-21", "2026-10-21T10:00:00"]) {
      expect(eventTime({ timestamp, sentAt: null, receivedAt: T0, ignoreSentAt: false })).toBe(T0);
    }
  });

  it("intake-34 · sent_at parses as ISO or as epoch milliseconds", () => {
    const timestamp = T0 - HOUR_MS;
    for (const sentAt of [iso(T0), String(T0), T0]) {
      expect(
        eventTime({ timestamp: iso(timestamp), sentAt, receivedAt: T0, ignoreSentAt: false }),
      ).toBe(timestamp);
    }
  });

  it("intake-34 · an epoch time with a fraction is stored as whole milliseconds", () => {
    const stored = eventTime({
      timestamp: T0 - HOUR_MS + 0.4,
      sentAt: T0 + 0.7,
      receivedAt: T0,
      ignoreSentAt: false,
    });
    expect(Number.isInteger(stored)).toBe(true);
    // Each time is rounded as it is read: T0 - 1 h + 0.4 to T0 - 1 h, and a
    // sent_at of T0 + 0.7 to T0 + 1, so the 1 ms skew comes off.
    expect(stored).toBe(T0 - HOUR_MS - 1);
  });

  it("intake-34 · an unparseable sent_at counts as absent", () => {
    const timestamp = T0 - HOUR_MS;
    expect(
      eventTime({ timestamp: iso(timestamp), sentAt: "soon", receivedAt: T0, ignoreSentAt: false }),
    ).toBe(timestamp);
  });

  it("intake-35 · $ignore_sent_at stores the timestamp as sent, with no correction", () => {
    const clientSentAt = T0 - 2 * HOUR_MS;
    const clientTimestamp = clientSentAt - 10_000;
    expect(
      eventTime({
        timestamp: iso(clientTimestamp),
        sentAt: iso(clientSentAt),
        receivedAt: T0,
        ignoreSentAt: true,
      }),
    ).toBe(clientTimestamp);
  });

  it("intake-36 · a corrected time more than 23 hours after receipt becomes the received time", () => {
    const within = T0 + 23 * HOUR_MS;
    expect(
      eventTime({ timestamp: iso(within), sentAt: iso(T0), receivedAt: T0, ignoreSentAt: false }),
    ).toBe(within);
    expect(
      eventTime({
        timestamp: iso(within + 1),
        sentAt: iso(T0),
        receivedAt: T0,
        ignoreSentAt: false,
      }),
    ).toBe(T0);
  });
});

describe("times too large to be times", () => {
  it("intake-34 · a sent_at or timestamp too large to be a time counts as absent", () => {
    const timestamp = T0 - HOUR_MS;
    // A sent_at of 1e20 would shift the event 3 billion years into the past.
    expect(
      eventTime({ timestamp: iso(timestamp), sentAt: 1e20, receivedAt: T0, ignoreSentAt: false }),
    ).toBe(timestamp);
    expect(eventTime({ timestamp: 1e20, sentAt: null, receivedAt: T0, ignoreSentAt: false })).toBe(
      T0,
    );
    expect(clockSkew(1e20, T0)).toBe(0);
  });
});
