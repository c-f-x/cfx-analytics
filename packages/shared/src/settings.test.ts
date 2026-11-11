import { expect, it } from "vitest";
import { BYTES_PER_EVENT, STORE_GUARD_BYTES } from "./limits.ts";
import { calendarDay, DEFAULT_SETTINGS, fitsInStore } from "./settings.ts";

// The registry's CHECK holds the same bound as whole events:
// daily_event_cap * events_retention_days <= 16981132 (migrations/0001-registry.sql).
const MOST_EVENTS = 16_981_132;

it("events-11 · the defaults of 40,000 a day for 395 days fit", () => {
  expect(DEFAULT_SETTINGS.daily_event_cap).toBe(40_000);
  expect(DEFAULT_SETTINGS.events_retention_days).toBe(395);
  expect(
    fitsInStore(DEFAULT_SETTINGS.daily_event_cap, DEFAULT_SETTINGS.events_retention_days),
  ).toBe(true);
});

it("events-11 · the bound is 9 GB at 530 bytes an event, the same as the registry's CHECK", () => {
  expect(Math.floor(STORE_GUARD_BYTES / BYTES_PER_EVENT)).toBe(MOST_EVENTS);
  expect(fitsInStore(MOST_EVENTS, 1)).toBe(true);
  expect(fitsInStore(MOST_EVENTS + 1, 1)).toBe(false);
  expect(fitsInStore(200_000, 395)).toBe(false);
});

// One rule for "which day is it there", read by the cap's day and the salt's day.
it("events-07, cookieless-09 · calendarDay is the YYYY-MM-DD of a moment in a time zone", () => {
  const lateEvening = Date.UTC(2026, 9, 21, 22, 30); // 00:30 on 22 October in Oslo (UTC+2)
  expect(calendarDay(lateEvening, "UTC")).toBe("2026-10-21");
  expect(calendarDay(lateEvening, "Europe/Oslo")).toBe("2026-10-22");
  expect(calendarDay(Date.UTC(2026, 0, 1, 5), "America/Los_Angeles")).toBe("2025-12-31");
});
