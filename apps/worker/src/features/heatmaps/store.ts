import type { ExportPage, HeatmapBand, HeatmapPoint } from "@cfanalytics/shared";
import { BOUND_PARAMETERS_MAX } from "@cfanalytics/shared";
import { type ExportShape, exportCursor, rowNumber } from "../../platform/rows.ts";
import { runsOf } from "../../platform/runs.ts";
import { busiestBand, type HeatmapKind, type HeatmapPointInput, type PointsQuery } from "./core.ts";

// The `heatmap_points` table. Synchronous: written inside the ProjectStore's
// write transaction, read inside one call. Every statement binds its
// parameters, and none binds more than 100, the store's limit per statement.

const POINT_COLUMNS =
  "event_uuid, seq, host, path, width_band, x, y, kind, fixed, bot, ts, session_id, distinct_id";
const POINT_ROW_PARAMETERS = 13;
/** Thirteen parameters a row, so seven rows meet the statement limit. */
const POINT_ROWS_PER_STATEMENT = Math.floor(BOUND_PARAMETERS_MAX / POINT_ROW_PARAMETERS);

/**
 * The heatmap events among `eventUuids` whose points are already stored, so a
 * resent event takes no cap slot and stores its points once (heatmaps-13,
 * heatmaps-21). One statement for each BOUND_PARAMETERS_MAX of them.
 */
export function storedPointEvents(sql: SqlStorage, eventUuids: readonly string[]): Set<string> {
  const stored = new Set<string>();
  for (const run of runsOf(eventUuids, BOUND_PARAMETERS_MAX)) {
    const placeholders = run.map(() => "?").join(", ");
    const rows = sql
      .exec(
        `SELECT DISTINCT event_uuid FROM heatmap_points WHERE event_uuid IN (${placeholders})`,
        ...run,
      )
      .toArray();
    for (const row of rows) if (typeof row.event_uuid === "string") stored.add(row.event_uuid);
  }
  return stored;
}

/**
 * Inserts points with INSERT OR IGNORE on (event_uuid, seq), and answers how
 * many were new, counted from RETURNING (heatmaps-01, heatmaps-13).
 */
export function insertPoints(sql: SqlStorage, points: readonly HeatmapPointInput[]): number {
  let added = 0;
  for (const chunk of runsOf(points, POINT_ROWS_PER_STATEMENT)) {
    const values = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
    const bindings: SqlStorageValue[] = [];
    for (const point of chunk) {
      bindings.push(
        point.eventUuid,
        point.seq,
        point.host,
        point.path,
        point.widthBand,
        point.x,
        point.y,
        point.kind,
        Number(point.fixed),
        Number(point.bot),
        point.ts,
        point.sessionId,
        point.distinctId,
      );
    }
    added += sql
      .exec(
        `INSERT OR IGNORE INTO heatmap_points (${POINT_COLUMNS}) VALUES ${values} RETURNING id`,
        ...bindings,
      )
      .toArray().length;
  }
  return added;
}

/**
 * The WHERE clause every read of one page's points shares: the path, ts in
 * [from, to), one kind when asked (heatmaps-12), bot = 0 unless includeBots,
 * and host not in excludedHosts.
 */
function pointFilter(query: PointsQuery): { where: string; bindings: SqlStorageValue[] } {
  const conditions = ["path = ?", "ts >= ?", "ts < ?"];
  const bindings: SqlStorageValue[] = [query.path, query.from, query.to];
  if (query.kind !== null) {
    conditions.push("kind = ?");
    bindings.push(query.kind);
  }
  if (!query.includeBots) conditions.push("bot = 0");
  if (query.excludedHosts.length > 0) {
    const placeholders = query.excludedHosts.map(() => "?").join(", ");
    // A point with no host is no excluded host.
    conditions.push(`(host IS NULL OR host NOT IN (${placeholders}))`);
    bindings.push(...query.excludedHosts);
  }
  return { where: conditions.join(" AND "), bindings };
}

/**
 * The page's bands with points, then the points of one band, in two
 * statements under the same filter (pointFilter). The bands are every
 * width_band with points, with their count, in band order (heatmaps-23). The
 * band read is the one asked, else the busiest (heatmaps-24); a page with no
 * points reads none. Its points have width_band equal to it, so a point of
 * another band is never scaled into it (heatmaps-11), grouped by x, y, fixed
 * and kind with a count, ordered by kind, fixed, y and x. rowsRead is both
 * cursors' rowsRead.
 */
