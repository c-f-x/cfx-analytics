import { describe, expect, it } from "vitest";
import { alertEmail, nextWatch, type WatchState } from "./alert.ts";

// When the watcher emails (ops-01, ops-02): one failed check can be a blip,
// so the second in a row alerts; the first healthy check after says so.

const NOW = Date.UTC(2026, 9, 22, 18, 0);
const MIN = 60_000;

describe("nextWatch", () => {
  it("ops-01 · a healthy check from the start sends nothing", () => {
    expect(nextWatch(null, true, NOW)).toEqual({
      state: { health: "healthy", failures: 0, since: NOW },
      alert: null,
    });
  });

  it("ops-01 · the second failed check in a row alerts once, and later ones stay quiet", () => {
    const first = nextWatch(null, false, NOW);
    expect(first.alert).toBeNull();
    const second = nextWatch(first.state, false, NOW + 5 * MIN);
    expect(second).toEqual({
      state: { health: "failing", failures: 2, since: NOW + 5 * MIN },
      alert: "down",
    });
    const third = nextWatch(second.state, false, NOW + 10 * MIN);
    expect(third.alert).toBeNull();
    expect(third.state.health).toBe("failing");
  });

  it("ops-02 · one failed check between healthy ones sends nothing", () => {
    const blip = nextWatch({ health: "healthy", failures: 0, since: NOW }, false, NOW + MIN);
    const back = nextWatch(blip.state, true, NOW + 2 * MIN);
    expect([blip.alert, back.alert]).toEqual([null, null]);
    expect(back.state).toEqual({ health: "healthy", failures: 0, since: NOW });
  });

  it("ops-02 · the first healthy check after an alert says it is back", () => {
    const down: WatchState = { health: "failing", failures: 4, since: NOW };
    expect(nextWatch(down, true, NOW + 20 * MIN)).toEqual({
      state: { health: "healthy", failures: 0, since: NOW + 20 * MIN },
      alert: "up",
    });
  });
});

describe("alertEmail", () => {
  it("ops-01 · the email names the address, what happened and since when, in UTC", () => {
    const down = alertEmail("down", "https://analytics.example.com/healthz", NOW);
    expect(down.subject).toBe("cfx-analytics is failing");
    expect(down.text).toContain("https://analytics.example.com/healthz");
    expect(down.text).toContain("2026-10-22 18:00 UTC");
    const up = alertEmail("up", "https://analytics.example.com/healthz", NOW);
    expect(up.subject).toBe("cfx-analytics is healthy again");
  });
});
