import { type ApiIssue, type Filter, QUERY_KINDS, type Range } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import { parseSpec } from "./validate.ts";

const DAY: Range = { kind: "last_days", days: 7 };
const eventProperty = (name: string) => ({ of: "event" as const, name });
const step = (index: number) => ({ id: `s${index}`, event: `event_${index}` });
const values = (count: number) => Array.from({ length: count }, (_, index) => `v${index}`);

/** A condition wrapped in `depth - 1` groups: a condition alone is depth 1. */
const nested = (depth: number): Filter => {
  let filter: Filter = { op: "eq", property: eventProperty("n"), value: 1 };
  for (let level = 1; level < depth; level += 1) filter = { all: [filter] };
  return filter;
};

function trend(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "trend", range: DAY, measure: "events", granularity: "day", ...overrides };
}

function funnel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "funnel",
    range: DAY,
    windowMs: 3_600_000,
    steps: [
      { id: "a", event: "one" },
      { id: "b", event: "two" },
    ],
    ...overrides,
  };
}

function issuesOf(body: unknown): ApiIssue[] {
  const result = parseSpec(body);
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.value)}`);
  return result.error;
}

const pathsOf = (body: unknown): string[] => issuesOf(body).map((issue) => issue.path);
const passes = (body: unknown): boolean => parseSpec(body).ok;

it("query-18 · an unknown key, a wrong type and a missing field each report their first path", () => {
  expect(pathsOf({ ...trend(), project: "p_1" })[0]).toBe("");
  expect(pathsOf(trend({ measure: 7 }))[0]).toBe("/measure");
  expect(pathsOf({ kind: "trend", range: DAY, granularity: "day" })[0]).toBe("/measure");
});

it("query-25 · a funnel of 1 or 11 steps is refused at its steps, and 2 and 10 pass", () => {
  expect(pathsOf(funnel({ steps: [step(0)] }))[0]).toBe("/steps");
  expect(pathsOf(funnel({ steps: Array.from({ length: 11 }, (_, index) => step(index)) }))[0]).toBe(
    "/steps",
  );
  expect(passes(funnel({ steps: [step(0), step(1)] }))).toBe(true);
  expect(passes(funnel({ steps: Array.from({ length: 10 }, (_, index) => step(index)) }))).toBe(
    true,
  );
});

it("query-25 · a missing, zero, negative or fractional windowMs is refused", () => {
  expect(pathsOf({ kind: "funnel", range: DAY, steps: [step(0), step(1)] })).toContain("/windowMs");
  for (const windowMs of [0, -1, 1.5]) expect(pathsOf(funnel({ windowMs }))).toContain("/windowMs");
});

it("query-26 · two steps on the same event with different ids pass, and a step id is a slug", () => {
  expect(
    passes(
      funnel({
        steps: [
          { id: "a", event: "same" },
          { id: "b", event: "same" },
        ],
      }),
    ),
  ).toBe(true);
  expect(
    pathsOf(
      funnel({
        steps: [
          { id: "a", event: "one" },
          { id: "a", event: "two" },
        ],
      }),
    )[0],
  ).toBe("/steps/1/id");
  expect(
    pathsOf(
      funnel({
        steps: [
          { id: "a", event: "one" },
          { id: "b c", event: "two" },
        ],
      }),
    )[0],
  ).toBe("/steps/1/id");
});

it("query-27 · a step naming a list of events or a person property is refused at that step", () => {
  expect(
    pathsOf(
      funnel({
        steps: [
          { id: "a", event: ["one"] },
          { id: "b", event: "two" },
        ],
      }),
    )[0],
  ).toBe("/steps/0/event");
  expect(
    pathsOf(
      funnel({
        steps: [
          {
            id: "a",
            event: "one",
            where: [
              { op: "eq", property: { of: "person", name: "email" }, value: "owner@example.test" },
            ],
          },
          { id: "b", event: "two" },
        ],
      }),
    )[0],
  ).toBe("/steps/0/where/0/property/of");
});

it("query-47 · an unknown built-in dimension is refused at /dimension, and any property passes", () => {
  expect(
    pathsOf({ kind: "top", range: DAY, dimension: { builtin: "city" }, measure: "events" })[0],
  ).toBe("/dimension");
  expect(
    passes({
      kind: "top",
      range: DAY,
      dimension: { property: eventProperty("anything") },
      measure: "events",
    }),
  ).toBe(true);
});

it("query-50 · a contains term over 50 UTF-8 bytes is refused at its value, and 50 bytes pass", () => {
  const over = `${"é".repeat(25)}a`;
  expect(new TextEncoder().encode(over).length).toBe(51);
  expect(
    pathsOf(trend({ filter: { op: "contains", property: eventProperty("text"), value: over } }))[0],
  ).toBe("/filter/value");
  expect(
    passes(
      trend({ filter: { op: "contains", property: eventProperty("text"), value: "é".repeat(25) } }),
    ),
  ).toBe(true);
});

it("query-56 · a between whose low is above its high is refused at that condition", () => {
  const reversed = trend({
    filter: { op: "between", property: eventProperty("n"), low: 5, high: 1 },
  });
  expect(pathsOf(reversed)[0]).toBe("/filter");
});

it("query-59 · a filter 9 levels deep is refused and 8 levels pass", () => {
  const refused = pathsOf(trend({ filter: nested(9) }));
  expect(refused).toHaveLength(1);
  expect(refused[0]?.startsWith("/filter")).toBe(true);
  expect(passes(trend({ filter: nested(8) }))).toBe(true);
});

it("query-59 · an in list of 101 values is refused at its values, and 100 pass", () => {
  const property = eventProperty("n");
  expect(pathsOf(trend({ filter: { op: "in", property, values: values(101) } }))[0]).toBe(
    "/filter/values",
  );
  expect(passes(trend({ filter: { op: "in", property, values: values(100) } }))).toBe(true);
});

it("platform-34 · a missing or unknown kind is one unknown_kind issue at /kind naming the kinds", () => {
  const bodies = [{ range: DAY }, { ...trend(), kind: "cohorts" }, "trend", null];
  for (const body of bodies) {
    const issues = issuesOf(body);
    expect(issues).toHaveLength(1);
    const [issue] = issues;
    if (issue === undefined) throw new Error("expected one issue");
    expect(issue.path).toBe("/kind");
    expect(issue.code).toBe("unknown_kind");
    for (const kind of QUERY_KINDS) expect(issue.message).toContain(kind);
  }
});
