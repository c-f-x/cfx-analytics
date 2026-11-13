import {
  localMidnight,
  type QuerySpec,
  type TopResult,
  type TrendResult,
  wallClockAt,
} from "@cfanalytics/shared";

// The weekly email (alerts-01 to alerts-06, #23): one plain-text email per
// recipient, covering every product they receive, busiest first. Pure: the
// numbers come in from the queries, and the text goes out to mail.ts.

/** A week, half-open [from, to) in ms, with its first and last local day. */
export interface Week {
  from: number;
  to: number;
  fromDay: string;
  toDay: string;
}


/** A local date, shifted by whole days, as YYYY-MM-DD. */
const dayString = (year: number, month: number, day: number, shift: number) =>
  new Date(Date.UTC(year, month - 1, day + shift)).toISOString().slice(0, 10);

/**
 * The last whole Monday to Sunday in `timeZone` before `now`, and the week
 * before it (alerts-06). Midnights come from localMidnight, so a week across
 * a daylight-saving change has its true length.
 */
export function lastWeeks(now: number, timeZone: string): { now: Week; before: Week } {
  const wall = wallClockAt(now, timeZone);
  const weekday = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
  const sinceMonday = (weekday + 6) % 7;
  const week = (startShift: number): Week => {
    const start = -sinceMonday + startShift;
    return {
      from: localMidnight(wall.year, wall.month, wall.day + start, timeZone),
      to: localMidnight(wall.year, wall.month, wall.day + start + 7, timeZone),
      fromDay: dayString(wall.year, wall.month, wall.day, start),
      toDay: dayString(wall.year, wall.month, wall.day, start + 6),
    };
  };
  return { now: week(-7), before: week(-14) };
}

/** One product's week, as the scheduled job reads it from the product's store. */
export interface ProductWeek {
  id: string;
  name: string;
  /** The week's first and last day, YYYY-MM-DD, in the product's time zone. */
  week: { from: string; to: string };
  visitors: { now: number; before: number };
  sessions: { now: number; before: number };
  pages: { key: string; visitors: number }[];
  sources: { key: string; visitors: number }[];
  rageClicks: number;
  rageTopPage: string | null;
  deadClicks: number;
}

