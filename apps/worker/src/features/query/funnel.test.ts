import type { FunnelResult, FunnelSpec, Range } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import { DAY_MS, HOUR_MS } from "../../../test/helpers/capture.ts";
import { EVERY_EVENT, resolved, runStatements } from "../../../test/helpers/query.ts";
import { newProjectId } from "../../../test/helpers/registry.ts";
import { seedEvents, seedPerson } from "../../../test/helpers/seed.ts";
import { answerFunnel, compileFunnel } from "./funnel.ts";

// The funnel through a real ProjectStore (query-03, query-04, query-21 to
// query-24, query-28 to query-30, query-32). Every expected count is worked out
// by hand from the contract. All events sit inside one Oslo day.

const at = (iso: string): number => Date.parse(iso);

const RANGE: Range = {
  kind: "between",
  from: "2026-10-20T00:00:00+02:00",
  to: "2026-10-21T00:00:00+02:00",
};

const TWO_STEPS = [
  { id: "view", event: "view" },
  { id: "buy", event: "buy" },
];

const THREE_STEPS = [...TWO_STEPS, { id: "renew", event: "renew" }];

/** An event's country property, for a breakdown by country (query-128). */
const country = (code: string) => ({ $geoip_country_code: code });

function specOf(
  steps: { id: string; event: string }[],
  overrides: Partial<FunnelSpec> = {},
): FunnelSpec {
  return { kind: "funnel", range: RANGE, steps, windowMs: DAY_MS, ...overrides };
}

/** The funnel through the compiled statement and the store's own RPC call. */
async function runFunnel(project: string, funnel: FunnelSpec): Promise<FunnelResult> {
  const compiled = compileFunnel(funnel, resolved(funnel.range, funnel.timeZone), EVERY_EVENT);
  return answerFunnel(funnel, await runStatements(project, compiled));
}

const counts = (result: FunnelResult): number[] => result.steps.map((step) => step.count);

it("query-03 · only the person who did both steps in the window converts", async () => {
  const project = newProjectId();
  const buyer = await seedPerson(project, ["user-1"]);
  const viewer = await seedPerson(project, ["user-2"]);
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), event: "view", personId: buyer, distinctId: "user-1" },
    { ts: at("2026-10-20T11:00:00Z"), event: "buy", personId: buyer, distinctId: "user-1" },
    // This one bought before it ever looked, so its look is too late.
    { ts: at("2026-10-20T10:00:00Z"), event: "buy", personId: viewer, distinctId: "user-2" },
    { ts: at("2026-10-20T11:00:00Z"), event: "view", personId: viewer, distinctId: "user-2" },
  ]);

  expect(counts(await runFunnel(project, specOf(TWO_STEPS)))).toEqual([2, 1]);
});

it("query-04 · a step exactly one window after the entry counts, a later one does not", async () => {
  const project = newProjectId();
  const onTime = await seedPerson(project, ["user-1"]);
  const late = await seedPerson(project, ["user-2"]);
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), event: "view", personId: onTime, distinctId: "user-1" },
    { ts: at("2026-10-20T11:00:00Z"), event: "buy", personId: onTime, distinctId: "user-1" },
    { ts: at("2026-10-20T10:00:00Z"), event: "view", personId: late, distinctId: "user-2" },
    { ts: at("2026-10-20T11:00:01Z"), event: "buy", personId: late, distinctId: "user-2" },
  ]);

  expect(counts(await runFunnel(project, specOf(TWO_STEPS, { windowMs: HOUR_MS })))).toEqual([
    2, 1,
  ]);
});

it("query-21 · one event never fills two steps", async () => {
  const once = newProjectId();
  const person = await seedPerson(once, ["user-1"]);
  await seedEvents(once, [
    { ts: at("2026-10-20T10:00:00Z"), personId: person, distinctId: "user-1" },
  ]);
  const sameEvent = [
    { id: "first", event: "$pageview" },
    { id: "second", event: "$pageview" },
  ];
  expect(counts(await runFunnel(once, specOf(sameEvent)))).toEqual([1, 0]);

  const twice = newProjectId();
  const other = await seedPerson(twice, ["user-1"]);
  await seedEvents(twice, [
    { ts: at("2026-10-20T10:00:00Z"), personId: other, distinctId: "user-1" },
    { ts: at("2026-10-20T11:00:00Z"), personId: other, distinctId: "user-1" },
  ]);
  expect(counts(await runFunnel(twice, specOf(sameEvent)))).toEqual([1, 1]);
});

it("query-22 · the window starts at the person's entry, not at the first event seen", async () => {
  const project = newProjectId();
  const person = await seedPerson(project, ["user-1"]);
  await seedEvents(project, [
    // An early buy that cannot fill the second step.
    { ts: at("2026-10-20T09:00:00Z"), event: "buy", personId: person, distinctId: "user-1" },
    { ts: at("2026-10-20T10:00:00Z"), event: "view", personId: person, distinctId: "user-1" },
    { ts: at("2026-10-20T11:00:00Z"), event: "buy", personId: person, distinctId: "user-1" },
  ]);

  expect(counts(await runFunnel(project, specOf(TWO_STEPS, { windowMs: 2 * HOUR_MS })))).toEqual([
    1, 1,
  ]);
});

