import type {
  Granularity,
  JsonObject,
  Range,
  ResolvedRange,
  TrendResult,
  TrendSpec,
} from "@cfanalytics/shared";
import { expect, it } from "vitest";
import { EVERY_EVENT, OSLO, resolved, runStatements } from "../../../test/helpers/query.ts";
import { newProjectId } from "../../../test/helpers/registry.ts";
import { type SeedEvent, seedEvents, seedPerson } from "../../../test/helpers/seed.ts";
import { bucketsOf } from "./range.ts";
import {
  answerTrend,
  compileTrend,
  type Period,
  relativeChange,
  type TrendFrame,
} from "./trend.ts";

// The trend through a real ProjectStore (query-02, query-15, query-16, query-20,
// query-41 to query-46, query-72). Europe/Oslo is UTC+2 until 2026-10-25, so a
// local day starts at 22:00 UTC the day before. Every expected value is worked
// out by hand from the contract.

const at = (iso: string): number => Date.parse(iso);

/** A half-open range between two instants. */
const between = (from: string, to: string): Range => ({ kind: "between", from, to });

const ONE_DAY = between("2026-10-20T00:00:00+02:00", "2026-10-21T00:00:00+02:00");
const TWO_DAYS = between("2026-10-20T00:00:00+02:00", "2026-10-22T00:00:00+02:00");

function specOf(overrides: Partial<TrendSpec> = {}): TrendSpec {
  return { kind: "trend", range: ONE_DAY, measure: "events", granularity: "day", ...overrides };
}

function periodOf(range: ResolvedRange, granularity: Granularity): Period {
  const buckets = bucketsOf(range, granularity);
  if (!buckets.ok) throw new Error(`the test's range answers ${buckets.error}`);
  return { range, buckets: buckets.value };
}

function frameOf(trend: TrendSpec, previous?: Range): TrendFrame {
  return {
    current: periodOf(resolved(trend.range, trend.timeZone), trend.granularity),
    previous:
      previous === undefined
        ? null
        : periodOf(resolved(previous, trend.timeZone), trend.granularity),
  };
}

/** The trend through the compiled statements and the store's own RPC call. */
async function runTrend(project: string, trend: TrendSpec, previous?: Range): Promise<TrendResult> {
  const frame = frameOf(trend, previous);
  const compiled = compileTrend(trend, frame, EVERY_EVENT);
  return answerTrend(trend, frame, await runStatements(project, compiled));
}

/** `count` events at `iso`, a millisecond apart, all holding `properties`. */
function repeated(count: number, iso: string, properties: JsonObject): SeedEvent[] {
  return Array.from({ length: count }, (_, index) => ({ ts: at(iso) + index, properties }));
}

it("query-02 · a breakdown's property name is a bound parameter, whatever quotes it holds", async () => {
  const project = newProjectId();
  const name = `it's "x"`;
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), properties: { [name]: "wanted" } },
    { ts: at("2026-10-20T11:00:00Z"), properties: { [name]: "wanted" } },
    { ts: at("2026-10-20T12:00:00Z"), properties: { other: "wanted" } },
  ]);

  const trend = specOf({ breakdown: { property: { of: "event", name } } });
  const frame = frameOf(trend);
  const compiled = compileTrend(trend, frame, EVERY_EVENT);

  // The name is a value of the statement, never part of its text, and every
  // placeholder has its parameter.
  expect(compiled.statements.some((statement) => statement.params.includes(name))).toBe(true);
  for (const statement of compiled.statements) {
    expect(statement.sql).not.toContain(name);
    expect(statement.sql.match(/\?/g) ?? []).toHaveLength(statement.params.length);
  }

  // The third event holds the same value under another key, so it belongs to
  // the null key and not to the "wanted" series.
  const result = answerTrend(trend, frame, await runStatements(project, compiled));
  expect(result.series.map((series) => series.key)).toEqual(["wanted", null]);
  expect(result.series.map((series) => series.values)).toEqual([[2], [1]]);
});

