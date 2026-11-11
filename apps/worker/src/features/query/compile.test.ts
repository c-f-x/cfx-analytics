import type {
  ApiIssue,
  Dimension,
  Filter,
  Granularity,
  InternalRule,
  QuerySpec,
  Range,
  TrendSpec,
} from "@cfanalytics/shared";
import { expect, it } from "vitest";
import { DAY_MS, HOUR_MS, iso, T0 } from "../../../test/helpers/capture.ts";
import { OSLO, queryContext } from "../../../test/helpers/query.ts";
import { answerQuery, type Prepared, prepareQuery } from "./compile.ts";
import type { QueryContext, StoreRows } from "./types.ts";

interface TrendInput {
  range?: Range;
  event?: string;
  filter?: Filter;
  timeZone?: string;
  granularity?: Granularity;
  compare?: boolean;
  breakdown?: Dimension;
  includeBots?: boolean;
  includeInternal?: boolean;
}

function trend(input: TrendInput = {}): TrendSpec {
  const spec: TrendSpec = {
    kind: "trend",
    range: input.range ?? { kind: "last_days", days: 7 },
    measure: "events",
    granularity: input.granularity ?? "day",
  };
  if (input.event !== undefined) spec.event = input.event;
  if (input.filter !== undefined) spec.filter = input.filter;
  if (input.timeZone !== undefined) spec.timeZone = input.timeZone;
  if (input.compare !== undefined) spec.compare = input.compare;
  if (input.breakdown !== undefined) spec.breakdown = input.breakdown;
  if (input.includeBots !== undefined) spec.includeBots = input.includeBots;
  if (input.includeInternal !== undefined) spec.includeInternal = input.includeInternal;
  return spec;
}

