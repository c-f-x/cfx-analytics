import {
  isJsonObject,
  type Json,
  type JsonObject,
  RECORDINGS_LIST,
  type RecordingSummary,
  wholeNumber,
} from "@cfanalytics/shared";
import { err, ok, type Result } from "../../platform/result.ts";
import { pageKey } from "../enrich/index.ts";
import { COOKIELESS_SENTINEL, isUuid, type RawEvent } from "../intake/index.ts";

// Recording chunks (D-13, D-20; posthog-protocol.md §7). The Worker turns
// each $snapshot event into one chunk: its rrweb events decoded, scrubbed and
// measured here; the ProjectStore reserves its bytes, writes it to R2 and
// records it (platform/ingest.ts). Pure, except that decodeChunk awaits
// DecompressionStream, which reads no clock and no network. Nothing here
// throws.

/** One rrweb event as stored: plain JSON, never with `cv` (recordings-25). */
export type RrwebEvent = JsonObject & { type: number; timestamp: number };

/** rrweb's event types (posthog-protocol.md §7.6). */
const TYPE = { fullSnapshot: 2, incremental: 3, meta: 4, plugin: 6 } as const;

/** rrweb's incremental sources (§7.6). */
const SOURCE = {
  mutation: 0,
  mouseMove: 1,
  mouseInteraction: 2,
  scroll: 3,
  viewportResize: 4,
  input: 5,
  touchMove: 6,
  mediaInteraction: 7,
  styleSheetRule: 8,
  drag: 12,
} as const;

/** rrweb's Click among its mouse interaction types (recordings-05). */
const MOUSE_CLICK = 2;

/** The recorder's own compression marker (posthog-protocol.md §7.5). */
const COMPRESSION = "2024-10";

/**
 * Whether a session id has the shape of a UUID: 8-4-4-4-12 hexadecimal
 * digits in either case, of any version, so no R2 key can reach outside its
 * session's prefix (recordings-08, D-20).
 */
export function isSessionId(value: unknown): value is string {
  return isUuid(value);
}

/** One $snapshot event's parts, before its rrweb events are read. */
export interface Snapshot {
  /** The event's uuid as sent, or null; the Worker replaces one that is not isUuid with a UUIDv7. */
  uuid: string | null;
  sessionId: string;
  distinctId: string;
  /** properties.$snapshot_data as sent. */
  data: Json[];
}

/** Why an event on /s/ makes no chunk, while the request's other events are kept. */
export type SnapshotDrop = "not a snapshot" | "cookieless" | "no session" | "no data";

/**
 * The parts of one event on /s/ (posthog-protocol.md §7.1, §7.3, §10.5), as
 * normalizeBody read it, its distinct id from the top level or from
 * properties:
 * - an event not named $snapshot is "not a snapshot", ignored (recordings-22);
 * - the cookieless sentinel distinct id, with or without $cookieless_mode, is
 *   "cookieless", and nothing of it is stored (cookieless-15);
 * - properties.$session_id absent or not a string is "no session", dropped
 *   while the rest are stored (recordings-21);
 * - a string $session_id that is not isSessionId, the empty string included,
 *   is "bad session", which refuses the whole request with 400 (recordings-08);
 * - properties.$snapshot_data that is not an array is "no data".
 * $snapshot_source is optional and never read (recordings-19).
 */
export function snapshotOf(raw: RawEvent): Result<Snapshot, SnapshotDrop | "bad session"> {
  if (raw.event !== "$snapshot") return err("not a snapshot");
  if (raw.distinctId === COOKIELESS_SENTINEL) return err("cookieless");

  const sessionId = raw.properties.$session_id;
  if (typeof sessionId !== "string") return err("no session");
  if (!isSessionId(sessionId)) return err("bad session");

  const data = raw.properties.$snapshot_data;
  if (!Array.isArray(data)) return err("no data");

  return ok({ uuid: raw.uuid, sessionId, distinctId: raw.distinctId, data });
}

