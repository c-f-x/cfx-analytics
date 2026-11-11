import { BODY_LIMITS, isJsonObject } from "@cfanalytics/shared";
import type { Hono } from "hono";
import { mirroredOrigin, sdkCorsHeaders } from "../../platform/cors.ts";
import {
  type AppContext,
  type AppEnv,
  bodyRefusal,
  readBody,
  STORE_UNAVAILABLE,
  sdkAnswer,
  sdkError,
} from "../../platform/http.ts";
import type { IngestAnswer, IngestError } from "../../platform/ingest.ts";
import { projectStore } from "../../platform/project-store-id.ts";
import { messageOf, type Result } from "../../platform/result.ts";
import type { SchemaError } from "../../platform/schema.ts";
import { enrich, type RequestFacts } from "../enrich/index.ts";
import { type HeatmapPointInput, pointsFromEvent } from "../heatmaps/index.ts";
import { sdkProject } from "../projects/index.ts";
import {
  captureAnswer,
  type DropReason,
  type IncomingEvent,
  prepareEvent,
  quotaKey,
  retentionStart,
} from "./core.ts";
import { decodeBody, sentLimit } from "./decode.ts";
import { type Normalized, normalizeBody } from "./normalize.ts";
import { uuidV7 } from "./uuid.ts";

// The capture paths (intake-15): /e, /i/v0/e, /capture and /batch, each with
// or without a trailing slash, and never a redirect. /s/ is the recordings
// slice's, and /flags and remote config the config slice's.

/** Every capture path, with and without its trailing slash (intake-15). */
export const CAPTURE_PATHS = [
  "/e",
  "/e/",
  "/i/v0/e",
  "/i/v0/e/",
  "/capture",
  "/capture/",
  "/batch",
  "/batch/",
] as const;

export function mountCapture(app: Hono<AppEnv>): void {
  for (const path of CAPTURE_PATHS) app.all(path, handleCapture);
}

/**
 * One request on a capture path. Every answer, refusals included, carries
 * sdkCorsHeaders(mirroredOrigin(Origin), Access-Control-Request-Headers,
 * preflight) and is never 204 (intake-12, D-20). A refusal is sdkError,
 * apiError's JSON {code, message} as on every other path: 400 validation_failed, 401
 * unauthorized, 405 method_not_allowed, 413 body_too_large, 503 unavailable.
 * A 503's message is fixed; the cause goes to the log only (platform-42).
 * - OPTIONS: the preflight, 200 with an empty body (intake-12).
 * - Any method but POST and OPTIONS: 405, nothing read or stored (intake-17).
 * - POST:
 *   1. readBody with sentLimit(Content-Type, Content-Encoding,
 *      BODY_LIMITS.eventBytes), then decodeBody with BODY_LIMITS.eventBytes:
 *      too large is 413, unreadable is 400 (intake-05, intake-24 to
 *      intake-26). Neither the registry nor a ProjectStore is contacted.
 *   2. normalizeBody with the query's sent_at: "not events" is 400 (intake-24).
 *   3. No token is 401. resolveToken (projects) with REGISTRY, caches.default
 *      and deps.now(): a failure is 503 and an unknown token is 401, with no
 *      ProjectStore contacted (intake-02, intake-28).
 *   4. Keeps the events whose own token is null or the project's (intake-21,
 *      intake-22). Each goes through prepareEvent with receivedAt =
 *      deps.now(), retentionStart from the project's events_retention_days,
 *      newUuid = uuidV7(deps.now(), deps.random(10)) and the User-Agent
 *      header; a dropped event is counted for the log (intake-18,
 *      cookieless-03, cookieless-14). Then enrich, with RequestFacts from
 *      request.cf and the User-Agent header, gives its properties, bot and
 *      page. A $$heatmap event becomes no event: pointsFromEvent (heatmaps)
 *      turns it into points, from its properties as sent, its prepared uuid,
 *      time and session, its bot flag, its distinct id (null when
 *      cookieless) and the project's heatmaps_enabled (intake-19,
 *      heatmaps-01, heatmaps-05). Every other name, $snapshot included, is an
 *      ordinary event (intake-19).
 *   5. With no events and no points left, 200 with captureAnswer(false,
 *      "events"), and no ProjectStore contacted.
 *   6. One RPC, ingest, to projectStore(env, project id), with the events,
 *      the points, the project's daily_event_cap and timezone and the client IP from CF-Connecting-IP
 *      only, never X-Forwarded-For or X-Real-IP (cookieless-16). An error
 *      answered or thrown is 503 (intake-28, cookieless-17).
 *   7. 200 with captureAnswer(quotaLimited, quotaKey of the names of the
 *      events sent), after the store committed (intake-01, intake-30).
 */
