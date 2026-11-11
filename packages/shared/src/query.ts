import { z } from "zod";
import { QUERY } from "./limits.ts";
import { isTimeZone } from "./settings.ts";

// The typed query specs the dashboard and `/api/external/query` send, and the
// shapes of their answers (architecture.md, "A query"). One schema per kind;
// the Worker's query slice compiles each to one SQL statement with bound
// parameters. Unknown keys are refused everywhere (query-18), and nothing
// falls back to a default except where a field is absent (D-20).

// ── Ranges ──────────────────────────────────────────────────────────────────

/** An ISO 8601 timestamp with a time and an offset or Z; a bare date is refused (query-36). */
const instant = z.iso.datetime({ offset: true });

export const range = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("today") }),
  z.strictObject({ kind: z.literal("yesterday") }),
  z.strictObject({ kind: z.literal("last_24_hours") }),
  /** N calendar days including today, in the query's time zone (D-20, query-10). */
  z.strictObject({ kind: z.literal("last_days"), days: z.number().int().min(1).max(3650) }),
  /** Half-open [from, to). `from` must be before `to` (query-11). */
  z.strictObject({ kind: z.literal("between"), from: instant, to: instant }),
]);
export type Range = z.infer<typeof range>;

export const granularity = z.enum(["hour", "day", "week", "month"]);
export type Granularity = z.infer<typeof granularity>;

// ── Filters ─────────────────────────────────────────────────────────────────

/** A property of the event, or of its person (query-08, query-52 to query-58). */
export const propertyRef = z.strictObject({
  of: z.enum(["event", "person"]),
  name: z.string().min(1).max(200),
});
export type PropertyRef = z.infer<typeof propertyRef>;

const scalar = z.union([z.string().max(1000), z.number(), z.boolean()]);

export const condition = z.discriminatedUnion("op", [
  z.strictObject({ op: z.enum(["eq", "neq"]), property: propertyRef, value: scalar }),
  z.strictObject({
    op: z.enum(["in", "notIn"]),
    property: propertyRef,
    values: z.array(scalar).min(1).max(QUERY.filterValues),
  }),
  z.strictObject({
    op: z.enum(["gt", "gte", "lt", "lte"]),
    property: propertyRef,
    value: z.number(),
  }),
  /** Both ends inclusive; a reversed pair is refused (query-56). */
  z.strictObject({
    op: z.literal("between"),
    property: propertyRef,
    low: z.number(),
    high: z.number(),
  }),
  /** String operators match strings only (query-55). `contains` is a search term of at most 50 bytes (query-50). */
  z.strictObject({
    op: z.enum(["contains", "startsWith", "endsWith"]),
    property: propertyRef,
    value: z.string().min(1),
  }),
  z.strictObject({
    op: z.enum(["exists", "notExists", "isNull", "isEmpty", "notNull"]),
    property: propertyRef,
  }),
]);
export type Condition = z.infer<typeof condition>;

/** A filter is a condition or a group of filters, nested at most QUERY.filterDepth deep (query-59). */
export type Filter = Condition | { all: Filter[] } | { any: Filter[] };
export const filter: z.ZodType<Filter> = z.lazy(() =>
  z.union([
    condition,
    z.strictObject({ all: z.array(filter).min(1).max(QUERY.filterValues) }),
    z.strictObject({ any: z.array(filter).min(1).max(QUERY.filterValues) }),
  ]),
);

// ── Dimensions ──────────────────────────────────────────────────────────────

/** Built-in dimensions are a closed list; any property name is allowed besides (query-47). */
export const builtinDimension = z.enum([
  "event",
  "page",
  "referring_domain",
  "country",
  "device_type",
  "browser",
  "os",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  /** The stored $channel, set at intake (enrich-40, query-127). */
  "channel",
]);
export type BuiltinDimension = z.infer<typeof builtinDimension>;

export const dimension = z.union([
  z.strictObject({ builtin: builtinDimension }),
  /** Browser versions are grouped for one named browser only, by major number (query-68). */
  z.strictObject({ builtin: z.literal("browser_version"), browser: z.string().min(1).max(100) }),
  z.strictObject({ property: propertyRef }),
]);
export type Dimension = z.infer<typeof dimension>;

// ── Specs ───────────────────────────────────────────────────────────────────

