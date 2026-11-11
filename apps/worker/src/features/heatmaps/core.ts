import type {
  AnswerMeta,
  InternalRule,
  Json,
  JsonObject,
  ResolvedRange,
} from "@cfanalytics/shared";
import { isJsonObject, WIDTH_BAND_PX, wholeNumber } from "@cfanalytics/shared";
import { pageKey } from "../enrich/index.ts";

// Heatmap points from posthog-js's $$heatmap events, and the rules of a
// heatmap answer (D-20; posthog-protocol.md §8.1; data-model.md,
// heatmap_points). A $$heatmap event is kept only as its points. Pure.

export type HeatmapKind = "click" | "rageclick" | "deadclick";

/** One point as the ProjectStore stores it in heatmap_points. */
export interface HeatmapPointInput {
  /** The $$heatmap event's uuid. */
  eventUuid: string;
  /** The point's place among all of its event's points, from 0, so a retry stores nothing twice (heatmaps-13). */
  seq: number;
  /** The page's host, as pageKey (enrich) reads it (heatmaps-01). */
  host: string;
  /** The page's path, as pageKey reads it: no query string, no fragment (heatmaps-01, heatmaps-06). */
  path: string;
  /** widthBand of $viewport_width (heatmaps-01, heatmaps-11). */
  widthBand: number;
  /** Whole pixels, in the coordinates posthog-js sent (heatmaps-04). */
  x: number;
  y: number;
  kind: HeatmapKind;
  /** target_fixed: the point is in viewport coordinates and does not scroll with the page (heatmaps-04). */
  fixed: boolean;
  /** The event's bot flag from enrich (heatmaps-01). */
  bot: boolean;
  /** The event's time (intake's eventTime). */
  ts: number;
  sessionId: string | null;
  /** The event's distinct id, so deletion by person reaches the point; null for a cookieless event, which has no person. */
  distinctId: string | null;
}

/** The point types posthog-js sends that are kept (heatmaps-08, heatmaps-09). */
function isHeatmapKind(value: Json | undefined): value is HeatmapKind {
  return value === "click" || value === "rageclick" || value === "deadclick";
}

/** A viewport width rounded down to a multiple of WIDTH_BAND_PX (data-model.md, heatmap_points). */
export function widthBand(viewportWidth: number): number {
  return Math.floor(viewportWidth / WIDTH_BAND_PX) * WIDTH_BAND_PX;
}

/**
 * The points of one $$heatmap event (posthog-protocol.md §8.1). `properties`
 * are the event's properties as sent, before clipping, so a long URL key
 * stays whole. With heatmaps off there are none, whatever the client sent
 * (heatmaps-05). Otherwise:
 * - $viewport_width that is not a finite number of 0 or more gives none, and
 *   the event is not refused (heatmaps-07);
 * - for each key of $heatmap_data, a URL whose pageKey is not null, in the
 *   object's order, each point in its array's order: a "click", "rageclick"
 *   or "deadclick" point is kept (heatmaps-08); "mousemove" and any other
 *   type are not (heatmaps-09); a point whose x or y is missing, not a
 *   finite number or negative is skipped and the others kept (heatmaps-10);
 * - each kept point has the URL's host and path (heatmaps-01, heatmaps-06),
 *   x and y rounded to whole pixels and target_fixed === true as `fixed`,
 *   with no scroll added or taken away (heatmaps-04), and its seq counts the
 *   kept points of the whole event from 0.
 * $current_url and $pathname are not read: each URL key decides its own page
 * (heatmaps-06).
 */
