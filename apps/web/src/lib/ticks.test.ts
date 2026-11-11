import { expect, it } from "vitest";
import { niceTicks } from "./ticks.ts";

it("dashboard-03 · ticks are round and reach past the largest value", () => {
  expect(niceTicks(201)).toEqual([0, 100, 200, 300]);
  expect(niceTicks(172, 4)).toEqual([0, 50, 100, 150, 200]);
  expect(niceTicks(9)).toEqual([0, 2.5, 5, 7.5, 10]);
  expect(niceTicks(0)).toEqual([0, 1]);
});