it("query-23 · at equal times the earlier stored event of the step is the one that counts", async () => {
  const project = newProjectId();
  const person = await seedPerson(project, ["user-1"]);
  // Inserted in this order, so the ids rise down the list. The second buy has
  // a later id than the renew, the first buy an earlier one.
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), event: "view", personId: person, distinctId: "user-1" },
    { ts: at("2026-10-20T11:00:00Z"), event: "buy", personId: person, distinctId: "user-1" },
    { ts: at("2026-10-20T11:00:00Z"), event: "renew", personId: person, distinctId: "user-1" },
    { ts: at("2026-10-20T11:00:00Z"), event: "buy", personId: person, distinctId: "user-1" },
  ]);

  expect(counts(await runFunnel(project, specOf(THREE_STEPS)))).toEqual([1, 1, 1]);
});

it("query-24 · the whole window runs from the entry, after every step", async () => {
  const project = newProjectId();
  const person = await seedPerson(project, ["user-1"]);
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), event: "view", personId: person, distinctId: "user-1" },
    { ts: at("2026-10-20T10:50:00Z"), event: "buy", personId: person, distinctId: "user-1" },
    // Eighty minutes after the entry, so past the one hour window.
    { ts: at("2026-10-20T11:20:00Z"), event: "renew", personId: person, distinctId: "user-1" },
  ]);

  expect(counts(await runFunnel(project, specOf(THREE_STEPS, { windowMs: HOUR_MS })))).toEqual([
    1, 1, 0,
  ]);
});

it("query-28 · each step carries its counts, rates from the start and previous, and drop-off", async () => {
  const project = newProjectId();
  const renews = await seedPerson(project, ["user-1"]);
  const buys = await seedPerson(project, ["user-2"]);
  const looks = await seedPerson(project, ["user-3"]);
  const idles = await seedPerson(project, ["user-4"]);
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), event: "view", personId: renews, distinctId: "user-1" },
    { ts: at("2026-10-20T11:00:00Z"), event: "buy", personId: renews, distinctId: "user-1" },
    { ts: at("2026-10-20T12:00:00Z"), event: "renew", personId: renews, distinctId: "user-1" },
    { ts: at("2026-10-20T10:00:00Z"), event: "view", personId: buys, distinctId: "user-2" },
    { ts: at("2026-10-20T11:00:00Z"), event: "buy", personId: buys, distinctId: "user-2" },
    { ts: at("2026-10-20T10:00:00Z"), event: "view", personId: looks, distinctId: "user-3" },
    { ts: at("2026-10-20T10:00:00Z"), event: "view", personId: idles, distinctId: "user-4" },
  ]);

  const result = await runFunnel(project, specOf(THREE_STEPS));
  expect(counts(result)).toEqual([4, 2, 1]);
  expect(result.steps[0]?.rateFromStart).toBe(1);
  expect(result.steps[0]?.dropOff).toBe(0);
  expect(result.steps[1]?.rateFromStart).toBe(0.5);
  expect(result.steps[1]?.rateFromPrevious).toBe(0.5);
  expect(result.steps[1]?.dropOff).toBe(2);
  expect(result.steps[2]?.rateFromStart).toBe(0.25);
  expect(result.steps[2]?.rateFromPrevious).toBe(0.5);
  expect(result.steps[2]?.dropOff).toBe(1);
  expect(result.conversionRate).toBe(0.25);
  expect(result.largestDropOff).toBe(1);
});

it("query-28 · a tie for the largest drop-off names the earlier step", async () => {
  const project = newProjectId();
  const both = await seedPerson(project, ["user-1"]);
  const once = await seedPerson(project, ["user-2"]);
  const third = await seedPerson(project, ["user-3"]);
  const fourth = await seedPerson(project, ["user-4"]);
  const renews = await seedPerson(project, ["user-5"]);
  const renews2 = await seedPerson(project, ["user-6"]);
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), event: "view", personId: both, distinctId: "user-1" },
    { ts: at("2026-10-20T11:00:00Z"), event: "buy", personId: both, distinctId: "user-1" },
    { ts: at("2026-10-20T12:00:00Z"), event: "renew", personId: both, distinctId: "user-1" },
    { ts: at("2026-10-20T10:00:00Z"), event: "view", personId: renews, distinctId: "user-5" },
    { ts: at("2026-10-20T11:00:00Z"), event: "buy", personId: renews, distinctId: "user-5" },
    { ts: at("2026-10-20T12:00:00Z"), event: "renew", personId: renews, distinctId: "user-5" },
    { ts: at("2026-10-20T10:00:00Z"), event: "view", personId: renews2, distinctId: "user-6" },
    { ts: at("2026-10-20T11:00:00Z"), event: "buy", personId: renews2, distinctId: "user-6" },
    { ts: at("2026-10-20T10:00:00Z"), event: "view", personId: once, distinctId: "user-2" },
    { ts: at("2026-10-20T11:00:00Z"), event: "buy", personId: once, distinctId: "user-2" },
    { ts: at("2026-10-20T10:00:00Z"), event: "view", personId: third, distinctId: "user-3" },
    { ts: at("2026-10-20T10:00:00Z"), event: "view", personId: fourth, distinctId: "user-4" },
  ]);

  const result = await runFunnel(project, specOf(THREE_STEPS));
  // Six start, four buy, two renew: the drops are 2 and 2.
  expect(counts(result)).toEqual([6, 4, 2]);
  expect(result.steps.map((step) => step.dropOff)).toEqual([0, 2, 2]);
  expect(result.largestDropOff).toBe(1);
});

