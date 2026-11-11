import { CLIP, DAY_MS, DISTINCT_ID_MAX, isTimeZone, type JsonObject } from "@cfanalytics/shared";
import { err, ok, type Result } from "../../platform/result.ts";
import { clipProperties, clipText } from "./clip.ts";
import type { RawEvent } from "./normalize.ts";
import { eventTime } from "./time.ts";
import { isUuid } from "./uuid.ts";

// From a normalised event to what the ProjectStore stores (architecture.md,
// "An event", steps 3 and 4). Pure: the receive time, the retention horizon
// and the id source arrive as arguments.

/** The sentinel distinct id of posthog-js's cookieless mode (posthog-protocol.md §5). */
export const COOKIELESS_SENTINEL = "$posthog_cookieless";

/** One event ready for the ProjectStore. The IP never travels inside it (intake-07). */
export interface IncomingEvent {
  uuid: string;
  /** The name as sent, clipped to CLIP.eventName bytes (intake-04, intake-32). */
  event: string;
  distinctId: string;
  /** Clipped (intake-04), then enriched (enrich). */
  properties: JsonObject;
  set: JsonObject;
  setOnce: JsonObject;
  unset: string[];
  /** Event time in ms (eventTime). */
  ts: number;
  /** $process_person_profile; true unless it is the boolean false (identity-06, D-20). */
  processPerson: boolean;
  /** The sentinel with $cookieless_mode: true. The store replaces distinctId with its hash (cookieless-01). */
  cookieless: boolean;
  /** properties.$session_id when it is a string, else null. */
  sessionId: string | null;
  /** properties.$anon_distinct_id of an $identify when it is a non-empty string other than distinctId, else null. */
  anonDistinctId: string | null;
  /** properties.alias of a $create_alias when it is a non-empty string, else null. */
  alias: string | null;
  /** Cookieless events only, else null: $raw_user_agent when a non-empty string, else the User-Agent header, else "" (cookieless-08). */
  hashUserAgent: string | null;
  /** Cookieless events only, else null: $host exactly as sent, before enrich normalises it, else "" (cookieless-01). */
  hashHost: string | null;
  /** properties.$timezone when it is a valid IANA name (isTimeZone), else null; the salt's day reads it (cookieless-09). */
  timezone: string | null;
  /** From enrich (enrich-16). */
  bot: boolean;
  /** From enrich (enrich-23). */
  page: string | null;
}

export type DropReason = "older than retention" | "cookieless without mode" | "cookieless identity";

/** The earliest event time a project keeps: receivedAt minus its events_retention_days (intake-18, D-20). */
export function retentionStart(receivedAt: number, retentionDays: number): number {
  return receivedAt - retentionDays * DAY_MS;
}

/**
 * Prepares one event, before enrichment:
 * - the uuid kept when isUuid, else newUuid() (intake-31);
 * - the name clipped with clipText to CLIP.eventName (intake-04);
 * - the time from eventTime with raw.timestamp, raw.sentAt, receivedAt and
 *   properties.$ignore_sent_at === true (intake-14, intake-33 to intake-37);
 * - properties, $set and $set_once clipped with clipProperties (intake-04);
 * - the flags and ids of IncomingEvent read from the properties as sent.
 * Drops, with the reason:
 * - an event whose time is before `retentionStart` (intake-18);
 * - the sentinel distinct id without $cookieless_mode: true (cookieless-14);
 * - a cookieless $identify or $create_alias (cookieless-03).
 * Every other event name, $groupidentify and $exception included, passes as
 * an ordinary event (identity-16).
 */
export function prepareEvent(
  raw: RawEvent,
  context: {
    receivedAt: number;
    retentionStart: number;
    newUuid: () => string;
    headerUserAgent: string | null;
  },
): Result<Omit<IncomingEvent, "bot" | "page">, DropReason> {
  const properties = raw.properties;
  const cookieless = raw.distinctId === COOKIELESS_SENTINEL && properties.$cookieless_mode === true;
  const ts = eventTime({
    timestamp: raw.timestamp,
    sentAt: raw.sentAt,
    receivedAt: context.receivedAt,
    ignoreSentAt: properties.$ignore_sent_at === true,
  });

  if (ts < context.retentionStart) return err("older than retention");
  if (raw.distinctId === COOKIELESS_SENTINEL && !cookieless) {
    return err("cookieless without mode");
  }
  if (cookieless && (raw.event === "$identify" || raw.event === "$create_alias")) {
    return err("cookieless identity");
  }

  const rawUserAgent = properties.$raw_user_agent;
  const userAgent =
    typeof rawUserAgent === "string" && rawUserAgent !== ""
      ? rawUserAgent
      : (context.headerUserAgent ?? "");
  const host = properties.$host;
  const anon = properties.$anon_distinct_id;
  const alias = properties.alias;
  const timezone = properties.$timezone;

  return ok({
    uuid: isUuid(raw.uuid) ? raw.uuid : context.newUuid(),
    event: clipText(raw.event, CLIP.eventName),
    distinctId: raw.distinctId,
    properties: clipProperties(properties),
    set: clipProperties(raw.set),
    setOnce: clipProperties(raw.setOnce),
    unset: raw.unset,
    ts,
    processPerson: properties.$process_person_profile !== false,
    cookieless,
    sessionId: typeof properties.$session_id === "string" ? properties.$session_id : null,
    anonDistinctId:
      raw.event === "$identify" && isLinkableId(anon) && anon !== raw.distinctId ? anon : null,
    alias: raw.event === "$create_alias" && isLinkableId(alias) ? alias : null,
    hashUserAgent: cookieless ? userAgent : null,
    hashHost: cookieless ? (typeof host === "string" ? host : "") : null,
    timezone: typeof timezone === "string" && isTimeZone(timezone) ? timezone : null,
  });
}

/**
 * The batch's quota key (intake-30, posthog-protocol.md §2.5): "exceptionEvent"
 * when there is at least one name and every one is $exception, else "events".
 */
export function quotaKey(eventNames: readonly string[]): "events" | "exceptionEvent" {
  const allExceptions = eventNames.length > 0 && eventNames.every((name) => name === "$exception");
  return allExceptions ? "exceptionEvent" : "events";
}

/**
 * The capture answer body: {"status": 1}, and with quotaLimited also
 * "quota_limited": [key], as {"status": 1, "quota_limited": ["events"]}
 * (intake-01, events-02, events-03).
 */
export function captureAnswer(
  quotaLimited: boolean,
  key: "events" | "exceptionEvent",
): { status: 1; quota_limited?: string[] } {
  return quotaLimited ? { status: 1, quota_limited: [key] } : { status: 1 };
}

/** An id another may be linked to: text of 1 to DISTINCT_ID_MAX characters, as distinct_id is (identity-21). */
function isLinkableId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= DISTINCT_ID_MAX;
}
