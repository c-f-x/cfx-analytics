import { describe, expect, it } from "vitest";
import { alarmAfterSweep, alarmOnRequest, DAY_MS, NEXT_PASS_MS } from "./alarm.ts";

// The planner is pure (D-9, D-20): the clock and the current alarm are
// arguments. Retries after a failed sweep belong to Cloudflare's own alarm
// retry (platform-30), so nothing here counts failures.

const now = 1_800_000_000_000;

describe("the alarm planner", () => {
  it("platform-27 · with no alarm a request plans one for the next daily sweep", () => {
    expect(alarmOnRequest(now, null)).toBe(now + DAY_MS);
  });

  it("platform-27 · an alarm that is overdue because it never fired is planned for now", () => {
    expect(alarmOnRequest(now, now - 1)).toBe(now);
  });

  it("platform-27 · a request never plans an alarm later than the current one", () => {
    expect(alarmOnRequest(now, now + NEXT_PASS_MS)).toBeNull();
  });

  it("platform-27 · after a sweep that finished the next alarm is a day later", () => {
    expect(alarmAfterSweep(now, { empty: false, leftRows: false })).toBe(now + DAY_MS);
  });

  it("platform-27 · after a sweep that left rows the next pass is soon", () => {
    expect(alarmAfterSweep(now, { empty: false, leftRows: true })).toBe(now + NEXT_PASS_MS);
  });

  it("platform-28 · with nothing left to sweep the alarm is dropped", () => {
    expect(alarmAfterSweep(now, { empty: true, leftRows: false })).toBeNull();
  });
});
