import { DISTINCT_ID_MAX, isJsonObject, type Json, type JsonObject } from "@cfanalytics/shared";
import { err, ok, type Result } from "../../platform/result.ts";

// Reads any SDK's body into one event shape (intake-13, intake-15, intake-16,
// intake-20 to intake-22, intake-29; posthog-protocol.md §1.3, §3.2, §9.1,
// §10.3). Spike S2 proved the reading against the real SDKs.

/** One event as the SDK sent it, before clipping and enrichment. */
export interface RawEvent {
  /** The event's uuid when it sent a string, else null. */
  uuid: string | null;
  event: string;
  /**
   * The event's own token: properties.token, else its own api_key, else its
   * own token, else null. Never the wrapper's: a token that differs from the
   * project's drops the event (intake-22).
   */
  token: string | null;
  /** The top-level distinct_id, else properties.distinct_id; a number becomes its decimal text (intake-13). */
  distinctId: string;
  /** properties as sent, without `distinct_id`, which the distinctId column holds (cookieless-01). An absent properties is {}. */
  properties: JsonObject;
  /** properties.$set merged with a top-level $set, the top level winning key by key (intake-13, identity-09). */
  set: JsonObject;
  /** The same merge for $set_once. */
  setOnce: JsonObject;
  /** The string keys of a top-level $unset, else of properties.$unset (identity-08). */
  unset: string[];
  /** The event's timestamp as sent, or null. */
  timestamp: Json;
  /** The event's own sent_at, else the wrapper's, else `sentAtQuery`, else null (intake-34, posthog-protocol.md §1.5). */
  sentAt: Json;
}

export interface Normalized {
  events: RawEvent[];
  /** How many events were dropped, by reason, for the log. */
  dropped: { noName: number; noDistinctId: number; badProperties: number; longDistinctId: number };
  /** The wrapper's api_key, else the first event's own token, else null (intake-21). */
  token: string | null;
}

/** Why one batch item became no event, as a key of Normalized's counts. */
type DropKey = keyof Normalized["dropped"];

/**
 * The events of an analytics body: the {api_key, batch, sent_at} wrapper (an
 * object whose `batch` is an array), a bare array, or one event object (any
 * other object with an `event` key), which is how the hand-built client sends
 * (intake-16). Any other top-level key, such as historical_migration, is ignored
 * (intake-18, intake-20). A body that is none of these is "not events"
 * (intake-24). Each event is dropped and counted, while the others are kept,
 * when it has no string name (an empty name counts as none), no distinct id
 * (missing, empty, or neither a string nor a number), `properties` present
 * but not an object, or a distinct id over DISTINCT_ID_MAX characters
 * (intake-29). An item of the batch that is not an object counts as no name.
 * A body with no events left is still events, with an empty list.
 */
export function normalizeBody(
  body: unknown,
  sentAtQuery: string | null,
): Result<Normalized, "not events"> {
  let items: readonly unknown[];
  let wrapper: JsonObject | null = null;
  if (Array.isArray(body)) {
    items = body;
  } else if (isJsonObject(body)) {
    if (Array.isArray(body.batch)) {
      wrapper = body;
      items = body.batch;
    } else if (Object.hasOwn(body, "event")) {
      items = [body];
    } else {
      return err("not events");
    }
  } else {
    return err("not events");
  }

  const wrapperSentAt = wrapper?.sent_at ?? null;
  const wrapperToken = textOf(wrapper?.api_key);
  const events: RawEvent[] = [];
  const dropped = { noName: 0, noDistinctId: 0, badProperties: 0, longDistinctId: 0 };
  for (const item of items) {
    const event = readEvent(item, wrapperSentAt, sentAtQuery);
    if (typeof event === "string") dropped[event] += 1;
    else events.push(event);
  }
  return ok({ events, dropped, token: wrapperToken ?? events[0]?.token ?? null });
}

/** One batch item as a RawEvent, or the reason it is no event. */
function readEvent(
  item: unknown,
  wrapperSentAt: Json,
  sentAtQuery: string | null,
): RawEvent | DropKey {
  if (!isJsonObject(item)) return "noName";
  const name = item.event;
  if (typeof name !== "string" || name === "") return "noName";
  const properties = item.properties ?? {};
  if (!isJsonObject(properties)) return "badProperties";
  const distinctId = idOf(item.distinct_id) ?? idOf(properties.distinct_id);
  if (distinctId === null || distinctId === "") return "noDistinctId";
  if (distinctId.length > DISTINCT_ID_MAX) return "longDistinctId";

  return {
    uuid: typeof item.uuid === "string" ? item.uuid : null,
    event: name,
    token: textOf(properties.token) ?? textOf(item.api_key) ?? textOf(item.token),
    distinctId,
    properties: withoutDistinctId(properties),
    set: mergeOps(properties.$set, item.$set),
    setOnce: mergeOps(properties.$set_once, item.$set_once),
    unset: unsetOf(item.$unset, properties.$unset),
    timestamp: item.timestamp ?? null,
    sentAt: item.sent_at ?? wrapperSentAt ?? sentAtQuery,
  };
}

/** A distinct id as text, or null when the value is neither a string nor a number. */
function idOf(value: Json | undefined): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** A non-empty string, or null. */
function textOf(value: Json | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A shallow copy of the event's properties, less `distinct_id`. */
function withoutDistinctId(properties: JsonObject): JsonObject {
  const copy: JsonObject = {};
  for (const [key, value] of Object.entries(properties)) {
    if (key !== "distinct_id") copy[key] = value;
  }
  return copy;
}

/** `base` and then `top`, so the top-level object wins key by key. */
function mergeOps(base: Json | undefined, top: Json | undefined): JsonObject {
  const merged: JsonObject = {};
  if (isJsonObject(base)) Object.assign(merged, base);
  if (isJsonObject(top)) Object.assign(merged, top);
  return merged;
}

/** The top-level $unset when it is an array, else properties.$unset, keeping strings. */
function unsetOf(top: Json | undefined, inProperties: Json | undefined): string[] {
  const source = Array.isArray(top) ? top : Array.isArray(inProperties) ? inProperties : null;
  if (source === null) return [];
  return source.filter((entry): entry is string => typeof entry === "string");
}