/**
 * The rrweb events of a chunk as stored, in the order sent (recordings-25,
 * recordings-26, D-20):
 * - an item that is not an object with a number `type` and a finite number
 *   `timestamp` is left out;
 * - a plugin event (type 6) whose data.plugin is "rrweb/network@1" is left
 *   out;
 * - an event with `cv: "2024-10"` has its compressed fields decoded and `cv`
 *   removed: a full snapshot's (type 2) `data`; a mutation's (type 3, source
 *   0) `texts`, `attributes`, `removes` and `adds`; a stylesheet rule's (type
 *   3, source 8) `adds` and `removes`. Each such field that is a string is
 *   gzip bytes written one byte per character (latin1), gunzipped and parsed
 *   as JSON (posthog-protocol.md §7.5); a field that is not a string is kept
 *   as it is.
 * A field that does not decode, a character above U+00FF included, makes the
 * whole chunk "undecodable".
 */
export async function decodeChunk(
  data: readonly Json[],
): Promise<Result<RrwebEvent[], "undecodable">> {
  const events: RrwebEvent[] = [];
  for (const item of data) {
    if (!isJsonObject(item)) continue;
    const type = item.type;
    const timestamp = item.timestamp;
    if (typeof type !== "number" || typeof timestamp !== "number") continue;
    // A time no INTEGER column can hold adds nothing to the chunk (recordings-33).
    if (wholeNumber(timestamp) === null) continue;

    const event: RrwebEvent = { ...item, type, timestamp };
    if (isNetworkPlugin(event)) continue;

    const decoded = await decodeCompressed(event);
    if (!decoded.ok) return err("undecodable");
    events.push(decoded.value);
  }
  return ok(events);
}

/** Whether the event is the network plugin, which D-20 never stores. */
function isNetworkPlugin(event: RrwebEvent): boolean {
  if (event.type !== TYPE.plugin) return false;
  const data = event.data;
  return isJsonObject(data) && data.plugin === "rrweb/network@1";
}

/** An event with the recorder's compressed fields unpacked and no `cv` left. */
async function decodeCompressed(event: RrwebEvent): Promise<Result<RrwebEvent, "undecodable">> {
  if (event.cv !== COMPRESSION) return ok(event);

  const rest = withoutCv(event);
  const data = event.data;

  // A full snapshot's data is the gzip text itself, not a field inside it.
  if (event.type === TYPE.fullSnapshot) {
    if (typeof data !== "string") return ok(asRrweb(rest, event));
    const unpacked = await unpack(data);
    if (!unpacked.ok) return err("undecodable");
    return ok(asRrweb({ ...rest, data: unpacked.value }, event));
  }

  if (event.type !== TYPE.incremental || !isJsonObject(data)) return ok(asRrweb(rest, event));
  const fields = compressedFieldsOf(data.source);
  if (fields.length === 0) return ok(asRrweb(rest, event));

  const plain: JsonObject = { ...data };
  for (const field of fields) {
    const value = plain[field];
    if (typeof value !== "string") continue;
    const unpacked = await unpack(value);
    if (!unpacked.ok) return err("undecodable");
    plain[field] = unpacked.value;
  }
  return ok(asRrweb({ ...rest, data: plain }, event));
}

/** The fields the recorder compresses for an incremental source, if any. */
function compressedFieldsOf(source: Json | undefined): readonly string[] {
  if (source === SOURCE.mutation) return ["texts", "attributes", "removes", "adds"];
  if (source === SOURCE.styleSheetRule) return ["adds", "removes"];
  return [];
}

/** `fields` as an rrweb event, with the required fields the object type needs. */
function asRrweb(fields: JsonObject, event: RrwebEvent): RrwebEvent {
  return { ...fields, type: event.type, timestamp: event.timestamp };
}

/** A copy without `cv`: the player never sees the marker (recordings-25). */
function withoutCv(event: JsonObject): JsonObject {
  const copy: JsonObject = {};
  for (const [key, value] of Object.entries(event)) {
    if (key !== "cv") copy[key] = value;
  }
  return copy;
}

/** One latin1 gzip field as its JSON, or "undecodable" (posthog-protocol.md §7.5). */
async function unpack(text: string): Promise<Result<Json, "undecodable">> {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 0xff) return err("undecodable");
    bytes[index] = code;
  }

  const body = new Response(bytes).body;
  if (body === null) return err("undecodable");
  let json: string;
  try {
    json = await new Response(body.pipeThrough(new DecompressionStream("gzip"))).text();
  } catch {
    return err("undecodable");
  }
  try {
    const parsed: unknown = JSON.parse(json);
    return isJson(parsed) ? ok(parsed) : err("undecodable");
  } catch {
    return err("undecodable");
  }
}