/** Fields every kind shares. */
const common = {
  range,
  /** Absent: the project's time zone (query-14). */
  timeZone: z.string().refine(isTimeZone, "not an IANA time zone").optional(),
  /** Bots and internal traffic are left out unless asked for (query-07, query-08). */
  includeBots: z.boolean().optional(),
  includeInternal: z.boolean().optional(),
  filter: filter.optional(),
};

/** Events, unique visitors or sessions per bucket, optionally broken down and compared (query-16, query-41 to query-46). */
export const trendSpec = z.strictObject({
  kind: z.literal("trend"),
  ...common,
  /** Absent: every event. */
  event: z.string().min(1).max(200).optional(),
  /** A session counts once, in the bucket of its first event (query-42). */
  measure: z.enum(["events", "visitors", "sessions"]),
  granularity,
  breakdown: dimension.optional(),
  breakdownLimit: z.number().int().min(1).max(QUERY.breakdownLimit.max).optional(),
  /** Also answer the previous period of the same number of calendar days (query-38). */
  compare: z.boolean().optional(),
});

/** One dimension's values by count, paged by keyset (query-48, query-64 to query-71). */
export const topSpec = z.strictObject({
  kind: z.literal("top"),
  ...common,
  event: z.string().min(1).max(200).optional(),
  dimension,
  measure: z.enum(["events", "visitors"]),
  limit: z.number().int().min(1).max(QUERY.topLimit.max).optional(),
  cursor: z.string().max(1000).optional(),
});

const stepId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "a step id is a slug");

/** Ordered funnel with a window from the entry event (query-03, query-04, query-21 to query-32). */
export const funnelSpec = z.strictObject({
  kind: z.literal("funnel"),
  ...common,
  steps: z
    .array(
      z.strictObject({
        id: stepId,
        event: z.string().min(1).max(200),
        /** Conditions on this step's own event (query-27). */
        where: z.array(condition).max(QUERY.filterValues).optional(),
      }),
    )
    .min(QUERY.funnelSteps.min)
    .max(QUERY.funnelSteps.max),
  windowMs: z.number().int().min(1),
  /** Splits the funnel by the value of each visitor's first entry event (query-128). */
  breakdown: dimension.optional(),
  breakdownLimit: z.number().int().min(1).max(QUERY.breakdownLimit.max).optional(),
});

/** Cohorts from each person's first counted event ever (query-62, query-63). */
export const retentionSpec = z.strictObject({
  kind: z.literal("retention"),
  ...common,
  granularity: z.enum(["day", "week", "month"]),
  /** Absent: any event. */
  startEvent: z.string().min(1).max(200).optional(),
  returnEvent: z.string().min(1).max(200).optional(),
});

/** Share of views of one page that reached each tenth of it (heatmaps-03). */
export const scrollDepthSpec = z.strictObject({
  kind: z.literal("scroll_depth"),
  ...common,
  path: z.string().min(1).max(2048),
});

/** The raw event list, newest first, paged by keyset. */
export const eventsSpec = z.strictObject({
  kind: z.literal("events"),
  ...common,
  event: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(QUERY.eventsLimit.max).optional(),
  cursor: z.string().max(1000).optional(),
});

/** Property names seen in the range with their JSON types and counts (query-51). */
export const propertiesSpec = z.strictObject({
  kind: z.literal("properties"),
  ...common,
  event: z.string().min(1).max(200).optional(),
});

export const querySpec = z.discriminatedUnion("kind", [
  trendSpec,
  topSpec,
  funnelSpec,
  retentionSpec,
  scrollDepthSpec,
  eventsSpec,
  propertiesSpec,
]);
export type QuerySpec = z.infer<typeof querySpec>;
export type QueryKind = QuerySpec["kind"];
export const QUERY_KINDS: readonly QueryKind[] = [
  "trend",
  "top",
  "funnel",
  "retention",
  "scroll_depth",
  "events",
  "properties",
];

/** A heatmap for one page and width band (heatmaps-02, heatmaps-11, heatmaps-12). Its own route, not a query kind. */
export const heatmapSpec = z.strictObject({
  range,
  timeZone: z.string().refine(isTimeZone, "not an IANA time zone").optional(),
  includeBots: z.boolean().optional(),
  path: z.string().min(1).max(2048),
  /** Absent: the page's busiest band in the range (heatmaps-24). */
  widthBand: z.number().int().min(0).max(10_000).optional(),
  type: z.enum(["click", "rageclick", "deadclick"]).optional(),
});
export type HeatmapSpec = z.infer<typeof heatmapSpec>;

// ── Answers ─────────────────────────────────────────────────────────────────

