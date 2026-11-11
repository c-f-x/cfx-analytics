import { STORE_GUARD_BYTES } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import { dayIn, T0 } from "../../../test/helpers/capture.ts";
import { capDay, counterKeepFrom, grant, storeIsFull } from "./core.ts";

// The events slice's pure rules: how many of a batch fit under the cap, which
// calendar day the cap counts on, how long counters live and the size guard
// (events-02, events-07, events-09, events-12). Time zones are checked with
// `dayIn`, which reads the zone independently of the code under test.

const OSLO = "Europe/Oslo";

// 23:59:59.999 and 00:00:00 on 22 October in Oslo (UTC+2 until 25 October).
const BEFORE_OSLO_MIDNIGHT = Date.UTC(2026, 9, 21, 21, 59, 59, 999);
const OSLO_MIDNIGHT = Date.UTC(2026, 9, 21, 22, 0, 0, 0);

it("events-02 · grant takes what fits under the cap and never goes below zero", () => {
  expect(grant(5, 0, 3)).toBe(3);
  expect(grant(5, 4, 3)).toBe(1);
  expect(grant(5, 5, 3)).toBe(0);
  expect(grant(5, 9, 3)).toBe(0);
  expect(grant(5, 0, 10)).toBe(5);
  expect(grant(5, 0, 0)).toBe(0);
  expect(grant(0, 0, 1)).toBe(0);
});

it("events-07 · the cap's day is the project's calendar day, taken by arrival time", () => {
  expect(capDay(T0, OSLO)).toBe("2026-10-21");
  expect(capDay(T0, OSLO)).toBe(dayIn(T0, OSLO));

  expect(dayIn(BEFORE_OSLO_MIDNIGHT, OSLO)).toBe("2026-10-21");
  expect(capDay(BEFORE_OSLO_MIDNIGHT, OSLO)).toBe("2026-10-21");
  expect(dayIn(OSLO_MIDNIGHT, OSLO)).toBe("2026-10-22");
  expect(capDay(OSLO_MIDNIGHT, OSLO)).toBe("2026-10-22");
});

it("events-07 · one arrival time falls on different days in Oslo and in UTC", () => {
  const lateInTheDay = Date.UTC(2026, 9, 21, 23, 30, 0, 0);

  expect(capDay(lateInTheDay, OSLO)).toBe("2026-10-22");
  expect(capDay(lateInTheDay, "UTC")).toBe("2026-10-21");
});

it("events-09 · the oldest counter day to keep is two calendar days before today", () => {
  expect(counterKeepFrom("2026-10-21")).toBe("2026-10-19");
  expect(counterKeepFrom("2026-03-01")).toBe("2026-02-27");
  expect(counterKeepFrom("2026-01-01")).toBe("2025-12-30");
});

it("events-12 · a store at the size guard takes no more events", () => {
  expect(storeIsFull(0)).toBe(false);
  expect(storeIsFull(STORE_GUARD_BYTES - 1)).toBe(false);
  expect(storeIsFull(STORE_GUARD_BYTES)).toBe(true);
  expect(storeIsFull(STORE_GUARD_BYTES + 1)).toBe(true);
});
