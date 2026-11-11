import type { Granularity, Range } from "@cfanalytics/shared";

// The board's periods: each a range the API resolves in the product's time
// zone, and the bucket size a trend over it reads best at.

export type PeriodId = "today" | "yesterday" | "7d" | "30d" | "90d" | "12m";

export interface Period {
  id: PeriodId;
  label: string;
  range: Range;
  granularity: Granularity;
}

/** The board's default period (dashboard-01). */
const LAST_7_DAYS: Period = {
  id: "7d",
  label: "Last 7 days",
  range: { kind: "last_days", days: 7 },
  granularity: "day",
};

export const PERIODS: readonly Period[] = [
  { id: "today", label: "Today", range: { kind: "today" }, granularity: "hour" },
  { id: "yesterday", label: "Yesterday", range: { kind: "yesterday" }, granularity: "hour" },
  LAST_7_DAYS,
  { id: "30d", label: "Last 30 days", range: { kind: "last_days", days: 30 }, granularity: "day" },
  { id: "90d", label: "Last 90 days", range: { kind: "last_days", days: 90 }, granularity: "week" },
  {
    id: "12m",
    label: "Last 12 months",
    range: { kind: "last_days", days: 365 },
    granularity: "month",
  },
];

export const DEFAULT_PERIOD: PeriodId = LAST_7_DAYS.id;

/** The period named `id`, or the default for anything else. */
export function periodOf(id: unknown): Period {
  return PERIODS.find((period) => period.id === id) ?? LAST_7_DAYS;
}
