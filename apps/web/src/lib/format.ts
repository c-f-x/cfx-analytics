// How numbers, shares, changes, times and lengths read on the dashboard. One
// locale for every screen, so the same number never reads two ways.

const LOCALE = "en-GB";
const whole = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat(LOCALE, { notation: "compact", maximumFractionDigits: 1 });

/** 1,204; 12.3k past 100,000. */
export function count(value: number): string {
  return Math.abs(value) >= 100_000 ? compact.format(value) : whole.format(value);
}

/** A share of 0 to 1 as a whole percent; "–" when there is none. */
export function percent(share: number | null): string {
  if (share === null || !Number.isFinite(share)) return "–";
  return `${whole.format(share * 100)}%`;
}

/** A relative change as "+12%" or "−3%"; "new" when the period before had none. */
export function change(value: number | null | undefined): string {
  if (value === undefined) return "";
  if (value === null) return "new";
  const rounded = Math.round(value * 100);
  if (rounded === 0) return "0%";
  return `${rounded > 0 ? "+" : "−"}${whole.format(Math.abs(rounded))}%`;
}

/** A length in milliseconds as "48s", "3m 20s" or "1h 05m". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** A moment as "21 Oct, 14:05". */
export function moment(ms: number | string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

/** A bucket label from the API ("2026-10-21", "2026-10", "2026-10-21T14:00+02:00") as a short axis label. */
export function bucketLabel(label: string): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label);
  if (day !== null) {
    return new Intl.DateTimeFormat(LOCALE, {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])));
  }
  const month = /^(\d{4})-(\d{2})$/.exec(label);
  if (month !== null) {
    return new Intl.DateTimeFormat(LOCALE, {
      month: "short",
      year: "2-digit",
      timeZone: "UTC",
    }).format(Date.UTC(Number(month[1]), Number(month[2]) - 1, 1));
  }
  const hour = /T(\d{2}):(\d{2})/.exec(label);
  return hour === null ? label : `${hour[1] ?? ""}:${hour[2] ?? ""}`;
}
