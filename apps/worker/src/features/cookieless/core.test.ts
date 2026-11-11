import { expect, it } from "vitest";
import {
  BROWSER_UA,
  CLIENT_IP,
  DAY_MS,
  dayIn,
  MINUTE_MS,
  T0,
} from "../../../test/helpers/capture.ts";
import {
  cookielessId,
  hashDay,
  nextSession,
  type SessionState,
  saltDay,
  saltExpiry,
  siphash24,
} from "./core.ts";

// The cookieless hash, day and session rules (posthog-protocol.md §5, D-20).
// Pure: salts, times and ids arrive as arguments, so the test reads no clock.

// The SipHash-2-4 reference vectors: key 00..0f, message 00..n.
const REFERENCE_KEY = new Uint8Array([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
]);
const REFERENCE_MESSAGE_15 = new Uint8Array([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
]);

const SALT = new Uint8Array(16).fill(3);
const encoder = new TextEncoder();

/** One visitor's hash inputs: a salt, the project, the IP, the exact host and the user agent. */
const INPUT = {
  salt: SALT,
  projectId: "p_cookieless_reference",
  ip: CLIENT_IP,
  host: "www.example.com",
  userAgent: BROWSER_UA,
};

it("cookieless-01 · siphash24 matches the reference vectors", () => {
  expect(siphash24(REFERENCE_KEY, new Uint8Array(0))).toBe(0x726fdb47dd0e0e31n);
  expect(siphash24(REFERENCE_KEY, REFERENCE_MESSAGE_15)).toBe(0xa129ca6149be45e5n);
});

it("cookieless-01 · the id is cookieless_ and 16 hex of the project, IP, host and agent", () => {
  const id = cookielessId(INPUT);
  const message = encoder.encode(
    [INPUT.projectId, INPUT.ip, INPUT.host, INPUT.userAgent].join("\u0000"),
  );

  expect(id).toMatch(/^cookieless_[0-9a-f]{16}$/);
  expect(id).toBe(`cookieless_${siphash24(SALT, message).toString(16).padStart(16, "0")}`);
});

it("cookieless-02 · equal inputs share an id and each changed input gives another", () => {
  const id = cookielessId(INPUT);
  expect(cookielessId({ ...INPUT })).toBe(id);

  const changed = [
    cookielessId({ ...INPUT, salt: new Uint8Array(16).fill(4) }),
    cookielessId({ ...INPUT, projectId: "p_cookieless_other" }),
    cookielessId({ ...INPUT, ip: "198.51.100.9" }),
    cookielessId({ ...INPUT, host: "www.example.net" }),
    cookielessId({ ...INPUT, userAgent: "AnotherAgent/1.0" }),
  ];
  for (const other of changed) expect(other).not.toBe(id);
});

it("cookieless-04 · a day's salt expires at 12:00 UTC on the day after", () => {
  expect(saltExpiry("2026-10-21")).toBe(Date.UTC(2026, 9, 22, 12, 0, 0));
  expect(saltExpiry("2026-10-31")).toBe(Date.UTC(2026, 10, 1, 12, 0, 0));
  expect(saltExpiry("2028-02-28")).toBe(Date.UTC(2028, 1, 29, 12, 0, 0));
});

it("cookieless-06 · 20 minutes apart joins one session and 40 minutes apart starts another", () => {
  const first = nextSession(null, T0, "session-1");
  expect(first).toEqual({ sessionId: "session-1", state: { sessionId: "session-1", lastTs: T0 } });

  const close = nextSession(first.state, T0 + 20 * MINUTE_MS, "session-2");
  expect(close).toEqual({
    sessionId: "session-1",
    state: { sessionId: "session-1", lastTs: T0 + 20 * MINUTE_MS },
  });

  const far = nextSession(close.state, T0 + 60 * MINUTE_MS, "session-2");
  expect(far).toEqual({
    sessionId: "session-2",
    state: { sessionId: "session-2", lastTs: T0 + 60 * MINUTE_MS },
  });
});

it("cookieless-06 · exactly 30 minutes still joins and one millisecond more does not", () => {
  const current: SessionState = { sessionId: "session-1", lastTs: T0 };

  expect(nextSession(current, T0 + 30 * MINUTE_MS, "session-2")).toEqual({
    sessionId: "session-1",
    state: { sessionId: "session-1", lastTs: T0 + 30 * MINUTE_MS },
  });
  expect(nextSession(current, T0 + 30 * MINUTE_MS + 1, "session-2")).toEqual({
    sessionId: "session-2",
    state: { sessionId: "session-2", lastTs: T0 + 30 * MINUTE_MS + 1 },
  });
});

it("cookieless-09 · the salt day is $timezone, else the project's, and an unknown zone falls back", () => {
  // At T0 these two zones are on different days, so a zone that is ignored shows.
  expect(dayIn(T0, "Pacific/Kiritimati")).not.toBe(dayIn(T0, "Europe/Oslo"));

  expect(saltDay(T0, "Pacific/Kiritimati", "Europe/Oslo")).toBe(dayIn(T0, "Pacific/Kiritimati"));
  expect(saltDay(T0, null, "Pacific/Kiritimati")).toBe(dayIn(T0, "Pacific/Kiritimati"));
  expect(saltDay(T0, null, "Europe/Oslo")).toBe(dayIn(T0, "Europe/Oslo"));
  expect(saltDay(T0, "Not/AZone", "Europe/Oslo")).toBe(dayIn(T0, "Europe/Oslo"));

  // hashDay reads the same zones while the day's salt is still alive.
  expect(hashDay(T0, T0, "Pacific/Kiritimati", "Europe/Oslo")).toBe(
    dayIn(T0, "Pacific/Kiritimati"),
  );
  expect(hashDay(T0, T0, "Not/AZone", "Europe/Oslo")).toBe(dayIn(T0, "Europe/Oslo"));
});

it("cookieless-10 · a late event whose salt has expired is counted on the day it arrived", () => {
  const lateTs = T0 - DAY_MS; // 2026-10-20, whose salt is gone from 2026-10-21 12:00 UTC.
  const arrivedAt = T0 + DAY_MS;

  expect(hashDay(lateTs, arrivedAt, null, "Europe/Oslo")).toBe(dayIn(arrivedAt, "Europe/Oslo"));
  // At the expiry itself the day has ended, so the event's own day is already gone.
  expect(hashDay(lateTs, saltExpiry("2026-10-20"), null, "Europe/Oslo")).toBe(
    dayIn(saltExpiry("2026-10-20"), "Europe/Oslo"),
  );
  // A day whose salt is still alive keeps the event's own day.
  expect(hashDay(T0, arrivedAt, null, "Europe/Oslo")).toBe(dayIn(T0, "Europe/Oslo"));
});

it("cookieless-18 · an event older than the session never moves its last time back", () => {
  const current: SessionState = { sessionId: "session-1", lastTs: T0 + 20 * MINUTE_MS };

  expect(nextSession(current, T0 + 10 * MINUTE_MS, "session-2")).toEqual({
    sessionId: "session-1",
    state: current,
  });
  expect(nextSession(current, T0 - 20 * MINUTE_MS, "session-3")).toEqual({
    sessionId: "session-3",
    state: current,
  });
});
