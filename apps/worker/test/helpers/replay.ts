import { env, runInDurableObject } from "cloudflare:test";
import { isJsonObject, type Json, type JsonObject } from "@cfanalytics/shared";
import type { ChunkMeta } from "../../src/features/recordings/index.ts";
import {
  ingestSnapshots,
  type SnapshotAnswer,
  type SnapshotChunk,
  type SnapshotError,
  type SnapshotRequest,
} from "../../src/platform/ingest.ts";
import type { Result } from "../../src/platform/result.ts";
import type { SchemaError } from "../../src/platform/schema.ts";
import {
  iosRequest,
  iso,
  type JsEncoding,
  jsonBytes,
  jsRequest,
  newUuid,
  storeOf,
  storeRows,
  T0,
  type TestEvent,
  type Transport,
} from "./capture.ts";

// What the test workers of recordings and heatmaps share: rrweb events as
// posthog-js's recorder makes them, with its `cv: "2024-10"` compression
// (posthog-protocol.md §7.5, §7.6); $snapshot events and /s/ requests as
// posthog-js and posthog-ios send them (§7.2, §7.3, §10.5); $$heatmap events
// (§8.1); snapshot requests handed straight to a ProjectStore; and the
// recordings, chunks, points and R2 objects read back. Capture requests,
// projects and Access come from ./capture.ts, ./registry.ts and ./access.ts.

// ------------------------------------------------------------- rrweb events

/** rrweb's event types (posthog-protocol.md §7.6). */
export const RRWEB = {
  fullSnapshot: 2,
  incremental: 3,
  meta: 4,
  custom: 5,
  plugin: 6,
} as const;

