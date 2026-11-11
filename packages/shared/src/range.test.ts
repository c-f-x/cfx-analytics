import { expect, it } from "vitest";
import { type ResolvedRange, resolveRange } from "./range.ts";

// Every dashboard answer's time window at a fixed clock (query-10, query-11,
// query-37, query-40). Times are UTC ms. Europe/Oslo runs at UTC+1 in winter
// and UTC+2 in summer, and its clocks go forward at 02:00 on 29 March 2026, so
// the local day of 29 March is 23 hours long.

const OSLO = "Europe/Oslo";
/** 2026-10-21T10:00Z, the Worker tests' T0. */
const T0 = Date.UTC(2026, 9, 21, 10, 0, 0);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** 2026-03-29T12:00Z: the afternoon of the daylight-saving day in Europe/Oslo. */
const NOON_ON_DST_START = Date.UTC(2026, 2, 29, 12, 0, 0);
/** 2026-03-30T12:00Z: the day after, whose yesterday is the 23-hour day. */
const NOON_AFTER_DST_START = Date.UTC(2026, 2, 30, 12, 0, 0);
/** A horizon no range reaches: nothing is clipped. */
const NO_RETENTION = 0;

function value(result: ReturnType<typeof resolveRange>): ResolvedRange {
  if (!result.ok) throw new Error(`expected a range, got ${result.error}`);
  return result.value;
}

it("query-10 · today runs from local midnight to now, and yesterday is the 23-hour daylight-saving day", () => {
  expect(value(resolveRange({ kind: "today" }, OSLO, NOON_ON_DST_START, NO_RETENTION))).toEqual({
    from: Date.UTC(2026, 2, 28, 23, 0, 0),
    to: NOON_ON_DST_START,
    timeZone: OSLO,
    requested: null,
  });

  const yesterday = value(
    resolveRange({ kind: "yesterday" }, OSLO, NOON_AFTER_DST_START, NO_RETENTION),
  );
  expect(yesterday.from).toBe(Date.UTC(2026, 2, 28, 23, 0, 0));
  expect(yesterday.to).toBe(Date.UTC(2026, 2, 29, 22, 0, 0));
  expect(yesterday.to - yesterday.from).toBe(23 * HOUR_MS);
});

it("query-10 · last 7 days is seven calendar days including today, and last 24 hours is a rolling window", () => {
  expect(
    value(resolveRange({ kind: "last_days", days: 7 }, OSLO, NOON_ON_DST_START, NO_RETENTION)),
  ).toEqual({
    from: Date.UTC(2026, 2, 22, 23, 0, 0),
    to: NOON_ON_DST_START,
    timeZone: OSLO,
    requested: null,
  });

  expect(
    value(resolveRange({ kind: "last_24_hours" }, OSLO, NOON_ON_DST_START, NO_RETENTION)),
  ).toEqual({
    from: NOON_ON_DST_START - DAY_MS,
    to: NOON_ON_DST_START,
    timeZone: OSLO,
    requested: null,
  });
});

it("query-11 · between is taken as given, its offset resolved to UTC, and nothing is clipped", () => {
  const range = value(
    resolveRange(
      { kind: "between", from: "2026-10-14T10:00:00+02:00", to: "2026-10-20T00:00:00Z" },
      OSLO,
      T0,
      NO_RETENTION,
    ),
  );

  expect(range).toEqual({
    from: Date.UTC(2026, 9, 14, 8, 0, 0),
    to: Date.UTC(2026, 9, 20, 0, 0, 0),
    timeZone: OSLO,
    requested: null,
  });
});

