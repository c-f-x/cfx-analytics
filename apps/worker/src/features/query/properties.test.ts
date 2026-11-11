import type { PropertiesResult, PropertiesSpec, Range } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import { EVERY_EVENT, resolved, runStatements } from "../../../test/helpers/query.ts";
import { newProjectId } from "../../../test/helpers/registry.ts";
import { seedEvents } from "../../../test/helpers/seed.ts";
import { answerProperties, compileProperties } from "./properties.ts";

// The property names through a real ProjectStore (query-51). Each event below
// holds one of each JSON type, plus a plan that appears as text twice and as an
// integer once, so the two types of that name have to be counted separately.

const at = (iso: string): number => Date.parse(iso);

const ONE_DAY: Range = {
  kind: "between",
  from: "2026-10-20T00:00:00+02:00",
  to: "2026-10-21T00:00:00+02:00",
};

/** The property names through the compiled statement and the store's RPC call. */
async function runProperties(project: string): Promise<PropertiesResult> {
  const spec: PropertiesSpec = { kind: "properties", range: ONE_DAY };
  const compiled = compileProperties(spec, resolved(ONE_DAY), EVERY_EVENT);
  return answerProperties(await runStatements(project, compiled));
}

it("query-51 · each name is listed once with its JSON types, and plans of two types show both", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    {
      ts: at("2026-10-20T10:00:00Z"),
      properties: { plan: "pro", n: 1, flag: true, nothing: null, arr: [1], obj: { a: 1 } },
    },
    { ts: at("2026-10-20T11:00:00Z"), properties: { plan: "free" } },
    { ts: at("2026-10-20T12:00:00Z"), properties: { plan: 7 } },
  ]);

  const result = await runProperties(project);
  // Names ascend. Types of one name go by count descending, then type ascending,
  // so the two text plans come before the one integer plan.
  expect(result.properties).toEqual([
    { name: "arr", types: [{ type: "array", count: 1 }] },
    { name: "flag", types: [{ type: "true", count: 1 }] },
    { name: "n", types: [{ type: "integer", count: 1 }] },
    { name: "nothing", types: [{ type: "null", count: 1 }] },
    { name: "obj", types: [{ type: "object", count: 1 }] },
    {
      name: "plan",
      types: [
        { type: "text", count: 2 },
        { type: "integer", count: 1 },
      ],
    },
  ]);
  expect(result.events).toBe(3);
});

it("query-51 · the catalogue reads the newest 10,000 events of the range and says so", async () => {
  const project = newProjectId();
  const start = at("2026-10-20T00:00:00Z");
  // The oldest event alone holds old_only, so the sample leaves it out.
  await seedEvents(project, [
    { ts: start, properties: { old_only: 1 } },
    ...Array.from({ length: 10_000 }, (_value, index) => ({
      ts: start + 1000 + index,
      properties: { plan: "pro" },
    })),
  ]);

  const result = await runProperties(project);
  expect(result.events).toBe(10_000);
  expect(result.properties).toEqual([{ name: "plan", types: [{ type: "text", count: 10_000 }] }]);
});