/** rrweb's incremental sources (§7.6). */
export const SOURCE = {
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

/** rrweb's mouse interaction types. Only Click (2) counts as a click (recordings-05). */
export const MOUSE = { mouseUp: 0, mouseDown: 1, click: 2, dblClick: 4 } as const;

/** rrweb's serialised node types. */
const NODE = { document: 0, documentType: 1, element: 2, text: 3 } as const;

/** A Meta event: the page's href and viewport size (recordings-27). */
export function metaEvent(
  href: string,
  width: number,
  height: number,
  timestamp: number,
): JsonObject {
  return { type: RRWEB.meta, data: { href, width, height }, timestamp };
}

/** One element node of a serialised page, as rrweb writes it. */
export interface PageElement {
  id: number;
  tagName: string;
  attributes?: Record<string, string>;
  children?: PageElement[];
  /** A text node child, written after the element children. */
  text?: string;
}

function elementNode(element: PageElement, textIds: { next: number }): JsonObject {
  const childNodes: Json[] = (element.children ?? []).map((child) => elementNode(child, textIds));
  if (element.text !== undefined) {
    childNodes.push({ type: NODE.text, textContent: element.text, id: textIds.next });
    textIds.next += 1;
  }
  return {
    type: NODE.element,
    tagName: element.tagName,
    attributes: { ...element.attributes },
    childNodes,
    id: element.id,
  };
}

/**
 * A FullSnapshot of a page whose body holds `body`, ids from 1 (document) to
 * 4 (body), so give body elements ids from 10. Text nodes get ids from 1000.
 */
export function fullSnapshotEvent(timestamp: number, body: PageElement[] = []): JsonObject {
  const textIds = { next: 1000 };
  const html = elementNode(
    {
      id: 2,
      tagName: "html",
      children: [
        { id: 3, tagName: "head" },
        { id: 4, tagName: "body", children: body },
      ],
    },
    textIds,
  );
  return {
    type: RRWEB.fullSnapshot,
    data: {
      node: {
        type: NODE.document,
        childNodes: [
          { type: NODE.documentType, name: "html", publicId: "", systemId: "", id: 5 },
          html,
        ],
        id: 1,
      },
      initialOffset: { left: 0, top: 0 },
    },
    timestamp,
  };
}

/** An Input event: typed text in the element `id` (recordings-02). */
export function inputEvent(id: number, text: string, timestamp: number): JsonObject {
  return {
    type: RRWEB.incremental,
    data: { source: SOURCE.input, id, text, isChecked: false },
    timestamp,
  };
}

/** A mouse interaction on element `id`; a Click by default (recordings-05). */
export function mouseEvent(
  id: number,
  timestamp: number,
  type: number = MOUSE.click,
  at: { x: number; y: number } = { x: 10, y: 20 },
): JsonObject {
  return {
    type: RRWEB.incremental,
    data: { source: SOURCE.mouseInteraction, type, id, x: at.x, y: at.y },
    timestamp,
  };
}

/** Any other incremental event, such as a scroll or a mouse move. */
export function incrementalEvent(
  source: number,
  timestamp: number,
  data: JsonObject = {},
): JsonObject {
  return { type: RRWEB.incremental, data: { source, ...data }, timestamp };
}

/** A Mutation event (recordings-32). Each list is written as given. */
export function mutationEvent(
  timestamp: number,
  changes: { texts?: Json[]; attributes?: Json[]; removes?: Json[]; adds?: Json[] },
): JsonObject {
  return {
    type: RRWEB.incremental,
    data: {
      source: SOURCE.mutation,
      texts: changes.texts ?? [],
      attributes: changes.attributes ?? [],
      removes: changes.removes ?? [],
      adds: changes.adds ?? [],
    },
    timestamp,
  };
}

/** A mutation that adds `element` under `parentId` (recordings-32). */
export function addedNode(parentId: number, element: PageElement): JsonObject {
  return { parentId, nextId: null, node: elementNode(element, { next: 2000 }) };
}

/** A StyleSheetRule event (recordings-25). */
export function styleSheetEvent(timestamp: number, adds: Json[], removes: Json[] = []): JsonObject {
  return {
    type: RRWEB.incremental,
    data: { source: SOURCE.styleSheetRule, id: 7, adds, removes },
    timestamp,
  };
}

/** A network plugin event, which intake drops (recordings-26). */
export function networkEvent(timestamp: number): JsonObject {
  return {
    type: RRWEB.plugin,
    data: {
      plugin: "rrweb/network@1",
      payload: { requests: [{ name: "https://api.example.com/x", method: "GET", status: 200 }] },
    },
    timestamp,
  };
}

/** A console plugin event, which is kept. */
export function consoleEvent(timestamp: number): JsonObject {
  return {
    type: RRWEB.plugin,
    data: { plugin: "rrweb/console@1", payload: { level: "log", payload: ["hello"] } },
    timestamp,
  };
}

/** A Custom event, as posthog-js adds `$session_options` and others (§7.6). */
export function customEvent(tag: string, timestamp: number, payload: JsonObject = {}): JsonObject {
  return { type: RRWEB.custom, data: { tag, payload }, timestamp };
}

// --------------------------------------------------- posthog-js's compression

/** Gzip bytes of a value's JSON written one byte per character (latin1), as posthog-js does (§7.5). */
async function latin1Gzip(value: Json): Promise<string> {
  const bytes = await gzipBytes(jsonBytes(value));
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/**
 * An event compressed as posthog-js's recorder sends it (`cv: "2024-10"`,
 * §7.5): a full snapshot's `data`, a mutation's `texts`, `attributes`,
 * `removes` and `adds`, and a stylesheet rule's `adds` and `removes` become
 * gzip latin1 strings. Any other event comes back unchanged.
 */
export async function compressed(event: JsonObject): Promise<JsonObject> {
  const data = event.data;
  if (event.type === RRWEB.fullSnapshot && data !== undefined) {
    return { ...event, data: await latin1Gzip(data), cv: "2024-10" };
  }
  if (event.type !== RRWEB.incremental || !isJsonObject(data)) return event;
  const fields =
    data.source === SOURCE.mutation
      ? ["texts", "attributes", "removes", "adds"]
      : data.source === SOURCE.styleSheetRule
        ? ["adds", "removes"]
        : [];
  if (fields.length === 0) return event;
  const packed: JsonObject = { ...data };
  for (const field of fields) {
    const value = data[field];
    if (value !== undefined) packed[field] = await latin1Gzip(value);
  }
  return { ...event, data: packed, cv: "2024-10" };
}

// --------------------------------------------------- $snapshot events and /s/

/** A UUIDv7-shaped session id, as posthog-js makes them (§7.9). */
export const newSessionId = (): string => newUuid();

export interface TestSnapshot {
  sessionId: string;
  /** The rrweb events of $snapshot_data, as sent. */
  data: Json[];
  distinctId?: string;
  /** Omitted: a fresh UUIDv7. null: no uuid key. */
  uuid?: string | null;
  /** Omitted: the real clock now. null: no sent_at key. */
  sentAt?: string | null;
  /** Omitted: the session id, as posthog-ios sets it. */
  windowId?: string;
  /** Added to the properties last. */
  properties?: JsonObject;
}

/**
 * A posthog-js $snapshot event (§7.2, §7.3): token and distinct_id in
 * `properties`, `$snapshot_bytes` the data's JSON size, no `$snapshot_source`,
 * and its own `sent_at`.
 */
export function jsSnapshot(token: string, snapshot: TestSnapshot): JsonObject {
  const out: JsonObject = {
    event: "$snapshot",
    properties: {
      token,
      distinct_id: snapshot.distinctId ?? "anon-1",
      $config_defaults: "unset",
      $snapshot_bytes: jsonBytes(snapshot.data).byteLength,
      $snapshot_data: snapshot.data,
      $session_id: snapshot.sessionId,
      $window_id: snapshot.windowId ?? snapshot.sessionId,
      $lib: "web",
      $lib_version: "1.438.12",
      $snapshot_host: "www.example.com",
      ...snapshot.properties,
    },
    timestamp: iso(Date.now()),
  };
  if (snapshot.uuid !== null) out.uuid = snapshot.uuid ?? newUuid();
  const sentAt = snapshot.sentAt === undefined ? iso(Date.now()) : snapshot.sentAt;
  if (sentAt !== null) out.sent_at = sentAt;
  return out;
}

/**
 * A posthog-ios $snapshot event (§10.5): `api_key` and `distinct_id` at the
 * event level, `$snapshot_source: "mobile"`, and no `sent_at`.
 */
export function iosSnapshot(token: string, snapshot: Omit<TestSnapshot, "sentAt">): JsonObject {
  const distinctId = snapshot.distinctId ?? "anon-1";
  const out: JsonObject = {
    api_key: token,
    event: "$snapshot",
    distinct_id: distinctId,
    properties: {
      distinct_id: distinctId,
      $snapshot_data: snapshot.data,
      $snapshot_source: "mobile",
      $session_id: snapshot.sessionId,
      $window_id: snapshot.windowId ?? snapshot.sessionId,
      $lib: "posthog-ios",
      $lib_version: "3.92.0",
      ...snapshot.properties,
    },
    timestamp: iso(Date.now()),
  };
  if (snapshot.uuid !== null) out.uuid = snapshot.uuid ?? newUuid();
  return out;
}

/**
 * posthog-js's /s/ request (§7.2): a bare array of $snapshot events, gzip as
 * text/plain by default, with Origin and a browser user agent. The transport
 * may change the path, such as "/s".
 */
export function snapshotRequest(
  events: JsonObject[],
  encoding: JsEncoding = "gzip",
  transport: Transport = {},
): Promise<Request> {
  return jsRequest(events, encoding, { path: "/s/", ...transport });
}

/** posthog-ios's /s/ request (§10.5): a bare array, gzip JSON with Content-Encoding, no Origin. */
export function iosSnapshotRequest(
  events: JsonObject[],
  transport: Transport = {},
): Promise<Request> {
  return iosRequest(events, { path: "/s/", ...transport });
}

// ------------------------------------------------------------ $$heatmap events

export interface TestPoint {
  x: number;
  y: number;
  type: "click" | "rageclick" | "deadclick" | "mousemove";
  /** Omitted: false. */
  fixed?: boolean;
}

/**
 * A posthog-js $$heatmap event for jsBatch or jsEvent (§8.1): `$heatmap_data`
 * maps each full URL to its points, with `$viewport_width` (omitted when
 * null), `$viewport_height`, `$current_url` (the first URL) and the session.
 * The points are written as posthog-js writes them, `target_fixed` included.
 */
export function heatmapEvent(options: {
  urls: Record<string, TestPoint[]>;
  viewportWidth?: number | null;
  distinctId?: string;
  sessionId?: string;
  uuid?: string | null;
  timestamp?: string | null;
  properties?: JsonObject;
}): TestEvent {
  const data: JsonObject = {};
  for (const [url, points] of Object.entries(options.urls)) {
    data[url] = points.map((point) => ({
      x: point.x,
      y: point.y,
      target_fixed: point.fixed ?? false,
      type: point.type,
    }));
  }
  const properties: JsonObject = {
    $heatmap_data: data,
    $viewport_height: 800,
    $current_url: Object.keys(options.urls)[0] ?? "https://www.example.com/",
    $session_id: options.sessionId ?? newSessionId(),
    ...options.properties,
  };
  const width = options.viewportWidth === undefined ? 1280 : options.viewportWidth;
  if (width !== null) properties.$viewport_width = width;
  const event: TestEvent = {
    event: "$$heatmap",
    distinctId: options.distinctId ?? "anon-1",
    properties,
  };
  if (options.uuid !== undefined) event.uuid = options.uuid;
  if (options.timestamp !== undefined) event.timestamp = options.timestamp;
  return event;
}

// ------------------------------------------- snapshots straight to a store

/** Gzip bytes, as CompressionStream makes them. */
export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(bytes).body?.pipeThrough(new CompressionStream("gzip"));
  if (stream === undefined) throw new Error("expected a body stream");
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Gunzipped bytes as UTF-8 text. */
export async function gunzipText(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const stream = new Response(bytes).body?.pipeThrough(new DecompressionStream("gzip"));
  if (stream === undefined) throw new Error("expected a body stream");
  return new Response(stream).text();
}

/** Each non-empty line of NDJSON text, parsed. */
export function ndjsonLines(text: string): JsonObject[] {
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (!isJsonObject(value)) throw new Error("expected a JSON object on every line");
      return value;
    });
}

