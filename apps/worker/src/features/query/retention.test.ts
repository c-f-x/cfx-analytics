import type { InternalRule, Range, RetentionResult, RetentionSpec } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import { EVERY_EVENT, OSLO, resolved, runStatements } from "../../../test/helpers/query.ts";
import { newProjectId } from "../../../test/helpers/registry.ts";
import { seedEvents, seedPerson } from "../../../test/helpers/seed.ts";
import { exclusionsSql } from "./filters.ts";
import { bucketsOf } from "./range.ts";
import { answerRetention, compileRetention } from "./retention.ts";
import type { Period } from "./trend.ts";

// Retention through a real ProjectStore (query-20, query-62, query-63). The
// range is four Oslo days, each starting at 22:00 UTC the day before. A
// cohort's period 0 is the bucket after its own, so the last bucket never
// forms a cohort: it has no return period after it.

const at = (iso: string): number => Date.parse(iso);

const FOUR_DAYS: Range = {
  kind: "between",
  from: "2026-10-20T00:00:00+02:00",
  to: "2026-10-24T00:00:00+02:00",
};

function specOf(overrides: Partial<RetentionSpec> = {}): RetentionSpec {
  return { kind: "retention", range: FOUR_DAYS, granularity: "day", ...overrides };
}

function periodOf(retention: RetentionSpec): Period {
  const range = resolved(retention.range, retention.timeZone);
  const buckets = bucketsOf(range, retention.granularity);
  if (!buckets.ok) throw new Error(`the test's range answers ${buckets.error}`);
  return { range, buckets: buckets.value };
}

/** Retention through the compiled statements and the store's own RPC call. */
async function runRetention(
  project: string,
  retention: RetentionSpec,
  scope: Parameters<typeof compileRetention>[2] = EVERY_EVENT,
): Promise<RetentionResult> {
  const period = periodOf(retention);
  const compiled = compileRetention(retention, period, scope);
  return answerRetention(retention, period, await runStatements(project, compiled));
}

it("query-62 · a cohort is each person's first counted event ever, and every period is present", async () => {
  const project = newProjectId();
  const a = await seedPerson(project, ["user-a"]);
  const b = await seedPerson(project, ["user-b"]);
  const c = await seedPerson(project, ["user-c"]);
  const d = await seedPerson(project, ["user-d"]);
  await seedEvents(project, [
    // A starts on the 20th and returns on the 21st and the 23rd.
    { ts: at("2026-10-20T08:00:00Z"), personId: a, distinctId: "user-a" },
    { ts: at("2026-10-21T08:00:00Z"), personId: a, distinctId: "user-a" },
    { ts: at("2026-10-23T08:00:00Z"), personId: a, distinctId: "user-a" },
    // D starts on the 20th and returns on the 22nd.
    { ts: at("2026-10-20T09:00:00Z"), personId: d, distinctId: "user-d" },
    { ts: at("2026-10-22T08:00:00Z"), personId: d, distinctId: "user-d" },
    // B starts on the 21st and never returns.
    { ts: at("2026-10-21T09:00:00Z"), personId: b, distinctId: "user-b" },
    // C's first event is before the range, so it is in no cohort and its
    // later events count for no other cohort.
    { ts: at("2026-10-19T08:00:00Z"), personId: c, distinctId: "user-c" },
    { ts: at("2026-10-20T07:00:00Z"), personId: c, distinctId: "user-c" },
    { ts: at("2026-10-21T07:00:00Z"), personId: c, distinctId: "user-c" },
  ]);

  const result = await runRetention(project, specOf());
  expect(result.cohorts.map((cohort) => cohort.start)).toEqual([
    "2026-10-20",
    "2026-10-21",
    "2026-10-22",
  ]);
  expect(result.cohorts.map((cohort) => cohort.size)).toEqual([2, 1, 0]);
  // Cohort 20: A in 21, D in 22, A in 23, over the two people who started on
  // the 20th.
  expect(result.cohorts[0]?.periods).toEqual([
    { people: 1, rate: 0.5 },
    { people: 1, rate: 0.5 },
    { people: 1, rate: 0.5 },
  ]);
  // Cohort 21: B never returns, and an empty cohort still shows its periods.
  expect(result.cohorts[1]?.periods).toEqual([
    { people: 0, rate: 0 },
    { people: 0, rate: 0 },
  ]);
  // An empty cohort's rate has a zero denominator, so it is null (D-20).
  expect(result.cohorts[2]?.periods).toEqual([{ people: 0, rate: null }]);
});

