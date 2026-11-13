import type { TopResult, TrendResult } from "@cfanalytics/shared";
import { describe, expect, it } from "vitest";
import { lastWeeks, type ProductWeek, productWeekOf, weeklyEmail, weekQueries } from "./core.ts";

const ORIGIN = "https://analytics.example.com";

const week = (over: Partial<ProductWeek>): ProductWeek => ({
  id: "p_shop",
  name: "Shop",
  week: { from: "2026-11-02", to: "2026-11-08" },
  visitors: { now: 0, before: 0 },
  sessions: { now: 0, before: 0 },
  pages: [],
  sources: [],
  rageClicks: 0,
  rageTopPage: null,
  deadClicks: 0,
  ...over,
});

describe("weeklyEmail", () => {
  it("alerts-01 · lists active products busiest first, each with visitors, sessions and the change", () => {
    const mail = weeklyEmail(
      [
        week({
          id: "p_docs",
          name: "Docs",
          visitors: { now: 40, before: 50 },
          sessions: { now: 45, before: 45 },
        }),
        week({
          id: "p_shop",
          name: "Shop",
          visitors: { now: 312, before: 279 },
          sessions: { now: 401, before: 418 },
        }),
      ],
      ORIGIN,
    );
    expect(mail).not.toBeNull();
    const text = mail?.text ?? "";
    expect(text.indexOf("Shop")).toBeLessThan(text.indexOf("Docs"));
    expect(text).toContain("Shop, 2 to 8 Nov");
    expect(text).toContain("Visitors 312, up 12% from 279");
    expect(text).toContain("Sessions 401, down 4% from 418");
    expect(text).toContain("Visitors 40, down 20% from 50");
    expect(text).toContain("Sessions 45, the same as the week before");
  });

  it("alerts-01 · a product with visitors only this week is new, and one with none this week dropped to 0", () => {
    const text =
      weeklyEmail(
        [
          week({ name: "New", visitors: { now: 9, before: 0 } }),
          week({ id: "p_gone", name: "Gone", visitors: { now: 0, before: 7 } }),
        ],
        ORIGIN,
      )?.text ?? "";
    expect(text).toContain("Visitors 9, none the week before");
    expect(text).toContain("Visitors 0, down from 7");
  });

  it("alerts-02 · top pages and sources, and an empty list is left out", () => {
    const text =
      weeklyEmail(
        [
          week({
            visitors: { now: 5, before: 1 },
            pages: [
              { key: "/pricing", visitors: 4 },
              { key: "/", visitors: 2 },
            ],
          }),
        ],
        ORIGIN,
      )?.text ?? "";
    expect(text).toContain("Top pages: /pricing 4, / 2");
    expect(text).not.toContain("Top sources");
  });

  it("alerts-03 · problems name the counts and the page with the most rage clicks, and none says nothing", () => {
    const text =
      weeklyEmail(
        [
          week({
            visitors: { now: 5, before: 1 },
            rageClicks: 14,
            rageTopPage: "/checkout",
            deadClicks: 3,
          }),
        ],
        ORIGIN,
      )?.text ?? "";
    expect(text).toContain(
      "Problems: 14 rage clicks, most on /checkout; 3 clicks that did nothing",
    );
    const calm = weeklyEmail([week({ visitors: { now: 5, before: 1 } })], ORIGIN)?.text ?? "";
    expect(calm).not.toContain("Problems");
  });

  it("alerts-04 · quiet products share one line, and no email at all when nothing happened", () => {
    const text =
      weeklyEmail(
        [
          week({ visitors: { now: 5, before: 1 } }),
          week({ id: "p_a", name: "Studio" }),
          week({ id: "p_b", name: "Pecha" }),
        ],
        ORIGIN,
      )?.text ?? "";
    expect(text).toContain("No visitors this week or the week before: Pecha, Studio.");
    expect(weeklyEmail([week({}), week({ id: "p_b", name: "Pecha" })], ORIGIN)).toBeNull();
    expect(weeklyEmail([], ORIGIN)).toBeNull();
  });

  it("alerts-05 · the subject names the week and the total, and each product links its board", () => {
    const mail = weeklyEmail(
      [
        week({ visitors: { now: 312, before: 279 } }),
        week({ id: "p_docs", name: "Docs", visitors: { now: 40, before: 50 } }),
      ],
      ORIGIN,
    );
    expect(mail?.subject).toBe("Your products, 2 to 8 Nov: 352 visitors");
    expect(mail?.text).toContain(`${ORIGIN}/p/p_shop`);
    expect(mail?.text).toContain(`${ORIGIN}/p/p_docs`);
  });
});