/**
 * One chunk as the Worker would hand it over: `events` as gzip NDJSON, a
 * fresh uuid and session, distinct id "anon-1", and metadata from T0 to T0 +
 * 1 s with no snapshot and no input. Overrides win, `meta` field by field.
 */
export async function snapshotChunk(
  options: { events?: JsonObject[]; meta?: Partial<ChunkMeta> } & Partial<
    Omit<SnapshotChunk, "gzipped" | "meta">
  > = {},
): Promise<SnapshotChunk> {
  const events = options.events ?? [metaEvent("https://www.example.com/", 1280, 800, T0)];
  const text = events.map((event) => `${JSON.stringify(event)}\n`).join("");
  return {
    uuid: options.uuid ?? newUuid(),
    sessionId: options.sessionId ?? newSessionId(),
    distinctId: options.distinctId ?? "anon-1",
    gzipped: await gzipBytes(new TextEncoder().encode(text)),
    meta: {
      firstTs: T0,
      lastTs: T0 + 1000,
      snapshotPath: null,
      snapshotWidth: null,
      firstUrl: null,
      clicks: 0,
      keypresses: 0,
      activeMs: 0,
      ...options.meta,
    },
  };
}

/** A SnapshotRequest received at T0, with the default 500 MB cap and Europe/Oslo. Overrides win. */
export function snapshotRequestOf(
  projectId: string,
  chunks: SnapshotChunk[],
  overrides: Partial<Omit<SnapshotRequest, "projectId" | "chunks">> = {},
): SnapshotRequest {
  return {
    projectId,
    receivedAt: T0,
    settings: { daily_recording_bytes_cap: 500_000_000, timezone: "Europe/Oslo" },
    chunks,
    ...overrides,
  };
}

