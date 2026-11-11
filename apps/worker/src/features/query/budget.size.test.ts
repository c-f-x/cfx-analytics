// The rows-read budget at real size (query-09, query-13): spike S1's fixture,
// about 2 million events over 13 months, seeded once for the file. It takes
// about 30 s on a quiet machine and over two minutes on a busy one, so
// `pnpm test` leaves *.size.test.ts out and `pnpm test:size` runs it;
// `pnpm check` and CI run both. The seeding has no deadline of its own: each
// of its batches and each query here has a hang deadline instead.
import {
  QUERY,
  QUERY_KINDS,
  type QueryKind,
  type QuerySpec,
  type Range,
} from "@cfanalytics/shared";
import { beforeAll, expect, it } from "vitest";
import { T0 } from "../../../test/helpers/capture.ts";
import { withinHang } from "../../../test/helpers/hang.ts";
import { queryContext, runStatements } from "../../../test/helpers/query.ts";
import { newProjectId } from "../../../test/helpers/registry.ts";
import { S1_FIXTURE, seedFixture } from "../../../test/helpers/seed.ts";
import { answerQuery, prepareQuery } from "./compile.ts";
import type { CompiledQuery } from "./types.ts";

const project = newProjectId();
const RANGE: Range = { kind: "last_days", days: S1_FIXTURE.days };

const CASES: { kind: QueryKind; spec: QuerySpec }[] = [
  { kind: "trend", spec: { kind: "trend", range: RANGE, measure: "events", granularity: "day" } },
  {
    kind: "trend",
    spec: { kind: "trend", range: RANGE, measure: "visitors", granularity: "week" },
  },
  {
    kind: "trend",
    spec: {
      kind: "trend",
      range: RANGE,
      measure: "events",
      granularity: "week",
      breakdown: { builtin: "country" },
    },
  },
  {
    kind: "top",
    spec: { kind: "top", range: RANGE, dimension: { builtin: "page" }, measure: "events" },
  },
  {
    kind: "funnel",
    spec: {
      kind: "funnel",
      range: RANGE,
      windowMs: 3_600_000,
      steps: [
        { id: "a", event: "$pageview" },
        { id: "b", event: "$autocapture" },
      ],
    },
  },
  {
    kind: "funnel",
    spec: {
      kind: "funnel",
      range: RANGE,
      windowMs: 3_600_000,
      steps: [
        { id: "a", event: "$pageview" },
        { id: "b", event: "$autocapture" },
      ],
      breakdown: { builtin: "country" },
    },
  },
  { kind: "retention", spec: { kind: "retention", range: RANGE, granularity: "week" } },
  { kind: "scroll_depth", spec: { kind: "scroll_depth", range: RANGE, path: "/page-1" } },
  { kind: "events", spec: { kind: "events", range: RANGE } },
  { kind: "properties", spec: { kind: "properties", range: RANGE } },
];

function compiledOf(spec: QuerySpec): CompiledQuery {
  const prepared = prepareQuery(spec, queryContext());
  if (!prepared.ok)
    throw new Error(`the test's spec does not prepare: ${JSON.stringify(prepared.error)}`);
  return prepared.value.compiled;
}

beforeAll(async () => {
  await seedFixture(project, S1_FIXTURE);
}, 0);

for (const [index, { kind, spec }] of CASES.entries()) {
  it(`query-09 · case ${index}, a ${kind}, over 13 months of S1's size reads at most rowsReadBudget`, async () => {
    const rows = await runStatements(project, compiledOf(spec));
    if (rows.rowsRead === null) throw new Error("the store reported no rowsRead");
    expect(rows.rowsRead).toBeLessThanOrEqual(QUERY.rowsReadBudget);
    expect(rows.rowsRead).toBeGreaterThan(0);
  });
}

it("query-13 · the cases cover every kind, and every answer's rowsRead is a number", async () => {
  expect(new Set(CASES.map(({ kind }) => kind))).toEqual(new Set(QUERY_KINDS));
  for (const { spec } of CASES) {
    const prepared = prepareQuery(spec, queryContext());
    if (!prepared.ok)
      throw new Error(`the test's spec does not prepare: ${JSON.stringify(prepared.error)}`);
    // The queries share one object, so they run one at a time.
    // oxlint-disable-next-line no-await-in-loop
    const rows = await withinHang(runStatements(project, prepared.value.compiled), spec.kind);
    const answer = answerQuery(spec, prepared.value, rows);
    expect(typeof answer.meta.rowsRead).toBe("number");
  }
}, 0);

it("query-09 · the fixture spans 13 months up to the test's clock", async () => {
  const rows = await runStatements(project, {
    statements: [
      {
        sql: "SELECT min(ts) AS first, max(ts) AS last, count(*) AS total FROM events",
        params: [],
      },
    ],
  });
  expect(rows.results[0]?.[0]?.[2]).toBe(S1_FIXTURE.events);
  const oldest = rows.results[0]?.[0]?.[0];
  if (typeof oldest !== "number") throw new Error("expected a numeric first ts");
  expect(oldest).toBe(T0 - S1_FIXTURE.days * 24 * 60 * 60 * 1000);
});
