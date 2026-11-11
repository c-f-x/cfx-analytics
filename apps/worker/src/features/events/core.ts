import { calendarDay, DAY_MS, STORE_GUARD_BYTES } from "@cfanalytics/shared";

// Pure rules of the events store and its caps (D-20; events-01 to events-15).

/** The cap's day: the calendar day of the arrival time in the project's time zone, YYYY-MM-DD (events-07). */
export function capDay(receivedAt: number, timeZone: string): string {
  return calendarDay(receivedAt, timeZone);
}

/** The oldest counter day to keep, YYYY-MM-DD: two calendar days before `today`, so counters live two days (events-09). */
export function counterKeepFrom(today: string): string {
  return new Date(Date.parse(`${today}T00:00:00.000Z`) - 2 * DAY_MS).toISOString().slice(0, 10);
}

/** How many of `wanted` fit under `cap` with `taken` already used: never negative, never more than wanted (events-01 to events-03). */
export function grant(cap: number, taken: number, wanted: number): number {
  return Math.max(0, Math.min(wanted, cap - taken));
}

/** Whether a store of `databaseSize` bytes takes no more events: at or above STORE_GUARD_BYTES (events-12, D-20). */
export function storeIsFull(databaseSize: number): boolean {
  return databaseSize >= STORE_GUARD_BYTES;
}
