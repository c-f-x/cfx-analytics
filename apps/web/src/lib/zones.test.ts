import { expect, it } from "vitest";
import { timeZoneOptions } from "./zones.ts";

it("dashboard-11 · the time zones offered hold UTC and the product's own zone, once each, sorted", () => {
  const browser = ["Europe/Oslo", "America/New_York"];
  expect(timeZoneOptions("Europe/Oslo", browser)).toEqual([
    "America/New_York",
    "Europe/Oslo",
    "UTC",
  ]);
  expect(timeZoneOptions("Etc/GMT+5", browser)).toEqual([
    "America/New_York",
    "Etc/GMT+5",
    "Europe/Oslo",
    "UTC",
  ]);
  expect(timeZoneOptions("UTC", [...browser, "UTC"])).toEqual([
    "America/New_York",
    "Europe/Oslo",
    "UTC",
  ]);
});
