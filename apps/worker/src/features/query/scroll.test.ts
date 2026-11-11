import type {
  InternalRule,
  Json,
  JsonObject,
  Range,
  ScrollDepthResult,
  ScrollDepthSpec,
} from "@cfanalytics/shared";
import { expect, it } from "vitest";
import { EVERY_EVENT, resolved, runStatements } from "../../../test/helpers/query.ts";
import { newProjectId } from "../../../test/helpers/registry.ts";
import { type SeedEvent, seedEvents, seedPerson } from "../../../test/helpers/seed.ts";
import { exclusionsSql } from "./filters.ts";
import { answerScrollDepth, compileScrollDepth } from "./scroll.ts";

// Scroll depth through a real ProjectStore (heatmaps-03, heatmaps-16 to
// heatmaps-18). A view is a $pageleave or $pageview whose
// $prev_pageview_pathname names the page, so each event below is one view of
// "/p" with its own id and percentage.

const at = (iso: string): number => Date.parse(iso);

const ONE_DAY: Range = {
  kind: "between",
  from: "2026-10-20T00:00:00+02:00",
  to: "2026-10-21T00:00:00+02:00",
};

function view(
  prevPath: string,
  id: string | null,
  percentage: Json,
  extra: JsonObject = {},
  overrides: Partial<SeedEvent> = {},
): SeedEvent {
  const properties: JsonObject = {
    ...extra,
    $prev_pageview_pathname: prevPath,
    $prev_pageview_max_content_percentage: percentage,
  };
  if (id !== null) properties.$prev_pageview_id = id;
  return { ts: at("2026-10-20T10:00:00Z"), event: "$pageleave", properties, ...overrides };
}

function specOf(path: string, overrides: Partial<ScrollDepthSpec> = {}): ScrollDepthSpec {
  return { kind: "scroll_depth", range: ONE_DAY, path, ...overrides };
}

/** Scroll depth through the compiled statement and the store's own RPC call. */
async function runScroll(
  project: string,
  spec: ScrollDepthSpec,
  scope: Parameters<typeof compileScrollDepth>[2] = EVERY_EVENT,
): Promise<ScrollDepthResult> {
  const compiled = compileScrollDepth(spec, resolved(spec.range, spec.timeZone), scope);
  return answerScrollDepth(await runStatements(project, compiled));
}

it("heatmaps-03 · reached holds the share at each tenth, a percentage above 1 as 1", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    view("/p", "pv-1", 0.1),
    view("/p", "pv-2", 0.35),
    view("/p", "pv-3", 1),
    view("/p", "pv-4", 1.5),
    // A negative percentage and one that is not a number add no view.
    view("/p", "pv-5", -0.5),
    view("/p", "pv-6", "high"),
  ]);

  const result = await runScroll(project, specOf("/p"));
  // Four views: 0.1, 0.35, 1 and 1.5, the last counted as 1.
  expect(result.views).toBe(4);
  expect(result.reached).toEqual([1, 0.75, 0.75, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
});

it("heatmaps-16 · a pageview's scroll belongs to the page it came from", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    {
      ts: at("2026-10-20T10:00:00Z"),
      event: "$pageview",
      properties: {
        $pathname: "/new",
        $prev_pageview_pathname: "/old",
        $prev_pageview_id: "pv-1",
        $prev_pageview_max_content_percentage: 0.5,
      },
    },
  ]);

  expect((await runScroll(project, specOf("/old"))).views).toBe(1);
  expect((await runScroll(project, specOf("/new"))).views).toBe(0);
});

it("heatmaps-17 · an id counts once with its greatest percentage; no id or the disable flag adds none", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    view("/p", "pv-1", 0.2),
    view("/p", "pv-1", 0.8),
    view("/p", null, 0.9),
    view("/p", "pv-2", 0.9, { $prev_pageview_disable_scroll_properties: true }),
  ]);

  const result = await runScroll(project, specOf("/p"));
  expect(result.views).toBe(1);
  // The greatest percentage is 0.8, so eight tenths are reached and the ninth
  // is not.
  expect(result.reached[0]).toBe(1);
  expect(result.reached[7]).toBe(1);
  expect(result.reached[8]).toBe(0);
});

it("heatmaps-18 · the scope leaves bots and internal traffic out of the views", async () => {
  const project = newProjectId();
  const insider = await seedPerson(project, ["user-insider"], { team: "internal" });
  await seedEvents(project, [
    view("/p", "pv-bot", 0.9, {}, { bot: true }),
    view("/p", "pv-insider", 0.9, {}, { personId: insider, distinctId: "user-insider" }),
    view("/p", "pv-normal", 0.1),
  ]);

  const rules: InternalRule[] = [{ kind: "person_property", property: "team", value: "internal" }];
  const scope = exclusionsSql(rules, { includeBots: false, includeInternal: false });
  const result = await runScroll(project, specOf("/p"), scope.where);

  expect(scope.applied).toEqual([0]);
  expect(result.views).toBe(1);
  expect(result.reached[0]).toBe(1);
  expect(result.reached[8]).toBe(0);
});