it("query-62 · an anonymous visitor forms a cohort by its distinct id", async () => {
  const project = newProjectId();
  const a = await seedPerson(project, ["user-a"]);
  await seedEvents(project, [
    // A, a person, starts on the 20th and returns on the 21st.
    { ts: at("2026-10-20T08:00:00Z"), personId: a, distinctId: "user-a" },
    { ts: at("2026-10-21T08:00:00Z"), personId: a, distinctId: "user-a" },
    // Two anonymous visitors start on the 20th; anon-1 returns on the 22nd.
    { ts: at("2026-10-20T09:00:00Z"), distinctId: "anon-1" },
    { ts: at("2026-10-22T09:00:00Z"), distinctId: "anon-1" },
    { ts: at("2026-10-20T10:00:00Z"), distinctId: "anon-2" },
  ]);

  const result = await runRetention(project, specOf());
  expect(result.cohorts.map((cohort) => cohort.size)).toEqual([3, 0, 0]);
  // Cohort 20: A in 21, anon-1 in 22, nobody in 23, over three visitors.
  expect(result.cohorts[0]?.periods).toEqual([
    { people: 1, rate: 1 / 3 },
    { people: 1, rate: 1 / 3 },
    { people: 0, rate: 0 },
  ]);
});

it("query-63 · named start and return events, bots and internal traffic left out, last bucket no cohort", async () => {
  const project = newProjectId();
  const a = await seedPerson(project, ["user-a"]);
  const b = await seedPerson(project, ["user-b"]);
  const c = await seedPerson(project, ["user-c"], { team: "internal" });
  const d = await seedPerson(project, ["user-d"]);
  const e = await seedPerson(project, ["user-e"]);
  const f = await seedPerson(project, ["user-f"]);
  await seedEvents(project, [
    // A starts on the 20th and buys on the 21st.
    { ts: at("2026-10-20T08:00:00Z"), event: "$pageview", personId: a, distinctId: "user-a" },
    { ts: at("2026-10-21T08:00:00Z"), event: "purchase", personId: a, distinctId: "user-a" },
    // B is a bot, in neither the cohort nor the returns.
    {
      ts: at("2026-10-20T09:00:00Z"),
      event: "$pageview",
      personId: b,
      distinctId: "user-b",
      bot: true,
    },
    {
      ts: at("2026-10-21T09:00:00Z"),
      event: "purchase",
      personId: b,
      distinctId: "user-b",
      bot: true,
    },
    // C is internal, in neither.
    { ts: at("2026-10-20T10:00:00Z"), event: "$pageview", personId: c, distinctId: "user-c" },
    { ts: at("2026-10-21T10:00:00Z"), event: "purchase", personId: c, distinctId: "user-c" },
    // D starts on the 20th, but its single purchase is a bot's.
    { ts: at("2026-10-20T11:00:00Z"), event: "$pageview", personId: d, distinctId: "user-d" },
    {
      ts: at("2026-10-21T11:00:00Z"),
      event: "purchase",
      personId: d,
      distinctId: "user-d",
      bot: true,
    },
    // E starts in the last bucket, which has no return period after it.
    { ts: at("2026-10-23T08:00:00Z"), event: "$pageview", personId: e, distinctId: "user-e" },
    // F starts on the 21st and buys on the 22nd.
    { ts: at("2026-10-21T12:00:00Z"), event: "$pageview", personId: f, distinctId: "user-f" },
    { ts: at("2026-10-22T08:00:00Z"), event: "purchase", personId: f, distinctId: "user-f" },
  ]);

  const rules: InternalRule[] = [{ kind: "person_property", property: "team", value: "internal" }];
  const scope = exclusionsSql(rules, { includeBots: false, includeInternal: false });
  const retention = specOf({ timeZone: OSLO, startEvent: "$pageview", returnEvent: "purchase" });
  const result = await runRetention(project, retention, scope.where);

  // The 23rd starts with E, yet it is left out: no bucket follows it.
  expect(result.cohorts.map((cohort) => cohort.start)).toEqual([
    "2026-10-20",
    "2026-10-21",
    "2026-10-22",
  ]);
  expect(result.cohorts.map((cohort) => cohort.size)).toEqual([2, 1, 0]);
  // Cohort 20: A buys on the 21st, D's buy is a bot's, F belongs to cohort 21.
  expect(result.cohorts[0]?.periods).toEqual([
    { people: 1, rate: 0.5 },
    { people: 0, rate: 0 },
    { people: 0, rate: 0 },
  ]);
  expect(result.cohorts[1]?.periods).toEqual([
    { people: 1, rate: 1 },
    { people: 0, rate: 0 },
  ]);
  // An empty cohort's rate has a zero denominator, so it is null (D-20).
  expect(result.cohorts[2]?.periods).toEqual([{ people: 0, rate: null }]);
});