export interface WeeklyEmail {
  subject: string;
  text: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const dayOf = (iso: string) => {
  const [, month, day] = iso.split("-").map(Number);
  return { day: day ?? 0, month: MONTHS[(month ?? 1) - 1] ?? "" };
};

/** "2 to 8 Nov", or "30 Oct to 5 Nov" across a month's end. */
function weekLabel(from: string, to: string): string {
  const a = dayOf(from);
  const b = dayOf(to);
  return a.month === b.month
    ? `${String(a.day)} to ${String(b.day)} ${b.month}`
    : `${String(a.day)} ${a.month} to ${String(b.day)} ${b.month}`;
}

/** "Visitors 312, up 12% from 279", in plain words for every case. */
function change(label: string, now: number, before: number): string {
  if (now === before) return `${label} ${String(now)}, the same as the week before`;
  if (before === 0) return `${label} ${String(now)}, none the week before`;
  if (now === 0) return `${label} 0, down from ${String(before)}`;
  const percent = Math.round((Math.abs(now - before) / before) * 100);
  const way = now > before ? "up" : "down";
  return `${label} ${String(now)}, ${way} ${String(percent)}% from ${String(before)}`;
}

const listed = (rows: { key: string; visitors: number }[]) =>
  rows
    .slice(0, 5)
    .map((row) => `${row.key} ${String(row.visitors)}`)
    .join(", ");

function part(product: ProductWeek, origin: string): string {
  const lines = [
    `${product.name}, ${weekLabel(product.week.from, product.week.to)}`,
    change("Visitors", product.visitors.now, product.visitors.before),
    change("Sessions", product.sessions.now, product.sessions.before),
  ];
  if (product.pages.length > 0) lines.push(`Top pages: ${listed(product.pages)}`);
  if (product.sources.length > 0) lines.push(`Top sources: ${listed(product.sources)}`);
  const problems: string[] = [];
  if (product.rageClicks > 0) {
    const where = product.rageTopPage === null ? "" : `, most on ${product.rageTopPage}`;
    problems.push(`${String(product.rageClicks)} rage clicks${where}`);
  }
  if (product.deadClicks > 0) problems.push(`${String(product.deadClicks)} clicks that did nothing`);
  if (problems.length > 0) lines.push(`Problems: ${problems.join("; ")}`);
  lines.push(`${origin}/p/${product.id}`);
  return lines.join("\n");
}

/** The email for one recipient's products, or null when none had a visitor in either week. */
export function weeklyEmail(products: ProductWeek[], origin: string): WeeklyEmail | null {
  const active = products
    .filter((p) => p.visitors.now > 0 || p.visitors.before > 0)
    .toSorted((a, b) => b.visitors.now - a.visitors.now || a.name.localeCompare(b.name));
  if (active.length === 0) return null;
  const quiet = products
    .filter((p) => p.visitors.now === 0 && p.visitors.before === 0)
    .map((p) => p.name)
    .toSorted((a, b) => a.localeCompare(b));
  const from = active.map((p) => p.week.from).toSorted()[0] ?? "";
  const to = active.map((p) => p.week.to).toSorted().at(-1) ?? "";
  const total = active.reduce((sum, p) => sum + p.visitors.now, 0);
  const sections = active.map((p) => part(p, origin));
  if (quiet.length > 0) sections.push(`No visitors this week or the week before: ${quiet.join(", ")}.`);
  return {
    subject: `Your products, ${weekLabel(from, to)}: ${String(total)} visitors`,
    text: `${sections.join("\n\n")}\n`,
  };
}

/** The queries one product's week needs, by name. */
export type WeekQueryName = "visitors" | "sessions" | "pages" | "sources" | "rage" | "ragePage" | "dead";

/** Each number of a product's week, asked of the store like any dashboard question (alerts-01). */
export function weekQueries(week: Week): Record<WeekQueryName, QuerySpec> {
  const range = {
    kind: "between" as const,
    from: new Date(week.from).toISOString(),
    to: new Date(week.to).toISOString(),
  };
  const total = (measure: "visitors" | "sessions" | "events", event?: string): QuerySpec => ({
    kind: "trend",
    range,
    measure,
    granularity: "day",
    compare: true,
    ...(event === undefined ? {} : { event }),
  });
  return {
    visitors: total("visitors"),
    sessions: total("sessions"),
    pages: { kind: "top", range, dimension: { builtin: "page" }, measure: "visitors", limit: 5 },
    sources: {
      kind: "top",
      range,
      dimension: { builtin: "referring_domain" },
      measure: "visitors",
      limit: 5,
    },
    rage: total("events", "$rageclick"),
    ragePage: {
      kind: "top",
      range,
      event: "$rageclick",
      dimension: { builtin: "page" },
      measure: "events",
      limit: 1,
    },
    dead: total("events", "$dead_click"),
  };
}

export interface WeekAnswers {
  visitors: TrendResult;
  sessions: TrendResult;
  pages: TopResult;
  sources: TopResult;
  rage: TrendResult;
  ragePage: TopResult;
  dead: TrendResult;
}

const totalOf = (result: TrendResult) => result.series[0]?.total ?? 0;
const previousOf = (result: TrendResult) => result.previous?.series[0]?.total ?? 0;

/** A stored page key is host plus path (enrich-23); the email shows the path. */
const pathOf = (key: string) => {
  const slash = key.indexOf("/");
  return slash > 0 ? key.slice(slash) : key;
};

/** The answers read into one product's week (alerts-02, alerts-03). */
export function productWeekOf(
  product: { id: string; name: string },
  week: Week,
  answers: WeekAnswers,
): ProductWeek {
  const rows = (result: TopResult, name: (key: string | number | boolean | null) => string) =>
    result.rows.map((row) => ({ key: name(row.key), visitors: row.count }));
  const ragePage = answers.ragePage.rows[0]?.key;
  return {
    id: product.id,
    name: product.name,
    week: { from: week.fromDay, to: week.toDay },
    visitors: { now: totalOf(answers.visitors), before: previousOf(answers.visitors) },
    sessions: { now: totalOf(answers.sessions), before: previousOf(answers.sessions) },
    pages: rows(answers.pages, (key) => pathOf(String(key))),
    sources: rows(answers.sources, (key) => (key === null || key === "" ? "Direct" : String(key))),
    rageClicks: totalOf(answers.rage),
    rageTopPage: typeof ragePage === "string" ? pathOf(ragePage) : null,
    deadClicks: totalOf(answers.dead),
  };
}