export async function handleCapture(c: AppContext): Promise<Response> {
  const preflight = c.req.method === "OPTIONS";
  const cors = sdkCorsHeaders(
    mirroredOrigin(c.req.header("origin") ?? null),
    c.req.header("access-control-request-headers") ?? null,
    preflight,
  );
  if (preflight) return new Response(null, { status: 200, headers: cors });
  if (c.req.method !== "POST") {
    const message = "Only POST and OPTIONS are allowed on this path.";
    return sdkError(cors, 405, "method_not_allowed", message);
  }

  const deps = c.get("deps");
  const contentType = c.req.header("content-type") ?? null;
  const contentEncoding = c.req.header("content-encoding") ?? null;
  const limit = BODY_LIMITS.eventBytes;

  // The body is read and decoded before anything else, so a body the path
  // refuses never reaches the registry or a store (intake-24).
  const bytes = await readBody(c.req.raw, sentLimit(contentType, contentEncoding, limit));
  if (!bytes.ok) return bodyRefusal(cors, bytes.error.kind === "too_large");

  const decoded = await decodeBody(bytes.value, contentType, contentEncoding, limit);
  if (!decoded.ok) return bodyRefusal(cors, decoded.error.kind === "too large");

  const normalized = normalizeBody(decoded.value.body, c.req.query("sent_at") ?? null);
  if (!normalized.ok) return sdkError(cors, 400, "validation_failed", "The body holds no events.");

  const token = normalized.value.token;
  if (token === null) {
    return sdkError(cors, 401, "unauthorized", "The request carries no project token.");
  }

  const now = deps.now();
  const project = await sdkProject(c, token, now, cors);
  if (!project.ok) return project.error;

  const headerUserAgent = c.req.header("user-agent") ?? null;
  const { events, points, dropped } = prepareBatch(normalized.value, token, {
    receivedAt: now,
    retentionStart: retentionStart(now, project.value.settings.events_retention_days),
    newUuid: () => uuidV7(deps.now(), deps.random(10)),
    headerUserAgent,
    facts: requestFacts(c.req.raw.cf, headerUserAgent),
    heatmapsEnabled: project.value.settings.heatmaps_enabled,
  });
  if (hasDrops(dropped)) deps.log.info("capture_events_dropped", { ...dropped });

  if (events.length === 0 && points.length === 0) {
    return sdkAnswer(cors, captureAnswer(false, "events"));
  }

  let answer: Result<IngestAnswer, SchemaError | IngestError>;
  try {
    answer = await projectStore(c.env, project.value.id).ingest({
      projectId: project.value.id,
      receivedAt: now,
      settings: {
        daily_event_cap: project.value.settings.daily_event_cap,
        timezone: project.value.settings.timezone,
      },
      clientIp: c.req.header("cf-connecting-ip") ?? null,
      events,
      points,
    });
  } catch (cause) {
    deps.log.error("project_store_failed", { message: messageOf(cause) });
    return sdkError(cors, 503, "unavailable", STORE_UNAVAILABLE);
  }
  if (!answer.ok) {
    deps.log.error("project_store_refused", { error: answer.error });
    return sdkError(cors, 503, "unavailable", STORE_UNAVAILABLE);
  }

  const key = quotaKey(events.map((event) => event.event));
  return sdkAnswer(cors, captureAnswer(answer.value.quotaLimited, key));
}

/** Why an event was left out before the store, by reason, for one log line. */
interface DroppedEvents {
  noName: number;
  noDistinctId: number;
  badProperties: number;
  longDistinctId: number;
  foreignToken: number;
  olderThanRetention: number;
  cookielessWithoutMode: number;
  cookielessIdentity: number;
}

/** The log field that counts each reason prepareEvent gives. */
const DROP_FIELD = {
  "older than retention": "olderThanRetention",
  "cookieless without mode": "cookielessWithoutMode",
  "cookieless identity": "cookielessIdentity",
} as const satisfies Record<DropReason, keyof DroppedEvents>;

/**
 * The batch's storable events: those whose own token is null or the project's,
 * each prepared and then enriched; the points of its $$heatmap events, which
 * make no event row; and the counts of what was left out (intake-18 to
 * intake-22, cookieless-03, cookieless-14, heatmaps-01).
 */
function prepareBatch(
  normalized: Normalized,
  projectToken: string,
  context: {
    receivedAt: number;
    retentionStart: number;
    newUuid: () => string;
    headerUserAgent: string | null;
    facts: RequestFacts;
    heatmapsEnabled: boolean;
  },
): { events: IncomingEvent[]; points: HeatmapPointInput[]; dropped: DroppedEvents } {
  const dropped: DroppedEvents = {
    ...normalized.dropped,
    foreignToken: 0,
    olderThanRetention: 0,
    cookielessWithoutMode: 0,
    cookielessIdentity: 0,
  };
  const events: IncomingEvent[] = [];
  const points: HeatmapPointInput[] = [];
  for (const raw of normalized.events) {
    if (raw.token !== null && raw.token !== projectToken) {
      dropped.foreignToken += 1;
      continue;
    }
    const prepared = prepareEvent(raw, context);
    if (!prepared.ok) {
      dropped[DROP_FIELD[prepared.error]] += 1;
      continue;
    }
    const enriched = enrich(prepared.value.properties, context.facts);
    if (raw.event === "$$heatmap") {
      // Kept as its points only (intake-19, D-20). The properties as sent,
      // since clipping could cut a long URL key.
      const event = prepared.value;
      const eventPoints = pointsFromEvent(
        {
          uuid: event.uuid,
          properties: raw.properties,
          ts: event.ts,
          bot: enriched.bot,
          distinctId: event.cookieless ? null : event.distinctId,
          sessionId: event.sessionId,
        },
        context.heatmapsEnabled,
      );
      points.push(...eventPoints);
      continue;
    }
    events.push({
      ...prepared.value,
      properties: enriched.properties,
      bot: enriched.bot,
      page: enriched.page,
    });
  }
  return { events, points, dropped };
}

function hasDrops(dropped: DroppedEvents): boolean {
  return Object.values(dropped).some((count) => count > 0);
}

/**
 * What enrich reads from the request. `request.cf` is typed as either the
 * incoming or the init shape here, and the bot category is not in this version
 * of the workers types, so its fields are read as plain values.
 */
function requestFacts(cf: unknown, userAgent: string | null): RequestFacts {
  const fields: Record<string, unknown> = isJsonObject(cf) ? cf : {};
  return {
    country: textOrNull(fields.country),
    verifiedBotCategory: textOrNull(fields.verifiedBotCategory),
    userAgent,
    timezone: textOrNull(fields.timezone),
  };
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