function preparedOf(spec: QuerySpec, context: QueryContext = queryContext()): Prepared {
  const result = prepareQuery(spec, context);
  if (!result.ok) {
    throw new Error(`the test's spec does not prepare: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function issuesOf(spec: QuerySpec, context: QueryContext = queryContext()): ApiIssue[] {
  const result = prepareQuery(spec, context);
  if (result.ok) {
    throw new Error(
      `expected a refusal, got ${result.value.compiled.statements.length} statements`,
    );
  }
  return result.error;
}

/** Rows as a store answers for a project with no events: one empty result per statement. */
const emptyRows = (prepared: Prepared): StoreRows => ({
  results: prepared.compiled.statements.map(() => []),
  rowsRead: 42,
});

const placeholderCount = (sql: string): number => sql.split("?").length - 1;
const values = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `v${index}`);

it("query-02 · every kind binds its names, values and times, one parameter per ?", () => {
  const name = 'it\'s "x" ); DROP TABLE events; --';
  const event = "ev'ent\" ); DROP TABLE events; --";
  const value = "va'lue\" 42";
  const from = "2026-10-14T10:00:00+02:00";
  const to = "2026-10-20T00:00:00Z";
  const range: Range = { kind: "between", from, to };
  const property = { of: "event" as const, name };
  const condition: Filter = { op: "eq", property, value };
  const specs: QuerySpec[] = [
    {
      kind: "trend",
      range,
      event,
      filter: condition,
      measure: "events",
      granularity: "day",
      breakdown: { property },
    },
    { kind: "top", range, event, filter: condition, measure: "events", dimension: { property } },
    {
      kind: "funnel",
      range,
      windowMs: 60_000,
      steps: [
        { id: "a", event, where: [{ op: "eq", property, value }] },
        { id: "b", event },
      ],
    },
    {
      kind: "retention",
      range,
      filter: condition,
      granularity: "day",
      startEvent: event,
      returnEvent: event,
    },
    { kind: "scroll_depth", range, path: "/pricing" },
    { kind: "events", range, event, filter: condition },
    { kind: "properties", range, event, filter: condition },
  ];
  for (const spec of specs) {
    const { compiled } = preparedOf(spec);
    expect(compiled.statements.length).toBeGreaterThan(0);
    for (const statement of compiled.statements) {
      expect(statement.sql).not.toContain(name);
      expect(statement.sql).not.toContain(event);
      expect(statement.sql).not.toContain(value);
      expect(statement.sql).not.toContain("2026-10-14");
      expect(statement.sql).not.toContain(from);
      expect(placeholderCount(statement.sql)).toBe(statement.params.length);
    }
  }
});

it("query-07 · the answer states that bots are excluded unless includeBots asks for them", () => {
  const quiet = trend();
  const quietPrepared = preparedOf(quiet);
  expect(quietPrepared.includeBots).toBe(false);
  expect(answerQuery(quiet, quietPrepared, emptyRows(quietPrepared)).meta.excluded.bots).toBe(true);

  const withBots = trend({ includeBots: true });
  const botsPrepared = preparedOf(withBots);
  expect(botsPrepared.includeBots).toBe(true);
  expect(answerQuery(withBots, botsPrepared, emptyRows(botsPrepared)).meta.excluded.bots).toBe(
    false,
  );
});

it("query-08 · the answer lists the internal rules it applied, none with includeInternal", () => {
  const rules: InternalRule[] = [
    { kind: "event_property", property: "internal", value: true },
    { kind: "person_property", property: "email", value: "owner@example.test" },
  ];
  const context = queryContext({ internalRules: rules });

  const quiet = trend();
  const quietPrepared = preparedOf(quiet, context);
  expect(quietPrepared.applied).toEqual([0, 1]);
  expect(
    answerQuery(quiet, quietPrepared, emptyRows(quietPrepared)).meta.excluded.internalRules,
  ).toEqual([0, 1]);

  const included = trend({ includeInternal: true });
  const includedPrepared = preparedOf(included, context);
  expect(includedPrepared.applied).toEqual([]);
  expect(
    answerQuery(included, includedPrepared, emptyRows(includedPrepared)).meta.excluded
      .internalRules,
  ).toEqual([]);
});

it("query-12 · meta holds the ISO UTC range, the time zone, the exclusions and rowsRead", () => {
  const spec = trend({ range: { kind: "between", from: iso(T0 - DAY_MS), to: iso(T0) } });
  const prepared = preparedOf(spec);
  const answer = answerQuery(spec, prepared, emptyRows(prepared));
  expect(answer.meta.range).toEqual({ from: iso(T0 - DAY_MS), to: iso(T0) });
  expect(answer.meta.timeZone).toBe(OSLO);
  expect(answer.meta.excluded).toEqual({ bots: true, internalRules: [], notApplicable: [] });
  expect(answer.meta.rowsRead).toBe(42);
  expect(answer.meta).not.toHaveProperty("requested");
  const unread = answerQuery(spec, prepared, { ...emptyRows(prepared), rowsRead: null });
  expect(unread.meta.rowsRead).toBeNull();
});

it("query-14 · with no timeZone the project's is used, and a named one wins", () => {
  const project = queryContext({ projectTimeZone: "America/New_York" });
  expect(preparedOf(trend(), project).range.timeZone).toBe("America/New_York");
  expect(preparedOf(trend({ timeZone: "Asia/Tokyo" }), project).range.timeZone).toBe("Asia/Tokyo");
});

it("query-31 · a filter binding more than 100 parameters is too_many_parameters at the body", () => {
  const property = { of: "event" as const, name: "value" };
  const filter: Filter = {
    all: [
      { op: "in", property, values: values(60) },
      { op: "in", property, values: values(60) },
    ],
  };
  expect(issuesOf(trend({ filter }))[0]).toMatchObject({ path: "", code: "too_many_parameters" });
});

it("query-37 · the passed clock resolves today the same twice", () => {
  const context = queryContext();
  const spec = trend({ range: { kind: "today" } });
  const first = preparedOf(spec, context);
  const second = preparedOf(spec, context);
  expect(first.range).toEqual(second.range);
  expect(first.compiled).toEqual(second.compiled);
  expect(first.range.from).toBe(Date.parse("2026-10-21T00:00:00+02:00"));
  expect(first.range.to).toBe(T0);
});

it("query-39 · a comparison of two periods with different bucket counts is refused at /compare", () => {
  // March 2026 is one calendar month; the same length before it touches January and February.
  const range: Range = {
    kind: "between",
    from: "2026-03-01T00:00:00+01:00",
    to: "2026-04-01T00:00:00+02:00",
  };
  expect(issuesOf(trend({ range, granularity: "month", compare: true }))[0]).toMatchObject({
    path: "/compare",
  });
});

it("query-39 · 513 hour buckets is too_many_buckets at /granularity", () => {
  const from = Date.parse("2026-11-01T00:00:00+01:00");
  const range: Range = { kind: "between", from: iso(from), to: iso(from + 513 * HOUR_MS) };
  expect(issuesOf(trend({ range, granularity: "hour" }))[0]).toMatchObject({
    path: "/granularity",
    code: "too_many_buckets",
  });
});

it("query-40 · a range before retentionStart is clipped, and the answer keeps what was asked", () => {
  const context = queryContext({ now: T0, retentionStart: T0 - 90 * DAY_MS });
  const asked = { from: T0 - 100 * DAY_MS, to: T0 - DAY_MS };
  const spec = trend({ range: { kind: "between", from: iso(asked.from), to: iso(asked.to) } });
  const prepared = preparedOf(spec, context);
  expect(prepared.range).toMatchObject({
    from: T0 - 90 * DAY_MS,
    to: asked.to,
    requested: asked,
  });
  const answer = answerQuery(spec, prepared, emptyRows(prepared));
  expect(answer.meta.range).toEqual({ from: iso(T0 - 90 * DAY_MS), to: iso(asked.to) });
  expect(answer.meta.requested).toEqual({ from: iso(asked.from), to: iso(asked.to) });
});
