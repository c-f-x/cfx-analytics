import { querySpec, STANDARD_TILES } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import { boardFrom, DEFAULT_BOARD, querySpecOf } from "./board.ts";

// The board's query rule: every standard tile under any board state is a
// spec the API accepts.

it("dashboard-02 · every standard tile under the default board is a valid query spec", () => {
  for (const tile of STANDARD_TILES) {
    expect(querySpec.safeParse(querySpecOf(tile.spec, DEFAULT_BOARD)).success).toBe(true);
  }
});

it("dashboard-02 · filters, include and compare reach the spec, and the period sets the trend's buckets", () => {
  const board = boardFrom({
    period: "90d",
    compare: "false",
    include: "true",
    filters: [
      { property: "$channel", value: "organic_search" },
      { property: "$browser", value: "Safari" },
    ],
  });
  const [visitors] = STANDARD_TILES;
  if (visitors === undefined) throw new Error("no standard tile");
  const spec = querySpecOf(visitors.spec, board);
  expect(spec).toMatchObject({
    kind: "trend",
    range: { kind: "last_days", days: 90 },
    granularity: "week",
    includeBots: true,
    includeInternal: true,
    filter: {
      all: [
        { op: "eq", property: { of: "event", name: "$channel" }, value: "organic_search" },
        { op: "eq", property: { of: "event", name: "$browser" }, value: "Safari" },
      ],
    },
  });
  expect(spec).not.toHaveProperty("compare");
  expect(querySpec.safeParse(spec).success).toBe(true);
});

it("dashboard-01 · an address that holds nothing understood is the default board", () => {
  expect(boardFrom({ period: "forever", filters: "x", compare: 3 })).toEqual(DEFAULT_BOARD);
});