const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;

describe("lastWeeks", () => {
  it("alerts-06 · the last whole Monday to Sunday in the product's time zone, and the week before", () => {
    // Monday 9 November 2026, 06:00 UTC, which is 07:00 in Oslo.
    const weeks = lastWeeks(Date.parse("2026-11-09T06:00:00Z"), "Europe/Oslo");
    expect(weeks.now).toEqual({
      from: Date.parse("2026-11-01T23:00:00Z"),
      to: Date.parse("2026-11-08T23:00:00Z"),
      fromDay: "2026-11-02",
      toDay: "2026-11-08",
    });
    expect(iso(weeks.before.from)).toBe("2026-10-25T23:00:00.000Z");
    expect(weeks.before.to).toBe(weeks.now.from);
    expect(weeks.before.fromDay).toBe("2026-10-26");
  });

  it("alerts-06 · a week across the clocks going back is 169 hours", () => {
    // Europe/Oslo goes from summer time to winter time on Sunday 25 October 2026.
    const weeks = lastWeeks(Date.parse("2026-10-26T06:00:00Z"), "Europe/Oslo");
    expect(weeks.now.fromDay).toBe("2026-10-19");
    expect(weeks.now.toDay).toBe("2026-10-25");
    expect((weeks.now.to - weeks.now.from) / HOUR).toBe(169);
  });

  it("alerts-06 · on a Sunday the week that ends today is not whole yet, so the one before is taken", () => {
    const weeks = lastWeeks(Date.parse("2026-11-08T20:00:00Z"), "UTC");
    expect(weeks.now.fromDay).toBe("2026-10-26");
    expect(weeks.now.toDay).toBe("2026-11-01");
  });
});

const trend = (now: number, before: number): TrendResult => ({
  buckets: [],
  series: [{ key: null, other: false, values: [now], total: now, change: 0 }],
  previous: { buckets: [], series: [{ key: null, other: false, values: [before], total: before }] },
});
const top = (rows: [string | null, number][]): TopResult => ({
  rows: rows.map(([key, count]) => ({ key, count })),
});

describe("productWeekOf", () => {
  const WEEK = {
    from: Date.parse("2026-11-01T23:00:00Z"),
    to: Date.parse("2026-11-08T23:00:00Z"),
    fromDay: "2026-11-02",
    toDay: "2026-11-08",
  };

  it("alerts-01 · asks each number for the week, compared with the week before", () => {
    const specs = weekQueries(WEEK);
    expect(specs.visitors).toMatchObject({
      kind: "trend",
      measure: "visitors",
      compare: true,
      range: { kind: "between", from: "2026-11-01T23:00:00.000Z", to: "2026-11-08T23:00:00.000Z" },
    });
    expect(specs.sessions).toMatchObject({ kind: "trend", measure: "sessions", compare: true });
    expect(specs.pages).toMatchObject({
      kind: "top",
      dimension: { builtin: "page" },
      measure: "visitors",
      limit: 5,
    });
    expect(specs.rage).toMatchObject({ kind: "trend", event: "$rageclick", measure: "events" });
  });

  it("alerts-02, alerts-03 · reads the answers into the email's numbers", () => {
    const read = productWeekOf({ id: "p_shop", name: "Shop" }, WEEK, {
      visitors: trend(312, 279),
      sessions: trend(401, 418),
      pages: top([
        ["shop.example.com/pricing", 88],
        ["shop.example.com/", 60],
      ]),
      sources: top([
        [null, 120],
        ["news.ycombinator.com", 60],
      ]),
      rage: trend(14, 2),
      ragePage: top([["shop.example.com/checkout", 11]]),
      dead: trend(3, 0),
    });
    expect(read).toEqual({
      id: "p_shop",
      name: "Shop",
      week: { from: "2026-11-02", to: "2026-11-08" },
      visitors: { now: 312, before: 279 },
      sessions: { now: 401, before: 418 },
      pages: [
        { key: "/pricing", visitors: 88 },
        { key: "/", visitors: 60 },
      ],
      sources: [
        { key: "Direct", visitors: 120 },
        { key: "news.ycombinator.com", visitors: 60 },
      ],
      rageClicks: 14,
      rageTopPage: "/checkout",
      deadClicks: 3,
    });
  });
});
