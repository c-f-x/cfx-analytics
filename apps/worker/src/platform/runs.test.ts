import { expect, it } from "vitest";
import { runsOf } from "./runs.ts";

// Splitting a list into runs, so one SQL statement stays within the bound
// parameter limit and one R2 call within its key limit (events-13,
// heatmaps-21, privacy-12).

it("events-13 · a list splits into runs of at most the size, in order, and none is empty", () => {
  expect(runsOf([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  expect(runsOf([1, 2], 2)).toEqual([[1, 2]]);
  expect(runsOf([], 3)).toEqual([]);
});