it("query-15 · an event at 23:30 UTC sits in the next local day in Oslo and the same one in New York", async () => {
  const project = newProjectId();
  await seedEvents(project, [{ ts: at("2026-10-20T23:30:00Z") }]);

  const oslo = await runTrend(
    project,
    specOf({
      timeZone: OSLO,
      range: between("2026-10-20T00:00:00+02:00", "2026-10-22T00:00:00+02:00"),
    }),
  );
  expect(oslo.buckets).toEqual(["2026-10-20", "2026-10-21"]);
  expect(oslo.series[0]?.values).toEqual([0, 1]);

  const newYork = await runTrend(
    project,
    specOf({
      timeZone: "America/New_York",
      range: between("2026-10-20T00:00:00-04:00", "2026-10-22T00:00:00-04:00"),
    }),
  );
  expect(newYork.buckets).toEqual(["2026-10-20", "2026-10-21"]);
  expect(newYork.series[0]?.values).toEqual([1, 0]);
});

it("query-16 · every bucket of the range is present in order, 0 where nothing happened", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z") },
    { ts: at("2026-10-22T10:00:00Z") },
  ]);

  const result = await runTrend(
    project,
    specOf({ range: between("2026-10-20T00:00:00+02:00", "2026-10-23T00:00:00+02:00") }),
  );
  expect(result.buckets).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
  expect(result.series).toHaveLength(1);
  expect(result.series[0]?.key).toBeNull();
  expect(result.series[0]?.values).toEqual([1, 0, 1]);
  expect(result.series[0]?.total).toBe(2);
});

it("query-20 · a trend's bucket number is compared as CAST(? AS INTEGER)", () => {
  const trend = specOf({ range: TWO_DAYS });
  const compiled = compileTrend(trend, frameOf(trend), EVERY_EVENT);
  const cast = compiled.statements.filter((statement) =>
    statement.sql.includes("CAST(? AS INTEGER)"),
  );
  expect(cast.length).toBeGreaterThan(0);
});

it("query-41 · one visitor in two buckets counts in each, and once in the total", async () => {
  const project = newProjectId();
  const person = await seedPerson(project, ["user-a"]);
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), personId: person, distinctId: "user-a" },
    { ts: at("2026-10-21T10:00:00Z"), personId: person, distinctId: "user-a" },
  ]);

  const result = await runTrend(project, specOf({ range: TWO_DAYS, measure: "visitors" }));
  expect(result.series).toHaveLength(1);
  expect(result.series[0]?.values).toEqual([1, 1]);
  expect(result.series[0]?.total).toBe(1);
});

it("query-42 · a session with events in two buckets counts once, in the first", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), sessionId: "s-1" },
    { ts: at("2026-10-20T11:00:00Z"), sessionId: "s-2" },
    { ts: at("2026-10-21T10:00:00Z"), sessionId: "s-1" },
    // An event with no session counts for none.
    { ts: at("2026-10-21T11:00:00Z") },
  ]);

  const result = await runTrend(project, specOf({ range: TWO_DAYS, measure: "sessions" }));
  expect(result.series[0]?.values).toEqual([2, 0]);
  expect(result.series[0]?.total).toBe(2);
});

it("query-43 · relativeChange is 0 for 0 to 0, null for 0 to 1, and a ratio otherwise", () => {
  expect(relativeChange(0, 0)).toBe(0);
  expect(relativeChange(0, 1)).toBeNull();
  expect(relativeChange(2, 3)).toBe(0.5);
  expect(relativeChange(3, 2)).toBe(-1 / 3);
});

it("query-43 · a compared series carries its change from the previous period", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    { ts: at("2026-10-19T10:00:00Z") },
    { ts: at("2026-10-19T11:00:00Z") },
    { ts: at("2026-10-20T10:00:00Z") },
    { ts: at("2026-10-20T11:00:00Z") },
    { ts: at("2026-10-20T12:00:00Z") },
  ]);

  const trend = specOf({ range: ONE_DAY, compare: true });
  const result = await runTrend(
    project,
    trend,
    between("2026-10-19T00:00:00+02:00", "2026-10-20T00:00:00+02:00"),
  );
  expect(result.previous?.buckets).toEqual(["2026-10-19"]);
  expect(result.previous?.series[0]?.values).toEqual([2]);
  expect(result.series[0]?.change).toBe(0.5);
});

