import type { Answer, ApiIssue, HeatmapResult } from "@cfanalytics/shared";
import { DAY_MS, heatmapSpec, jsonPointer, QUERY, resolveRange } from "@cfanalytics/shared";
import type { Hono } from "hono";
import {
  type AppContext,
  type AppEnv,
  apiError,
  dashboardAnswer,
  readJsonBody,
  STORE_UNAVAILABLE,
} from "../../platform/http.ts";
import { projectStore } from "../../platform/project-store-id.ts";
import { messageOf } from "../../platform/result.ts";
import { requireAdmin } from "../../platform/session.ts";
import { dashboardProject } from "../projects/index.ts";
import { heatmapMeta, type PointsQuery, pointRules } from "./core.ts";

// POST /api/projects/:id/heatmap, behind requireAdmin, with no CORS headers
// (platform-11): a HeatmapSpec in, an Answer<HeatmapResult> out (heatmaps-02,
// heatmaps-11, heatmaps-12, heatmaps-19). A refusal is apiError's JSON.
export function mountHeatmaps(app: Hono<AppEnv>): void {
  app.post("/api/projects/:id/heatmap", requireAdmin(), handleHeatmap);
}

/**
 * One heatmap:
 * 1. readJsonBody with QUERY.bodyBytes: too large is 413. JSON that does not
 *    parse is 400 validation_failed; a body heatmapSpec (shared) refuses is
 *    400 validation_failed with an issue per zod issue, its path as a JSON
 *    pointer such as "/widthBand".
 * 2. getProject (projects): a failure is 503, an unknown or deleted project
 *    404, with no ProjectStore contacted.
 * 3. resolveRange(spec.range, spec.timeZone ?? the project's timezone,
 *    deps.now(), deps.now() minus heatmaps_retention_days days): an error is
 *    400 validation_failed.
 * 4. pointRules(the project's internal_rules).
 * 5. RPC calls to projectStore(env, id), in turn: heatmapPoints with the
 *    PointsQuery of spec.path, spec.widthBand ?? null (the busiest band,
 *    heatmaps-24), the range, spec.type ?? null, spec.includeBots ?? false
 *    and the excluded hosts; then, when a band was answered,
 *    latestSnapshot of spec.path and that band. An error from either is 503.
 * 6. 200 with {meta: heatmapMeta(range, includeBots, rules, rowsRead),
 *    result: {widthBand, points, bands, snapshot}}, the snapshot as {sessionId, chunkKey: its
 *    objectKey, width} or null when the page has no full snapshot in that
 *    band (heatmaps-02, heatmaps-19), as dashboardAnswer: private, no-store.
 */
export async function handleHeatmap(c: AppContext): Promise<Response> {
  const body = await readJsonBody(c.req.raw, QUERY.bodyBytes);
  if (!body.ok) return body.error;
  const raw = body.value;

  const spec = heatmapSpec.safeParse(raw);
  if (!spec.success) {
    const issues: ApiIssue[] = spec.error.issues.map((issue) => ({
      path: jsonPointer(issue.path),
      code: issue.code,
      message: issue.message,
    }));
    return validationFailure(issues);
  }

  const project = await dashboardProject(c);
  if (!project.ok) return project.error;

  const deps = c.get("deps");
  const settings = project.value.settings;
  const now = deps.now();
  const range = resolveRange(
    spec.data.range,
    spec.data.timeZone ?? settings.timezone,
    now,
    now - settings.heatmaps_retention_days * DAY_MS,
  );
  if (!range.ok) return apiError(400, "validation_failed", rangeMessage(range.error));

  const rules = pointRules(settings.internal_rules);
  const includeBots = spec.data.includeBots ?? false;
  const query: PointsQuery = {
    path: spec.data.path,
    widthBand: spec.data.widthBand ?? null,
    from: range.value.from,
    to: range.value.to,
    kind: spec.data.type ?? null,
    includeBots,
    excludedHosts: rules.excludedHosts,
  };

  const store = projectStore(c.env, project.value.id);
  // The snapshot needs the band answered, which with no band asked is the
  // busiest the points read found (heatmaps-24), so the reads go in turn.
  let pointsAnswer: Awaited<ReturnType<typeof store.heatmapPoints>>;
  let snapshotAnswer: Awaited<ReturnType<typeof store.latestSnapshot>> | null = null;
  try {
    pointsAnswer = await store.heatmapPoints(query);
    const band = pointsAnswer.ok ? pointsAnswer.value.widthBand : null;
    if (band !== null) snapshotAnswer = await store.latestSnapshot(spec.data.path, band);
  } catch (cause) {
    deps.log.error("project_store_failed", { message: messageOf(cause) });
    return apiError(503, "unavailable", STORE_UNAVAILABLE);
  }
  if (!pointsAnswer.ok || (snapshotAnswer !== null && !snapshotAnswer.ok)) {
    const error = pointsAnswer.ok
      ? snapshotAnswer?.ok === false
        ? snapshotAnswer.error
        : null
      : pointsAnswer.error;
    deps.log.error("project_store_refused", { error });
    return apiError(503, "unavailable", STORE_UNAVAILABLE);
  }

  const found = snapshotAnswer === null ? null : snapshotAnswer.value;
  const result: HeatmapResult = {
    widthBand: pointsAnswer.value.widthBand,
    points: pointsAnswer.value.points,
    bands: pointsAnswer.value.bands,
    snapshot:
      found === null
        ? null
        : { sessionId: found.sessionId, chunkKey: found.objectKey, width: found.width },
  };
  const answer: Answer<HeatmapResult> = {
    meta: heatmapMeta(range.value, includeBots, rules, pointsAnswer.value.rowsRead),
    result,
  };
  return dashboardAnswer(answer);
}

/** The body's issues, with one plain sentence naming the first (platform-34). */
function validationFailure(issues: ApiIssue[]): Response {
  const [first] = issues;
  if (first === undefined) return apiError(400, "validation_failed", "The body is not valid.");
  const where = first.path === "" ? "The body" : first.path;
  return apiError(400, "validation_failed", `${where}: ${first.message}`, issues);
}

/** The range error as one plain sentence (query-11). */
function rangeMessage(error: "start not before end" | "negative start"): string {
  return error === "negative start"
    ? "The range starts before 1970."
    : "The range must start before it ends.";
}
