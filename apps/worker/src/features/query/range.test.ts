import { type Granularity, type ResolvedRange, wallClockAt } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import { DAY_MS, HOUR_MS } from "../../../test/helpers/capture.ts";
import { OSLO, resolved } from "../../../test/helpers/query.ts";
import { type Bucket, bucketsOf, previousPeriod } from "./range.ts";

const iso = (ms: number): string => new Date(ms).toISOString();

/** The buckets of `range`, or a failure naming why there are none. */
function bucketsIn(range: ResolvedRange, granularity: Granularity): Bucket[] {
  const result = bucketsOf(range, granularity);
  if (!result.ok) throw new Error(`expected buckets, got ${result.error}`);
  return result.value;
}

/** The one bucket holding `instant`; the buckets must cover the range exactly. */
function bucketHolding(buckets: readonly Bucket[], instant: number): Bucket {
  const holding = buckets.filter((bucket) => bucket.start <= instant && instant < bucket.end);
  const [only] = holding;
  if (only === undefined || holding.length !== 1) {
    throw new Error(`${iso(instant)} falls in ${holding.length} buckets`);
  }
  return only;
}

const hoursIn = (bucket: Bucket): number => (bucket.end - bucket.start) / HOUR_MS;

const sumHours = (buckets: readonly Bucket[]): number =>
  buckets.reduce((sum, bucket) => sum + hoursIn(bucket), 0);

it("query-05 · the spring day in Oslo is 23 hours and the day before it 24", () => {
  const range = resolved({
    kind: "between",
    from: "2026-03-28T00:00:00+01:00",
    to: "2026-03-30T00:00:00+02:00",
  });
  const buckets = bucketsIn(range, "day");
  expect(buckets.map((bucket) => bucket.label)).toEqual(["2026-03-28", "2026-03-29"]);
  expect(buckets.map(hoursIn)).toEqual([24, 23]);
  expect(buckets[0]?.start).toBe(range.from);
  expect(buckets[1]?.end).toBe(range.to);
});

it("query-05 · the autumn day in Oslo is 25 hours and the day after it 24", () => {
  const range = resolved({
    kind: "between",
    from: "2026-10-24T00:00:00+02:00",
    to: "2026-10-26T00:00:00+01:00",
  });
  const buckets = bucketsIn(range, "day");
  expect(buckets.map((bucket) => bucket.label)).toEqual(["2026-10-24", "2026-10-25"]);
  expect(buckets.map(hoursIn)).toEqual([24, 25]);
});

it("query-15 · 23:30 UTC is the next local day in Oslo and the same local day in New York", () => {
  const instant = Date.parse("2026-10-20T23:30:00Z");
  const oslo = bucketsIn(resolved({ kind: "last_24_hours" }, OSLO), "day");
  const newYork = bucketsIn(resolved({ kind: "last_24_hours" }, "America/New_York"), "day");
  expect(bucketHolding(oslo, instant).label).toBe("2026-10-21");
  expect(bucketHolding(newYork, instant).label).toBe("2026-10-20");
});

it("query-33 · hour buckets are half-open, and a three-hour range ends outside every bucket", () => {
  const from = Date.parse("2026-10-21T12:00:00+02:00");
  const range = resolved({ kind: "between", from: iso(from), to: iso(from + 3 * HOUR_MS) });
  const buckets = bucketsIn(range, "hour");
  expect(buckets.map((bucket) => bucket.label)).toEqual([
    "2026-10-21T12:00+02:00",
    "2026-10-21T13:00+02:00",
    "2026-10-21T14:00+02:00",
  ]);
  expect(bucketHolding(buckets, Date.parse("2026-10-21T12:59:59.999+02:00")).label).toBe(
    "2026-10-21T12:00+02:00",
  );
  expect(bucketHolding(buckets, Date.parse("2026-10-21T13:00:00+02:00")).label).toBe(
    "2026-10-21T13:00+02:00",
  );
  expect(buckets.filter((bucket) => bucket.start <= range.to && range.to < bucket.end)).toEqual([]);
});

it("query-34 · week buckets start on Monday at local midnight, and the first is cut to the range", () => {
  // Wednesday 4 November to Tuesday 10 November: ranges are half-open, so
  // the second week holds Monday the 9th only.
  const from = Date.parse("2026-11-04T00:00:00+01:00");
  const range = resolved({ kind: "between", from: iso(from), to: iso(from + 6 * DAY_MS) });
  const buckets = bucketsIn(range, "week");
  expect(buckets.map((bucket) => bucket.label)).toEqual(["2026-11-02", "2026-11-09"]);
  expect(buckets[0]?.start).toBe(range.from);
  const second = buckets[1];
  if (second === undefined) throw new Error("expected two week buckets");
  expect(second.end).toBe(range.to);
  const wall = wallClockAt(second.start, OSLO);
  expect([wall.hour, wall.minute, wall.second]).toEqual([0, 0, 0]);
  expect(new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay()).toBe(1);
});

it("query-35 · month buckets are calendar months: February 2026 is 28 days and March 31", () => {
  const february = bucketsIn(
    resolved({
      kind: "between",
      from: "2026-02-01T00:00:00+01:00",
      to: "2026-03-01T00:00:00+01:00",
    }),
    "month",
  );
  expect(february.map((bucket) => bucket.label)).toEqual(["2026-02"]);
  expect(february.map(hoursIn)).toEqual([28 * 24]);

  const march = bucketsIn(
    resolved({
      kind: "between",
      from: "2026-03-01T00:00:00+01:00",
      to: "2026-04-01T00:00:00+02:00",
    }),
    "month",
  );
  expect(march.map((bucket) => bucket.label)).toEqual(["2026-03"]);
  // March has 31 calendar days, and the Oslo clock loses one hour when summer time starts on 29 March.
  expect(sumHours(march)).toBe(31 * 24 - 1);
});

it("query-38 · the previous period of yesterday, of today until now, and of the last 7 days", () => {
  expect(previousPeriod(resolved({ kind: "yesterday" }), 0)).toEqual({
    from: Date.parse("2026-10-19T00:00:00+02:00"),
    to: Date.parse("2026-10-20T00:00:00+02:00"),
    timeZone: OSLO,
    requested: null,
  });
  expect(previousPeriod(resolved({ kind: "today" }), 0)).toEqual({
    // Now is T0, 10:00 UTC, which is 12:00 in Oslo: a day earlier is 12:00 local.
    from: Date.parse("2026-10-20T00:00:00+02:00"),
    to: Date.parse("2026-10-20T12:00:00+02:00"),
    timeZone: OSLO,
    requested: null,
  });
  expect(previousPeriod(resolved({ kind: "last_days", days: 7 }), 0)).toEqual({
    from: Date.parse("2026-10-08T00:00:00+02:00"),
    to: Date.parse("2026-10-14T12:00:00+02:00"),
    timeZone: OSLO,
    requested: null,
  });
});

it("query-39 · exactly 512 hour buckets pass and 513 is too many buckets", () => {
  const from = Date.parse("2026-11-01T00:00:00+01:00");
  const rangeOf = (count: number): ResolvedRange =>
    resolved({ kind: "between", from: iso(from), to: iso(from + count * HOUR_MS) });
  expect(bucketsIn(rangeOf(512), "hour")).toHaveLength(512);
  expect(bucketsOf(rangeOf(513), "hour")).toEqual({ ok: false, error: "too many buckets" });
});