export function pointsFromEvent(
  event: {
    uuid: string;
    properties: Readonly<JsonObject>;
    ts: number;
    bot: boolean;
    distinctId: string | null;
    sessionId: string | null;
  },
  heatmapsEnabled: boolean,
): HeatmapPointInput[] {
  if (!heatmapsEnabled) return [];

  const viewportWidth = wholeNumber(event.properties.$viewport_width);
  if (viewportWidth === null || viewportWidth < 0) return [];

  const data = event.properties.$heatmap_data;
  if (!isJsonObject(data)) return [];

  const band = widthBand(viewportWidth);
  const points: HeatmapPointInput[] = [];
  for (const [url, rawPoints] of Object.entries(data)) {
    if (!Array.isArray(rawPoints)) continue;
    const page = pageKey(url);
    if (page === null) continue;
    for (const raw of rawPoints) {
      if (!isJsonObject(raw)) continue;
      if (!isHeatmapKind(raw.type)) continue;
      const x = wholeNumber(raw.x);
      const y = wholeNumber(raw.y);
      if (x === null || x < 0 || y === null || y < 0) continue;
      points.push({
        eventUuid: event.uuid,
        seq: points.length,
        host: page.host,
        path: page.path,
        widthBand: band,
        x,
        y,
        kind: raw.type,
        fixed: raw.target_fixed === true,
        bot: event.bot,
        ts: event.ts,
        sessionId: event.sessionId,
        distinctId: event.distinctId,
      });
    }
  }
  return points;
}

/** How a project's internal rules bear on points, by each rule's place in the list. */
export interface PointRules {
  /** Hosts whose points are left out. */
  excludedHosts: string[];
  /** Rules that apply to points. */
  applied: number[];
  /** Rules that cannot apply to points (heatmaps-19). */
  notApplicable: number[];
}

/**
 * Which internal rules apply to points (D-20, heatmaps-19). A point has a
 * host and no person and no other properties, so only an event_property
 * rule on `$host` applies: its value, when a string, is a host whose points
 * are left out, matched exactly as written. Every person_property rule, and
 * every event_property rule on another property, cannot apply.
 */
export function pointRules(rules: readonly InternalRule[]): PointRules {
  const excludedHosts: string[] = [];
  const applied: number[] = [];
  const notApplicable: number[] = [];
  rules.forEach((rule, index) => {
    if (rule.kind === "event_property" && rule.property === "$host") {
      applied.push(index);
      if (typeof rule.value === "string") excludedHosts.push(rule.value);
    } else {
      notApplicable.push(index);
    }
  });
  return { excludedHosts, applied, notApplicable };
}

/** What the store reads for a heatmap answer. */
export interface PointsQuery {
  path: string;
  /** null: the page's busiest band (heatmaps-24). */
  widthBand: number | null;
  /** Half-open [from, to) on the point's ts. */
  from: number;
  to: number;
  /** One kind, or null for all three (heatmaps-12). */
  kind: HeatmapKind | null;
  /** Bot points are left out unless this is true (heatmaps-18's rule, for points). */
  includeBots: boolean;
  excludedHosts: string[];
}

/**
 * The meta of a heatmap answer (query-12's shape): the range as ISO UTC from
 * and to, `requested` when the range was clipped (query-40), the time zone,
 * excluded.bots as !includeBots, excluded.internalRules as rules.applied,
 * excluded.notApplicable as rules.notApplicable (heatmaps-19), and rowsRead.
 */
export function heatmapMeta(
  range: ResolvedRange,
  includeBots: boolean,
  rules: PointRules,
  rowsRead: number | null,
): AnswerMeta {
  const meta: AnswerMeta = {
    range: { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() },
    timeZone: range.timeZone,
    excluded: {
      bots: !includeBots,
      internalRules: [...rules.applied],
      notApplicable: [...rules.notApplicable],
    },
    rowsRead,
  };
  if (range.requested !== null) {
    meta.requested = {
      from: new Date(range.requested.from).toISOString(),
      to: new Date(range.requested.to).toISOString(),
    };
  }
  return meta;
}

/** The band with the most points, the narrower of equals; null when there is none (heatmaps-24). */
export function busiestBand(
  bands: readonly { widthBand: number; points: number }[],
): number | null {
  let best: { widthBand: number; points: number } | null = null;
  for (const band of bands) if (best === null || band.points > best.points) best = band;
  return best === null ? null : best.widthBand;
}