/**
 * The events with typed text replaced by asterisks of the same length, as
 * JavaScript counts a string's length, whatever the client masked (D-13):
 * - an Input event's (type 3, source 5) `text` (recordings-02);
 * - the `value` attribute of every `input` and `textarea` element node, by
 *   tag name in any case, in a full snapshot's node tree (type 2) and in a
 *   mutation's `adds` (recordings-32);
 * - every `value` in a mutation's `attributes` changes, since a change does
 *   not say which element it is on (recordings-32).
 * Anything that is not a string stays as it is. A new array; the input is
 * not changed.
 */
export function scrub(events: readonly RrwebEvent[]): RrwebEvent[] {
  return events.map(scrubEvent);
}

function scrubEvent(event: RrwebEvent): RrwebEvent {
  const data = event.data;
  if (!isJsonObject(data)) return event;

  if (event.type === TYPE.fullSnapshot) {
    const node = data.node;
    if (node === undefined) return event;
    return { ...event, data: { ...data, node: scrubNode(node) } };
  }
  if (event.type !== TYPE.incremental) return event;

  if (data.source === SOURCE.input) {
    if (typeof data.text !== "string") return event;
    return { ...event, data: { ...data, text: maskText(data.text) } };
  }
  if (data.source !== SOURCE.mutation) return event;

  const plain: JsonObject = { ...data };
  const changes = data.attributes;
  if (Array.isArray(changes)) plain.attributes = changes.map(scrubAttributeChange);
  const adds = data.adds;
  if (Array.isArray(adds)) plain.adds = adds.map(scrubAddedNode);
  return { ...event, data: plain };
}

/** A serialised node with the values of its input and textarea descendants masked. */
function scrubNode(node: Json): Json {
  if (!isJsonObject(node)) return node;

  const masked: JsonObject = { ...node };
  if (isTextField(node)) {
    const attributes = node.attributes;
    if (isJsonObject(attributes) && typeof attributes.value === "string") {
      masked.attributes = { ...attributes, value: maskText(attributes.value) };
    }
  }
  const children = node.childNodes;
  if (Array.isArray(children)) masked.childNodes = children.map(scrubNode);
  return masked;
}

/** Whether a serialised node is an input or a textarea, in any case. */
function isTextField(node: JsonObject): boolean {
  const tag = node.tagName;
  if (typeof tag !== "string") return false;
  const name = tag.toLowerCase();
  return name === "input" || name === "textarea";
}

/** An attribute change with any string `value` masked, whatever element it names. */
function scrubAttributeChange(change: Json): Json {
  if (!isJsonObject(change)) return change;
  const attributes = change.attributes;
  if (!isJsonObject(attributes) || typeof attributes.value !== "string") return change;
  return { ...change, attributes: { ...attributes, value: maskText(attributes.value) } };
}

/** An added node with the values of its input and textarea descendants masked. */
function scrubAddedNode(added: Json): Json {
  if (!isJsonObject(added)) return added;
  const node = added.node;
  if (node === undefined) return added;
  return { ...added, node: scrubNode(node) };
}

/** As many asterisks as the text has JavaScript characters. */
function maskText(text: string): string {
  return "*".repeat(text.length);
}

/** Whether a parsed value is JSON, which JSON.parse returns from a Json value's text. */
function isJson(value: unknown): value is Json {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJson);
  return isJsonObject(value) && Object.values(value).every(isJson);
}

/** A gap between two input events this long or shorter counts as active time (recordings-05). */
export const ACTIVE_GAP_MS = 5_000;

/** The rrweb sources that count toward active time (recordings-05). */
const ACTIVE_SOURCES: readonly number[] = [
  SOURCE.mouseMove,
  SOURCE.mouseInteraction,
  SOURCE.scroll,
  SOURCE.input,
  SOURCE.touchMove,
  SOURCE.mediaInteraction,
  SOURCE.drag,
];