export function readPoints(
  sql: SqlStorage,
  query: PointsQuery,
): { points: HeatmapPoint[]; bands: HeatmapBand[]; widthBand: number | null; rowsRead: number } {
  const filter = pointFilter(query);
  const bandCursor = sql.exec(
    `SELECT width_band, COUNT(*) AS points
       FROM heatmap_points
      WHERE ${filter.where}
      GROUP BY width_band
      ORDER BY width_band`,
    ...filter.bindings,
  );
  const bands = bandCursor.toArray().map((row) => ({
    widthBand: rowNumber(row.width_band, "width_band"),
    points: rowNumber(row.points, "points"),
  }));
  const widthBand = query.widthBand ?? busiestBand(bands);
  if (widthBand === null) return { points: [], bands, widthBand, rowsRead: bandCursor.rowsRead };
  const cursor = sql.exec(
    `SELECT x, y, fixed, kind AS type, COUNT(*) AS count
       FROM heatmap_points
      WHERE ${filter.where} AND width_band = ?
      GROUP BY x, y, fixed, kind
      ORDER BY kind, fixed, y, x`,
    ...filter.bindings,
    widthBand,
  );
  const points = cursor.toArray().map((row) => ({
    x: rowNumber(row.x, "x"),
    y: rowNumber(row.y, "y"),
    fixed: rowNumber(row.fixed, "fixed") === 1,
    type: asKind(row.type),
    count: rowNumber(row.count, "count"),
  }));
  return { points, bands, widthBand, rowsRead: cursor.rowsRead + bandCursor.rowsRead };
}

function asKind(value: SqlStorageValue | undefined): HeatmapKind {
  if (value === "click" || value === "rageclick" || value === "deadclick") return value;
  throw new Error("heatmap_points.kind holds no point kind");
}

// ── Retention, deletion by person and export (wave 4) ──────────────────────

/** Deletes up to `limit` points whose ts is before `cutoffTs`, the oldest first, and answers how many (privacy-14, privacy-27). */
export function prunePoints(sql: SqlStorage, cutoffTs: number, limit: number): number {
  return sql
    .exec(
      `DELETE FROM heatmap_points WHERE id IN (
         SELECT id FROM heatmap_points WHERE ts < ? ORDER BY ts, id LIMIT ?
       ) RETURNING id`,
      cutoffTs,
      limit,
    )
    .toArray().length;
}

/** Deletes the points whose distinct_id is one of `distinctIds`, in statements of at most BOUND_PARAMETERS_MAX parameters, and answers how many (privacy-05). */
export function erasePoints(sql: SqlStorage, distinctIds: readonly string[]): number {
  let deleted = 0;
  for (const run of runsOf(distinctIds, BOUND_PARAMETERS_MAX)) {
    const placeholders = run.map(() => "?").join(", ");
    deleted += sql
      .exec(
        `DELETE FROM heatmap_points WHERE distinct_id IN (${placeholders}) RETURNING id`,
        ...run,
      )
      .toArray().length;
  }
  return deleted;
}

/**
 * One export page of `heatmap_points` (privacy-22, privacy-25): an
 * ExportPage of up to `limit` rows with a rowid above `after`, by rowid, each
 * one JSON line of its columns by name. `next` is the last row's rowid when
 * the page holds `limit` rows, else null.
 */
/** The columns a heatmap_points export writes, and an import reads back (privacy-22, privacy-30). */
export const POINTS_SHAPE: ExportShape = {
  table: "heatmap_points",
  columns: [
    "id",
    "event_uuid",
    "seq",
    "host",
    "path",
    "width_band",
    "x",
    "y",
    "kind",
    "fixed",
    "bot",
    "ts",
    "session_id",
    "distinct_id",
  ],
  json: [],
};

export function exportPoints(sql: SqlStorage, after: number, limit: number): ExportPage {
  const page = sql
    .exec(
      `SELECT rowid AS row_id, ${POINTS_SHAPE.columns.join(", ")}
         FROM heatmap_points WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      after,
      limit,
    )
    .toArray();
  const lines = page.map((row) => {
    const columns: Record<string, unknown> = { ...row };
    delete columns.row_id;
    return JSON.stringify(columns);
  });
  return { lines, next: exportCursor(page, limit) };
}