it("query-11 · a start not before its end, or a negative start, is an error", () => {
  expect(
    resolveRange(
      { kind: "between", from: "2026-10-20T00:00:00Z", to: "2026-10-20T00:00:00Z" },
      OSLO,
      T0,
      NO_RETENTION,
    ),
  ).toEqual({ ok: false, error: "start not before end" });

  expect(
    resolveRange(
      { kind: "between", from: "2026-10-21T00:00:00Z", to: "2026-10-20T00:00:00Z" },
      OSLO,
      T0,
      NO_RETENTION,
    ),
  ).toEqual({ ok: false, error: "start not before end" });

  expect(
    resolveRange(
      { kind: "between", from: "1969-12-31T23:59:59Z", to: "2026-10-20T00:00:00Z" },
      OSLO,
      T0,
      NO_RETENTION,
    ),
  ).toEqual({ ok: false, error: "negative start" });
});

it("query-37 · the clock is passed in, so the same now resolves today the same twice", () => {
  const first = resolveRange({ kind: "today" }, OSLO, NOON_ON_DST_START, NO_RETENTION);
  expect(resolveRange({ kind: "today" }, OSLO, NOON_ON_DST_START, NO_RETENTION)).toEqual(first);
});

it("query-40 · a range reaching before the horizon is clipped, and requested holds what was asked", () => {
  const retentionStart = T0 - 90 * DAY_MS;
  const asked = {
    kind: "between",
    from: new Date(T0 - 100 * DAY_MS).toISOString(),
    to: new Date(T0 - DAY_MS).toISOString(),
  } as const;

  expect(value(resolveRange(asked, OSLO, T0, retentionStart))).toEqual({
    from: retentionStart,
    to: T0 - DAY_MS,
    timeZone: OSLO,
    requested: { from: T0 - 100 * DAY_MS, to: T0 - DAY_MS },
  });
});

it("query-40 · a range that ends before the horizon is empty at the horizon", () => {
  const retentionStart = T0 - 90 * DAY_MS;
  const asked = {
    kind: "between",
    from: new Date(T0 - 200 * DAY_MS).toISOString(),
    to: new Date(T0 - 150 * DAY_MS).toISOString(),
  } as const;

  const clipped = value(resolveRange(asked, OSLO, T0, retentionStart));
  expect(clipped.from).toBe(retentionStart);
  expect(clipped.to).toBe(retentionStart);
  expect(clipped.requested).toEqual({ from: T0 - 200 * DAY_MS, to: T0 - 150 * DAY_MS });
});

/**
 * Runs `work` with the Node process's time zone set to `zone`, then restores
 * it. This package's types leave Node out, since the Worker runs it too, so
 * the environment is reached through globalThis.
 */
function inProcessZone<T>(zone: string, work: () => T): T {
  const processEnv: unknown = Reflect.get(Reflect.get(globalThis, "process") ?? {}, "env");
  if (typeof processEnv !== "object" || processEnv === null) throw new Error("not run in Node");
  const before: unknown = Reflect.get(processEnv, "TZ");
  Reflect.set(processEnv, "TZ", zone);
  try {
    return work();
  } finally {
    if (before === undefined) Reflect.deleteProperty(processEnv, "TZ");
    else Reflect.set(processEnv, "TZ", before);
  }
}

it("platform-36 · the process time zone changes no range: UTC, New York and Tokyo answer alike", () => {
  // The Worker runs in UTC, so this can only be shown here, in Node, where the
  // process zone can change. The range code must read no process zone at all.
  const answers = ["UTC", "America/New_York", "Asia/Tokyo"].map((zone) =>
    inProcessZone(zone, () => [
      resolveRange({ kind: "today" }, OSLO, T0, 0),
      resolveRange({ kind: "last_days", days: 7 }, "America/New_York", T0, 0),
      resolveRange({ kind: "yesterday" }, "Asia/Kolkata", T0, 0),
      resolveRange(
        { kind: "between", from: "2026-03-28T00:00:00+01:00", to: "2026-03-30T00:00:00+02:00" },
        OSLO,
        T0,
        0,
      ),
    ]),
  );
  expect(answers[1]).toEqual(answers[0]);
  expect(answers[2]).toEqual(answers[0]);
  // The process zone took effect, so the comparison could have failed.
  expect(inProcessZone("Asia/Tokyo", () => new Date(T0).getTimezoneOffset())).toBe(-540);
});