it("query-44 · a compared breakdown keeps a previous-only key and orders by absolute change", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    ...repeated(10, "2026-10-19T10:00:00Z", { plan: "c" }),
    ...repeated(1, "2026-10-19T11:00:00Z", { plan: "a" }),
    ...repeated(1, "2026-10-20T10:00:00Z", { plan: "a" }),
    ...repeated(5, "2026-10-20T11:00:00Z", { plan: "b" }),
  ]);

  const trend = specOf({
    compare: true,
    breakdown: { property: { of: "event", name: "plan" } },
  });
  const result = await runTrend(
    project,
    trend,
    between("2026-10-19T00:00:00+02:00", "2026-10-20T00:00:00+02:00"),
  );

  // Absolute changes: c 10, b 5, a 0. The previous series uses the same keys.
  expect(result.series.map((series) => series.key)).toEqual(["c", "b", "a"]);
  expect(result.series.map((series) => series.total)).toEqual([0, 5, 1]);
  expect(result.series.map((series) => series.change)).toEqual([-1, null, 0]);
  expect(result.previous?.series.map((series) => series.key)).toEqual(["c", "b", "a"]);
  expect(result.previous?.series.map((series) => series.total)).toEqual([10, 0, 1]);
});

it("query-45 · breakdownLimit 2 with four keys keeps two series and sums the rest into Other", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    ...repeated(2, "2026-10-20T10:00:00Z", { plan: "a" }),
    ...repeated(1, "2026-10-20T10:30:00Z", { plan: "b" }),
    ...repeated(1, "2026-10-20T11:00:00Z", { plan: "c" }),
    ...repeated(1, "2026-10-20T11:30:00Z", { plan: "d" }),
    ...repeated(2, "2026-10-21T10:00:00Z", { plan: "a" }),
    ...repeated(2, "2026-10-21T10:30:00Z", { plan: "b" }),
    ...repeated(1, "2026-10-21T11:00:00Z", { plan: "c" }),
  ]);

  const trend = specOf({
    range: TWO_DAYS,
    breakdownLimit: 2,
    breakdown: { property: { of: "event", name: "plan" } },
  });
  const result = await runTrend(project, trend);

  // Totals: a 4, b 3, c 2, d 1. Other holds c and d per bucket: 2 then 1.
  expect(result.series.map((series) => series.key)).toEqual(["a", "b", "Other"]);
  expect(result.series.map((series) => series.values)).toEqual([
    [2, 2],
    [1, 2],
    [2, 1],
  ]);
  expect(result.series[2]?.other).toBe(true);
  expect(result.series[2]?.total).toBe(3);
  expect(result.series[0]?.other).toBe(false);
  expect(result.series[1]?.other).toBe(false);
});

it("query-46 · null, missing and blank values share the null key and Unknown is its own", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z") },
    { ts: at("2026-10-20T10:01:00Z"), properties: { plan: null } },
    { ts: at("2026-10-20T10:02:00Z"), properties: { plan: "" } },
    { ts: at("2026-10-20T10:03:00Z"), properties: { plan: "  " } },
    { ts: at("2026-10-20T10:04:00Z"), properties: { plan: "pro" } },
    ...repeated(2, "2026-10-20T10:05:00Z", { plan: "Unknown" }),
  ]);

  const trend = specOf({ breakdown: { property: { of: "event", name: "plan" } } });
  const result = await runTrend(project, trend);
  expect(result.series.map((series) => series.key)).toEqual([null, "Unknown", "pro"]);
  expect(result.series.map((series) => series.values)).toEqual([[4], [2], [1]]);
});

it("query-72 · a person with two ids and a cookieless hash each count once as a visitor", async () => {
  const project = newProjectId();
  const person = await seedPerson(project, ["user-a", "user-b"]);
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), personId: person, distinctId: "user-a" },
    { ts: at("2026-10-20T10:01:00Z"), personId: person, distinctId: "user-b" },
    { ts: at("2026-10-20T10:02:00Z"), distinctId: "cookieless_9f8e7d6c5b4a3210" },
    { ts: at("2026-10-20T10:03:00Z"), distinctId: "cookieless_9f8e7d6c5b4a3210" },
    { ts: at("2026-10-20T10:04:00Z"), distinctId: "anon-1" },
  ]);

  const result = await runTrend(project, specOf({ measure: "visitors" }));
  expect(result.series[0]?.values).toEqual([3]);
  expect(result.series[0]?.total).toBe(3);
});