export interface ChunkMeta {
  /** The chunk's earliest and latest rrweb `timestamp`, each minus the skew, in whole ms (recordings-28). */
  firstTs: number;
  lastTs: number;
  /**
   * When the chunk holds a full snapshot (type 2) with a Meta event (type 4)
   * before it: the Meta event's href as pageKey (enrich) reads it, its path
   * only, and its width as a whole number. The last such pair in the chunk
   * decides. Both null otherwise, or when the href is not an http(s) URL
   * (recordings-27, heatmaps-02).
   */
  snapshotPath: string | null;
  snapshotWidth: number | null;
  /** The href of the chunk's first Meta event, as sent, or null (recordings-05). */
  firstUrl: string | null;
  /**
   * rrweb mouse interactions (type 3, source 2) whose data.type is Click (2),
   * so the mouse down and up of one click are not counted (recordings-05).
   */
  clicks: number;
  /** rrweb Input events (type 3, source 5): one per input change (recordings-05). */
  keypresses: number;
  /**
   * Active time in ms: the input events (type 3, sources 1, 2, 3, 5, 6, 7 and
   * 12) in time order, summing each gap to the next one that is at most
   * ACTIVE_GAP_MS (recordings-05).
   */
  activeMs: number;
}

/**
 * A chunk's metadata. `skewMs` is clockSkew(sent_at, receivedAt) of the
 * event that carried the chunk, 0 without a sent_at (recordings-19,
 * recordings-28). A chunk with no events is "no events", and stores nothing.
 */
export function chunkMeta(
  events: readonly RrwebEvent[],
  skewMs: number,
): Result<ChunkMeta, "no events"> {
  if (events.length === 0) return err("no events");

  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  let firstUrl: string | null = null;
  let sawMeta = false;
  let clicks = 0;
  let keypresses = 0;
  let snapshotPath: string | null = null;
  let snapshotWidth: number | null = null;
  let pendingMeta: { href: string; width: number | null } | null = null;
  const activeTimes: number[] = [];

  for (const event of events) {
    earliest = Math.min(earliest, event.timestamp);
    latest = Math.max(latest, event.timestamp);

    const data = event.data;
    if (event.type === TYPE.meta) {
      const href = isJsonObject(data) && typeof data.href === "string" ? data.href : null;
      // firstUrl is the first Meta event's href, as sent, even if a later pair wins.
      if (!sawMeta) {
        sawMeta = true;
        firstUrl = href;
      }
      if (href !== null && isJsonObject(data)) {
        const width = data.width;
        pendingMeta = {
          href,
          width: wholeNumber(width),
        };
      }
      continue;
    }

    if (event.type === TYPE.fullSnapshot) {
      if (pendingMeta === null) continue;
      const page = pageKey(pendingMeta.href);
      snapshotPath = page?.path ?? null;
      snapshotWidth = page === null ? null : pendingMeta.width;
      continue;
    }

    if (event.type !== TYPE.incremental || !isJsonObject(data)) continue;
    if (typeof data.source !== "number") continue;
    if (data.source === SOURCE.mouseInteraction && data.type === MOUSE_CLICK) clicks += 1;
    if (data.source === SOURCE.input) keypresses += 1;
    if (ACTIVE_SOURCES.includes(data.source)) activeTimes.push(event.timestamp);
  }

  activeTimes.sort((left, right) => left - right);
  let activeMs = 0;
  let previous: number | null = null;
  for (const time of activeTimes) {
    if (previous !== null) {
      const gap = time - previous;
      if (gap <= ACTIVE_GAP_MS) activeMs += gap;
    }
    previous = time;
  }

  return ok({
    firstTs: Math.round(earliest - skewMs),
    lastTs: Math.round(latest - skewMs),
    snapshotPath,
    snapshotWidth,
    firstUrl,
    clicks,
    keypresses,
    activeMs,
  });
}

/** `<projectId>/<sessionId>/<receivedAt>-<uuid>.ndjson.gz`, such as `p_abc/<session>/1760000000000-<uuid>.ndjson.gz` (recordings-07). */
export function objectKey(
  projectId: string,
  sessionId: string,
  receivedAt: number,
  uuid: string,
): string {
  return `${projectId}/${sessionId}/${receivedAt}-${uuid}.ndjson.gz`;
}