/** What every answer says about itself (query-12, query-40). Times are ISO UTC. */
export interface AnswerMeta {
  range: { from: string; to: string };
  /** The range asked for, when the answer was clipped to the retention horizon. */
  requested?: { from: string; to: string };
  timeZone: string;
  excluded: {
    bots: boolean;
    /** The internal rules applied, by position in the project's list. */
    internalRules: number[];
    /** Person-property rules that cannot apply to this kind (heatmaps-19). */
    notApplicable: number[];
  };
  /** Rows the store read for this answer; null when a statement did not report (query-12). */
  rowsRead: number | null;
}

export interface Answer<T> {
  meta: AnswerMeta;
  result: T;
}

/** One bucket per step of the range, zeros included (query-16). `key` is null for the null breakdown value. */
export interface TrendSeries {
  key: string | number | boolean | null;
  /** True for the row that sums the keys beyond the limit (query-45). */
  other: boolean;
  values: number[];
  total: number;
  /**
   * With `compare`: (total - previous total) / previous total, 0 when both
   * are 0, null when only the previous is 0 (query-43). Absent without it.
   */
  change?: number | null;
}
export interface TrendResult {
  buckets: string[];
  series: TrendSeries[];
  /** Present when `compare` was asked for. */
  previous?: { buckets: string[]; series: TrendSeries[] };
}

export interface TopResult {
  rows: { key: string | number | boolean | null; count: number }[];
  /** Absent on the last page. */
  nextCursor?: string;
}

export interface FunnelStepResult {
  id: string;
  count: number;
  /** Null when the first step has no one (query-29). */
  rateFromStart: number | null;
  rateFromPrevious: number | null;
  dropOff: number;
}
export interface FunnelResult {
  steps: FunnelStepResult[];
  conversionRate: number | null;
  /** The step index with the largest drop-off; the earlier on a tie; null when no one entered. */
  largestDropOff: number | null;
  /** With a breakdown: each kept group, ranked by how many entered, then "Other" (query-128). */
  groups?: FunnelGroup[];
}

export interface FunnelGroup {
  key: string | number | boolean | null;
  /** True for the group that sums the values beyond the limit. */
  other: boolean;
  steps: FunnelStepResult[];
  conversionRate: number | null;
}

export interface RetentionResult {
  cohorts: { start: string; size: number; periods: { people: number; rate: number | null }[] }[];
}

export interface ScrollDepthResult {
  views: number;
  /** reached[i] is the share of views that reached tenth i + 1 of the page. */
  reached: number[];
}

export interface EventRow {
  uuid: string;
  event: string;
  distinctId: string;
  ts: string;
  properties: Record<string, unknown>;
}
export interface EventsResult {
  rows: EventRow[];
  nextCursor?: string;
}

export interface PropertiesResult {
  properties: { name: string; types: { type: string; count: number }[] }[];
  /** How many events the catalogue read: the newest of the range, at most 10,000 (query-51, D-26). */
  events: number;
}

/** The result each query kind answers with, by its spec's `kind`. */
export interface ResultOf {
  trend: TrendResult;
  top: TopResult;
  funnel: FunnelResult;
  retention: RetentionResult;
  scroll_depth: ScrollDepthResult;
  events: EventsResult;
  properties: PropertiesResult;
}

export interface HeatmapPoint {
  x: number;
  y: number;
  fixed: boolean;
  type: "click" | "rageclick" | "deadclick";
  count: number;
}
/** One width band of a page that holds points, and how many (heatmaps-23). */
export interface HeatmapBand {
  widthBand: number;
  points: number;
}

export interface HeatmapResult {
  /** The band answered: the one asked, else the busiest, else null for a page with no points (heatmaps-24). */
  widthBand: number | null;
  points: HeatmapPoint[];
  /** The page's bands with points in the range, in band order (heatmaps-23). */
  bands: HeatmapBand[];
  /** The newest full snapshot for this path in the same width band, or null (heatmaps-02). */
  snapshot: { sessionId: string; chunkKey: string; width: number } | null;
}

export type TrendSpec = z.infer<typeof trendSpec>;
export type TopSpec = z.infer<typeof topSpec>;
export type FunnelSpec = z.infer<typeof funnelSpec>;
export type RetentionSpec = z.infer<typeof retentionSpec>;
export type ScrollDepthSpec = z.infer<typeof scrollDepthSpec>;
export type EventsSpec = z.infer<typeof eventsSpec>;
export type PropertiesSpec = z.infer<typeof propertiesSpec>;