/** The chunks through the ProjectStore's RPC call, as the /s/ path sends them. */
export function snapshotsRpc(
  request: SnapshotRequest,
): Promise<Result<SnapshotAnswer, SchemaError | SnapshotError>> {
  return storeOf(request.projectId).ingestSnapshots(request);
}

/**
 * The chunks through ingestSnapshots inside the project's object, against the
 * real RECORDINGS bucket, with an in-flight set the test may hold. The schema
 * is applied first.
 */
export async function snapshotsDirect(
  request: SnapshotRequest,
  inFlight: Set<string> = new Set(),
): Promise<Result<SnapshotAnswer, SnapshotError>> {
  const stub = storeOf(request.projectId);
  await stub.ready();
  return runInDurableObject(stub, (_instance, state) =>
    ingestSnapshots(state.storage, env.RECORDINGS, request, inFlight),
  );
}

// ------------------------------------------------ reading what was stored

const num = (value: SqlStorageValue | undefined): number => {
  if (typeof value !== "number") throw new Error(`expected a number column, got ${typeof value}`);
  return value;
};
const text = (value: SqlStorageValue | undefined): string => {
  if (typeof value !== "string") throw new Error(`expected a text column, got ${typeof value}`);
  return value;
};
const textOrNull = (value: SqlStorageValue | undefined): string | null =>
  value === null ? null : text(value);
const numOrNull = (value: SqlStorageValue | undefined): number | null =>
  value === null ? null : num(value);

export interface StoredRecording {
  sessionId: string;
  distinctId: string | null;
  personId: number | null;
  startTs: number;
  endTs: number;
  activeMs: number;
  firstUrl: string | null;
  clicks: number;
  keypresses: number;
  bytes: number;
}