/** Each event's JSON followed by a newline, in order (recordings-09). */
export function toNdjson(events: readonly RrwebEvent[]): string {
  let text = "";
  for (const event of events) text += `${JSON.stringify(event)}\n`;
  return text;
}

/** One page of the list: newest start first, after `before` when paging. */
export interface ListQuery {
  limit: number;
  /** The last row of the previous page; the page holds rows that sort after it. */
  before: { startTs: number; sessionId: string } | null;
  /** Only recordings matching every filter given (recordings-34). */
  filters: RecordingFilters;
}

/** The recording list's filters, each null when not asked for (recordings-34). */
export interface RecordingFilters {
  /** A distinct id: the person's recordings under any of their ids, or that id's alone without a person. */
  person: string | null;
  /** A page key: a session with an event on that page. */
  page: string | null;
  /** A session with an event of that name. */
  event: string | null;
  /** Recordings at least this long, end minus start, in milliseconds. */
  minDurationMs: number | null;
}

/** The URL's list parameters, each null when absent. */
export interface ListParams {
  limit: string | null;
  cursor: string | null;
  person: string | null;
  page: string | null;
  event: string | null;
  minDuration: string | null;
}

/** The longest text a filter takes: an event name, a distinct id or a page key. */
const FILTER_TEXT_MAX = 200;

/** A text filter: absent is null, and empty or longer than FILTER_TEXT_MAX is refused. */
function textFilter(value: string | null): Result<string | null, "bad filter"> {
  if (value === null) return ok(null);
  if (value === "" || value.length > FILTER_TEXT_MAX) return err("bad filter");
  return ok(value);
}

/**
 * The list query from the URL's parameters. `limit` is a whole number from 1
 * to RECORDINGS_LIST.max, by default RECORDINGS_LIST.default; anything else
 * is "bad limit". `cursor` is what cursorOf wrote; anything else is "bad
 * cursor". `person`, `page` and `event` are 1 to 200 characters, and
 * `minDuration` a whole number of milliseconds from 0; anything else is "bad
 * filter" (recordings-34).
 */
export function listQuery(
  params: ListParams,
): Result<ListQuery, "bad limit" | "bad cursor" | "bad filter"> {
  const parsedLimit = parseLimit(params.limit);
  if (parsedLimit === null) return err("bad limit");
  const person = textFilter(params.person);
  const page = textFilter(params.page);
  const event = textFilter(params.event);
  if (!person.ok || !page.ok || !event.ok) return err("bad filter");
  let minDurationMs: number | null = null;
  if (params.minDuration !== null) {
    if (!/^\d{1,15}$/.test(params.minDuration)) return err("bad filter");
    minDurationMs = Number(params.minDuration);
  }
  const filters = { person: person.value, page: page.value, event: event.value, minDurationMs };
  const cursor = params.cursor;
  if (cursor === null) return ok({ limit: parsedLimit, before: null, filters });

  // The session id holds hyphens and never an underscore, so the first one splits.
  const separator = cursor.indexOf("_");
  const startText = separator === -1 ? "" : cursor.slice(0, separator);
  const sessionId = separator === -1 ? "" : cursor.slice(separator + 1);
  if (!/^-?\d+$/.test(startText) || !isSessionId(sessionId)) return err("bad cursor");
  const startTs = Number(startText);
  if (!Number.isFinite(startTs)) return err("bad cursor");

  return ok({ limit: parsedLimit, before: { startTs, sessionId }, filters });
}

/** The page size of a `limit` value, or null when it is not one. */
function parseLimit(limit: string | null): number | null {
  if (limit === null) return RECORDINGS_LIST.default;
  if (!/^\d+$/.test(limit)) return null;
  const value = Number(limit);
  return value >= 1 && value <= RECORDINGS_LIST.max ? value : null;
}

/** The cursor after a row: `<startTs>_<sessionId>`. listQuery reads it back. */
export function cursorOf(row: Pick<RecordingSummary, "startTs" | "sessionId">): string {
  return `${row.startTs}_${row.sessionId}`;
}