it("query-29 · with nobody at the first step every rate and the largest drop-off are null", async () => {
  const result = await runFunnel(newProjectId(), specOf(TWO_STEPS));
  expect(counts(result)).toEqual([0, 0]);
  for (const step of result.steps) {
    expect(step.rateFromStart).toBeNull();
    expect(step.rateFromPrevious).toBeNull();
    expect(step.dropOff).toBe(0);
  }
  expect(result.conversionRate).toBeNull();
  expect(result.largestDropOff).toBeNull();
});

it("query-30 · an event without a person counts for its distinct id, and a linked id for its person", async () => {
  const project = newProjectId();
  const person = await seedPerson(project, ["user-1", "anon-linked"]);
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), event: "view", personId: person, distinctId: "user-1" },
    { ts: at("2026-10-20T11:00:00Z"), event: "buy", personId: person, distinctId: "user-1" },
    // The same pair from an anonymous visitor, which has no person: one more visitor.
    { ts: at("2026-10-20T10:00:00Z"), event: "view", distinctId: "anon-1" },
    { ts: at("2026-10-20T11:00:00Z"), event: "buy", distinctId: "anon-1" },
    // A second anonymous visitor who only views.
    { ts: at("2026-10-20T12:00:00Z"), event: "view", distinctId: "anon-2" },
    // An id an identify linked to the person: its view and the person's buy
    // are one visitor, who converts once.
    { ts: at("2026-10-20T13:00:00Z"), event: "view", personId: person, distinctId: "anon-linked" },
    { ts: at("2026-10-20T14:00:00Z"), event: "buy", personId: person, distinctId: "user-1" },
  ]);

  // Visitors: the person, anon-1 and anon-2 view; the person and anon-1 buy.
  expect(counts(await runFunnel(project, specOf(TWO_STEPS)))).toEqual([3, 2]);
});

it("query-32 · a funnel is one statement", () => {
  const compiled = compileFunnel(specOf(THREE_STEPS), resolved(RANGE), EVERY_EVENT);
  expect(compiled.statements).toHaveLength(1);
});

it("query-128 · a breakdown splits the funnel by the first entry's value, keeping the largest groups", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    // A: enters from NO and buys. Its later entry from SE does not move it.
    { ts: at("2026-10-20T10:00:00Z"), event: "view", distinctId: "a", properties: country("NO") },
    { ts: at("2026-10-20T10:30:00Z"), event: "view", distinctId: "a", properties: country("SE") },
    { ts: at("2026-10-20T11:00:00Z"), event: "buy", distinctId: "a" },
    // B: enters from NO and stops.
    { ts: at("2026-10-20T10:00:00Z"), event: "view", distinctId: "b", properties: country("NO") },
    // C: enters from SE and buys.
    { ts: at("2026-10-20T10:00:00Z"), event: "view", distinctId: "c", properties: country("SE") },
    { ts: at("2026-10-20T11:00:00Z"), event: "buy", distinctId: "c" },
    // D: enters from DK and stops.
    { ts: at("2026-10-20T10:00:00Z"), event: "view", distinctId: "d", properties: country("DK") },
  ]);

  const result = await runFunnel(
    project,
    specOf(TWO_STEPS, { breakdown: { builtin: "country" }, breakdownLimit: 1 }),
  );

  // The whole funnel: four entered, two bought.
  expect(counts(result)).toEqual([4, 2]);
  // NO entered twice and is kept; SE and DK, once each, sum into Other: two
  // entered, C bought.
  expect(
    result.groups?.map((group) => ({
      key: group.key,
      other: group.other,
      counts: group.steps.map((step) => step.count),
    })),
  ).toEqual([
    { key: "NO", other: false, counts: [2, 1] },
    { key: "Other", other: true, counts: [2, 1] },
  ]);
  expect(result.groups?.[0]?.conversionRate).toBe(0.5);
});

it("query-128 · without a breakdown the answer has no groups", async () => {
  const project = newProjectId();
  await seedEvents(project, [{ ts: at("2026-10-20T10:00:00Z"), event: "view", distinctId: "a" }]);
  const result = await runFunnel(project, specOf(TWO_STEPS));
  expect(result.groups).toBeUndefined();
});