/** Every recording row, by session id. */
export async function storedRecordings(projectId: string): Promise<StoredRecording[]> {
  const rows = await storeRows(projectId, "SELECT * FROM recordings ORDER BY session_id");
  return rows.map((row) => ({
    sessionId: text(row.session_id),
    distinctId: textOrNull(row.distinct_id),
    personId: numOrNull(row.person_id),
    startTs: num(row.start_ts),
    endTs: num(row.end_ts),
    activeMs: num(row.active_ms),
    firstUrl: textOrNull(row.first_url),
    clicks: num(row.clicks),
    keypresses: num(row.keypresses),
    bytes: num(row.bytes),
  }));
}

export interface StoredChunk {
  uuid: string;
  sessionId: string;
  objectKey: string;
  firstTs: number;
  lastTs: number;
  receivedAt: number;
  bytes: number;
  snapshotPath: string | null;
  snapshotWidth: number | null;
}

/** Every chunk row, in play order across sessions: session, first_ts, received_at, uuid. */
export async function storedChunks(projectId: string): Promise<StoredChunk[]> {
  const rows = await storeRows(
    projectId,
    "SELECT * FROM recording_chunks ORDER BY session_id, first_ts, received_at, uuid",
  );
  return rows.map((row) => ({
    uuid: text(row.uuid),
    sessionId: text(row.session_id),
    objectKey: text(row.object_key),
    firstTs: num(row.first_ts),
    lastTs: num(row.last_ts),
    receivedAt: num(row.received_at),
    bytes: num(row.bytes),
    snapshotPath: textOrNull(row.snapshot_path),
    snapshotWidth: numOrNull(row.snapshot_width),
  }));
}

export interface StoredPoint {
  eventUuid: string;
  seq: number;
  host: string | null;
  path: string;
  widthBand: number;
  x: number;
  y: number;
  kind: string;
  fixed: boolean;
  bot: boolean;
  ts: number;
  sessionId: string | null;
  distinctId: string | null;
}

/** Every heatmap point, by event uuid and seq. */
export async function storedPoints(projectId: string): Promise<StoredPoint[]> {
  const rows = await storeRows(projectId, "SELECT * FROM heatmap_points ORDER BY event_uuid, seq");
  return rows.map((row) => ({
    eventUuid: text(row.event_uuid),
    seq: num(row.seq),
    host: textOrNull(row.host),
    path: text(row.path),
    widthBand: num(row.width_band),
    x: num(row.x),
    y: num(row.y),
    kind: text(row.kind),
    fixed: num(row.fixed) === 1,
    bot: num(row.bot) === 1,
    ts: num(row.ts),
    sessionId: textOrNull(row.session_id),
    distinctId: textOrNull(row.distinct_id),
  }));
}

/** Every R2 key under `prefix`, such as a project id with its final slash, paging through the listing. */
export async function r2Keys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.RECORDINGS.list(cursor === undefined ? { prefix } : { prefix, cursor });
    keys.push(...page.objects.map((object) => object.key));
    if (!page.truncated) return keys;
    cursor = page.cursor;
  }
}

/** An R2 object's raw bytes, or null when it does not exist. */
export async function r2Bytes(key: string): Promise<Uint8Array | null> {
  const object = await env.RECORDINGS.get(key);
  return object === null ? null : new Uint8Array(await object.arrayBuffer());
}

/** An R2 chunk object gunzipped and read as NDJSON, or null when it does not exist (recordings-09). */
export async function chunkEvents(key: string): Promise<JsonObject[] | null> {
  const bytes = await r2Bytes(key);
  return bytes === null ? null : ndjsonLines(await gunzipText(bytes));
}

/** `bucket` with `failingKeys` refusing to be deleted, as R2 does when it is unwell (privacy-13, privacy-19). */
export function refusingDeletes(bucket: R2Bucket, failingKeys: readonly string[]): R2Bucket {
  return new Proxy(bucket, {
    get(target, property) {
      if (property === "delete") {
        return (keys: string | string[]): Promise<void> => {
          const names = typeof keys === "string" ? [keys] : keys;
          if (names.some((key) => failingKeys.includes(key))) {
            return Promise.reject(new Error("the recordings bucket refused a delete"));
          }
          return target.delete(keys);
        };
      }
      const value: unknown = Reflect.get(target, property);
      if (typeof value === "function") {
        return (...args: unknown[]): unknown => value.apply(target, args);
      }
      return value;
    },
  });
}
