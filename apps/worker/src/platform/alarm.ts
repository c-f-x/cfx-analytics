import { DAY_MS } from "@cfanalytics/shared";

// The alarm's tests and the store read DAY_MS from here; its one home is packages/shared.
export { DAY_MS };

// When a ProjectStore's daily sweep runs (D-9, D-20). Pure: the clock and the
// current alarm are arguments. Retries after a failed sweep are Cloudflare's
// own alarm retry, so nothing here counts failures (platform-30).

/** How soon the next pass runs when a sweep left rows behind (privacy-27). */
export const NEXT_PASS_MS = 60 * 1000;

/**
 * The alarm to set when a request reaches the object, or null to leave the
 * current one (platform-27): with no alarm, now + DAY_MS; with an alarm that is
 * overdue (before now, so it never fired), now; never a time later than the
 * current alarm.
 */
export function alarmOnRequest(now: number, current: number | null): number | null {
  if (current === null) return now + DAY_MS;
  if (current < now) return now;
  return null;
}

/**
 * The alarm to set after a sweep (platform-27, platform-28): null (drop the
 * alarm) when the store holds nothing left to sweep; now + NEXT_PASS_MS when
 * the sweep left expired rows for another pass; else now + DAY_MS.
 */
export function alarmAfterSweep(
  now: number,
  outcome: { empty: boolean; leftRows: boolean },
): number | null {
  if (outcome.empty) return null;
  if (outcome.leftRows) return now + NEXT_PASS_MS;
  return now + DAY_MS;
}
