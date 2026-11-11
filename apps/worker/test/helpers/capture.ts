import {
  createExecutionContext,
  env,
  listDurableObjectIds,
  runInDurableObject,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { isJsonObject, type Json, type JsonObject } from "@cfanalytics/shared";
import { Hono } from "hono";
import {
  COOKIELESS_SENTINEL,
  type IncomingEvent,
  mountCapture,
} from "../../src/features/intake/index.ts";
import { realDeps } from "../../src/platform/deps.ts";
import type { AppEnv } from "../../src/platform/http.ts";
import {
  type IngestAnswer,
  type IngestError,
  type IngestRequest,
  type IngestSources,
  ingestBatch,
} from "../../src/platform/ingest.ts";
import type { ProjectStore } from "../../src/platform/project-store.ts";
import { projectStore } from "../../src/platform/project-store-id.ts";
import type { Result } from "../../src/platform/result.ts";
import type { SchemaError } from "../../src/platform/schema.ts";

// What the test workers of intake, cookieless, identity and events share:
// capture requests built as posthog-js, posthog-node, posthog-ios and
// a hand-built client send them (docs/spec/posthog-protocol.md §1.3, §2.2, §3.2, §9,
// §10.3), ways to send them, a batch handed straight to a ProjectStore, and a
// ProjectStore's rows read in place. Projects come from ./registry.ts and
// Access from ./access.ts. Random values here are test data: ids and bodies,
// never the code under test's own clock or random source.

// ---------------------------------------------------------------- SDK bodies

/** The host every built request goes to. Capture paths answer on any host. */
export const INTAKE = "https://intake.test";

/** A fixed moment for tests that pass time in: 2026-10-21 10:00:00 UTC, a Wednesday. */
export const T0 = Date.UTC(2026, 9, 21, 10, 0, 0);

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** A desktop Chrome user agent that no bot rule matches. */
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
export const NODE_UA = "posthog-node/5.56.2";
export const IOS_UA = "posthog-ios/3.92.0";
/** A documentation address (RFC 5737), so no real visitor's IP appears in a test. */
export const CLIENT_IP = "203.0.113.7";
export const ORIGIN = "https://www.example.com";

/** A UUIDv7 made from the real clock and random bytes, as the SDKs make them (§1.4). */
export function newUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let now = Date.now();
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = now % 256;
    now = Math.floor(now / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** An ISO-8601 time with milliseconds and Z, as every SDK writes `timestamp` and `sent_at` (§1.5). */
export const iso = (ms: number): string => new Date(ms).toISOString();

/** One event as a test describes it. Each SDK's builder puts the fields where that SDK does. */
export interface TestEvent {
  event: string;
  /** A number is sent as a number, as some server SDK callers do. */
  distinctId: string | number;
  /** Omitted: a fresh UUIDv7. null: no uuid key at all. */
  uuid?: string | null;
  /** Omitted: the real clock now, which is what the Worker under SELF reads too. null: no timestamp key. */
  timestamp?: string | null;
  properties?: JsonObject;
  /** posthog-js: top-level `$set`, as $identify sends it. node and iOS: `properties.$set`. */
  set?: JsonObject;
  /** Placed as `set` is. */
  setOnce?: JsonObject;
  /** posthog-js: top-level `$unset`. node and iOS: `properties.$unset`. */
  unset?: string[];
}

function common(event: TestEvent): JsonObject {
  const out: JsonObject = { event: event.event };
  if (event.uuid !== null) out.uuid = event.uuid ?? newUuid();
  if (event.timestamp !== null) out.timestamp = event.timestamp ?? iso(Date.now());
  return out;
}

function personOps(event: TestEvent, into: JsonObject): void {
  if (event.set !== undefined) into.$set = event.set;
  if (event.setOnce !== undefined) into.$set_once = event.setOnce;
  if (event.unset !== undefined) into.$unset = event.unset;
}

function wrapper(
  token: string,
  batch: JsonObject[],
  sentAt: string | null | undefined,
): JsonObject {
  const body: JsonObject = { api_key: token, batch };
  const sent = sentAt === undefined ? iso(Date.now()) : sentAt;
  if (sent !== null) body.sent_at = sent;
  return body;
}

/**
 * A posthog-js event (§3.2, §3.3): `distinct_id` and `token` inside
 * `properties`, `$lib: "web"`, person operations at the top level. A
 * property the test passes wins over these.
 */
export function jsEvent(token: string, event: TestEvent): JsonObject {
  const out = common(event);
  out.properties = {
    token,
    distinct_id: event.distinctId,
    $lib: "web",
    $lib_version: "1.438.12",
    ...event.properties,
  };
  personOps(event, out);
  return out;
}

/** A posthog-js batch body: {api_key, batch, sent_at} (§2.3). `sentAt` omitted is now; null leaves it out. */
export function jsBatch(
  token: string,
  events: readonly TestEvent[],
  options: { sentAt?: string | null } = {},
): JsonObject {
  return wrapper(
    token,
    events.map((event) => jsEvent(token, event)),
    options.sentAt,
  );
}

/**
 * A posthog-node event (§9.1): `distinct_id` at the top level, person
 * operations inside `properties`, `$lib: "posthog-node"` and
 * `$geoip_disable: true`.
 */
export function nodeEvent(event: TestEvent): JsonObject {
  const out = common(event);
  out.distinct_id = event.distinctId;
  const properties: JsonObject = {
    $lib: "posthog-node",
    $lib_version: "5.56.2",
    $is_server: true,
    $geoip_disable: true,
  };
  personOps(event, properties);
  out.properties = { ...properties, ...event.properties };
  return out;
}

/** A posthog-node batch body (§9.1), with `historical_migration: true` when asked (intake-18). */
export function nodeBatch(
  token: string,
  events: readonly TestEvent[],
  options: { sentAt?: string | null; historicalMigration?: boolean } = {},
): JsonObject {
  const body = wrapper(token, events.map(nodeEvent), options.sentAt);
  if (options.historicalMigration === true) body.historical_migration = true;
  return body;
}

/**
 * A posthog-ios event (§10.3): `distinct_id` at the top level, person
 * operations inside `properties`, `$lib: "posthog-ios"`, and no token in
 * `properties`.
 */
export function iosEvent(event: TestEvent): JsonObject {
  const out = common(event);
  out.distinct_id = event.distinctId;
  const properties: JsonObject = {
    $lib: "posthog-ios",
    $lib_version: "3.92.0",
    $os_name: "macOS",
    $device_type: "Desktop",
  };
  personOps(event, properties);
  out.properties = { ...properties, ...event.properties };
  return out;
}

/** A posthog-ios batch body (§10.3). */
export function iosBatch(
  token: string,
  events: readonly TestEvent[],
  options: { sentAt?: string | null } = {},
): JsonObject {
  return wrapper(token, events.map(iosEvent), options.sentAt);
}

/**
 * A hand-built client's single event (intake-16, its
 * `capturePayload`): {api_key, event, distinct_id, properties, timestamp},
 * with no uuid, no sent_at and no $lib, and `$process_person_profile: false`
 * unless the test's properties say otherwise. `uuid` is ignored.
 */
export function handBuiltEvent(token: string, event: TestEvent): JsonObject {
  const out: JsonObject = {
    api_key: token,
    event: event.event,
    distinct_id: event.distinctId,
    properties: { $process_person_profile: false, ...event.properties },
  };
  if (event.timestamp !== null) out.timestamp = event.timestamp ?? iso(Date.now());
  return out;
}

/**
 * The properties of a cookieless page event (posthog-protocol.md §5,
 * as a hand-built client sends it): `$cookieless_mode: true`, `$host`
 * and `$raw_user_agent`, and no `$session_id`. Use with distinct id
 * COOKIELESS_SENTINEL.
 */
export function cookielessProperties(
  host = "www.example.com",
  userAgent = BROWSER_UA,
  extra: JsonObject = {},
): JsonObject {
  return { $cookieless_mode: true, $host: host, $raw_user_agent: userAgent, ...extra };
}

export { COOKIELESS_SENTINEL };

// ----------------------------------------------------------- bytes on the wire

const encoder = new TextEncoder();

/** The UTF-8 bytes of a value's JSON text. */
export const jsonBytes = (value: Json): Uint8Array => encoder.encode(JSON.stringify(value));

/** Gzip bytes, as CompressionStream makes them in a browser and in workerd (§2.2). */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(bytes).body?.pipeThrough(new CompressionStream("gzip"));
  if (stream === undefined) throw new Error("expected a body stream");
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Standard base64 of bytes; URL-safe (- and _, no padding) when asked. */
export function base64(bytes: Uint8Array, urlSafe = false): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const standard = btoa(binary);
  return urlSafe ? standard.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") : standard;
}

/** The form body posthog-js sends with compression base64 (§2.2, §11 item 20): `data=` and the percent-encoded base64. */
export function base64Form(bytes: Uint8Array, urlSafe = false): string {
  return `data=${encodeURIComponent(base64(bytes, urlSafe))}`;
}

/** What a request carries besides its body. Every field has a default for its SDK. */
export interface Transport {
  path?: string;
  /** The Origin header; null sends none. */
  origin?: string | null;
  /** CF-Connecting-IP; null sends none. */
  ip?: string | null;
  /** User-Agent; null sends none. */
  userAgent?: string | null;
  /** Added to the query string. */
  query?: Record<string, string>;
  /** Added last, so they win over the SDK's own headers. */
  headers?: Record<string, string>;
  /** request.cf as Cloudflare would set it (enrich reads country, timezone and verifiedBotCategory). */
  cf?: { country?: string; timezone?: string; verifiedBotCategory?: string };
}

function buildRequest(
  defaults: { path: string; origin: string | null; userAgent: string | null },
  transport: Transport,
  body: BodyInit | null,
  headers: Record<string, string>,
  method = "POST",
): Request {
  const url = new URL(transport.path ?? defaults.path, INTAKE);
  for (const [key, value] of Object.entries(transport.query ?? {}))
    url.searchParams.set(key, value);
  const all: Record<string, string> = { ...headers };
  const origin = transport.origin === undefined ? defaults.origin : transport.origin;
  if (origin !== null) all.origin = origin;
  const ip = transport.ip === undefined ? CLIENT_IP : transport.ip;
  if (ip !== null) all["cf-connecting-ip"] = ip;
  const userAgent = transport.userAgent === undefined ? defaults.userAgent : transport.userAgent;
  if (userAgent !== null) all["user-agent"] = userAgent;
  Object.assign(all, transport.headers);
  const init: RequestInit = { method, headers: all, body };
  if (transport.cf !== undefined) init.cf = transport.cf;
  return new Request(url, init);
}

export type JsEncoding = "gzip" | "base64" | "base64-url-safe" | "json";

/**
 * A posthog-js request to `/e/` (§2.2): "gzip" is raw gzip bytes as
 * `text/plain` with no Content-Encoding; "base64" is the form body with
 * `?compression=base64`, "base64-url-safe" the same with URL-safe base64;
 * "json" is plain `application/json`. Origin, a browser user agent and
 * CF-Connecting-IP are set unless the transport says otherwise.
 */
export async function jsRequest(
  body: Json,
  encoding: JsEncoding = "gzip",
  transport: Transport = {},
): Promise<Request> {
  const defaults = { path: "/e/", origin: ORIGIN, userAgent: BROWSER_UA };
  const bytes = jsonBytes(body);
  if (encoding === "gzip") {
    return buildRequest(defaults, transport, await gzip(bytes), { "content-type": "text/plain" });
  }
  if (encoding === "json") {
    return buildRequest(defaults, transport, bytes, { "content-type": "application/json" });
  }
  const query = { compression: "base64", ...transport.query };
  return buildRequest(
    defaults,
    { ...transport, query },
    base64Form(bytes, encoding === "base64-url-safe"),
    { "content-type": "application/x-www-form-urlencoded" },
  );
}

/**
 * A posthog-node request to `/batch/` (§9.2): `application/json`, gzip with
 * `Content-Encoding: gzip` unless `gzip` is false, the node user agent, and
 * no Origin.
 */
export async function nodeRequest(
  body: Json,
  options: { gzip?: boolean } & Transport = {},
): Promise<Request> {
  const defaults = { path: "/batch/", origin: null, userAgent: NODE_UA };
  const bytes = jsonBytes(body);
  if (options.gzip === false) {
    return buildRequest(defaults, options, bytes, { "content-type": "application/json" });
  }
  return buildRequest(defaults, options, await gzip(bytes), {
    "content-type": "application/json",
    "content-encoding": "gzip",
  });
}

/**
 * A posthog-ios request to `/batch` (§10.3): `application/json;
 * charset=utf-8`, `Accept-Encoding: gzip`, gzip with `Content-Encoding: gzip`
 * unless `gzip` is false, the iOS user agent, and no Origin.
 */
export async function iosRequest(
  body: Json,
  options: { gzip?: boolean } & Transport = {},
): Promise<Request> {
  const defaults = { path: "/batch", origin: null, userAgent: IOS_UA };
  const headers = { "content-type": "application/json; charset=utf-8", "accept-encoding": "gzip" };
  const bytes = jsonBytes(body);
  if (options.gzip === false) return buildRequest(defaults, options, bytes, headers);
  return buildRequest(defaults, options, await gzip(bytes), {
    ...headers,
    "content-encoding": "gzip",
  });
}

/** A hand-built client's request (intake-16): one event as `application/json` to `/i/v0/e/`, from a browser. */
export function handBuiltRequest(body: Json, transport: Transport = {}): Request {
  const defaults = { path: "/i/v0/e/", origin: ORIGIN, userAgent: BROWSER_UA };
  return buildRequest(defaults, transport, jsonBytes(body), { "content-type": "application/json" });
}

/** Any bytes POSTed to a capture path with the given headers, for bodies no SDK sends (intake-24, intake-25). */
export function rawRequest(
  body: BodyInit | null,
  headers: Record<string, string>,
  transport: Transport = {},
  method = "POST",
): Request {
  const defaults = { path: "/e/", origin: ORIGIN, userAgent: BROWSER_UA };
  return buildRequest(defaults, transport, body, headers, method);
}

/** A browser's CORS preflight (§2.4): OPTIONS with Access-Control-Request-Method POST. */
export function preflightRequest(
  path: string,
  origin: string | null = ORIGIN,
  requestedHeaders: string | null = "content-type",
): Request {
  const headers: Record<string, string> = { "access-control-request-method": "POST" };
  if (origin !== null) headers.origin = origin;
  if (requestedHeaders !== null) headers["access-control-request-headers"] = requestedHeaders;
  return new Request(new URL(path, INTAKE), { method: "OPTIONS", headers });
}

// ------------------------------------------------------------------- sending

/** Sends a request to the Worker as Cloudflare would, through SELF, on the real clock. */
export function capture(request: Request): Promise<Response> {
  return SELF.fetch(request);
}

/** Anything with a Worker's fetch: the exported app, or a captureApp. */
export interface FetchesLikeAWorker {
  fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext): Response | Promise<Response>;
}

/**
 * Sends a request to `app` with `bindings`, waiting for its waitUntil work.
 * With the Worker's own default export and changed bindings, it shows how a
 * failing binding is answered (intake-24, intake-28).
 */
export async function fetchApp(
  app: FetchesLikeAWorker,
  request: Request,
  bindings: Cloudflare.Env = env,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await app.fetch(request, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/**
 * The capture routes alone, with the real dependencies except the clock,
 * which is `now`. For a test that moves time, such as the registry cache's
 * 60 seconds (events-08). Errors are thrown on to the test, so a fault
 * fails it with its own error.
 */
export function captureApp(now: () => number): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError((error) => {
    throw error;
  });
  app.use("*", async (c, next) => {
    c.set("deps", { ...realDeps(), now });
    await next();
  });
  mountCapture(app);
  return app;
}

/**
 * The routes `mounts` add, such as mountRecordings or mountConfig, with the
 * real dependencies except the clock, which is `now`. For a test that fixes
 * the receive time or a dashboard range. Errors are thrown on to the test,
 * as in captureApp.
 */
export function appAt(now: () => number, ...mounts: ((app: Hono<AppEnv>) => void)[]): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError((error) => {
    throw error;
  });
  app.use("*", async (c, next) => {
    c.set("deps", { ...realDeps(), now });
    await next();
  });
  for (const mount of mounts) mount(app);
  return app;
}

/** A capture answer's JSON body, or null when it is not JSON. */
export async function answerJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ----------------------------------------------- a batch straight to a store

/**
 * One IncomingEvent as intake would hand it over: an ordinary event of
 * `distinctId` at T0 with a fresh uuid, no person operations, a person
 * processed, no session, not cookieless, not a bot. Overrides win.
 */
export function incomingEvent(overrides: Partial<IncomingEvent> = {}): IncomingEvent {
  return {
    uuid: newUuid(),
    event: "$pageview",
    distinctId: "user-1",
    properties: {},
    set: {},
    setOnce: {},
    unset: [],
    ts: T0,
    processPerson: true,
    cookieless: false,
    sessionId: null,
    anonDistinctId: null,
    alias: null,
    hashUserAgent: null,
    hashHost: null,
    timezone: null,
    bot: false,
    page: null,
    ...overrides,
  };
}

/** A cookieless IncomingEvent: the sentinel, `$cookieless_mode`, the hash inputs, no session. Overrides win. */
export function cookielessIncoming(overrides: Partial<IncomingEvent> = {}): IncomingEvent {
  return incomingEvent({
    distinctId: COOKIELESS_SENTINEL,
    cookieless: true,
    properties: cookielessProperties(),
    hashHost: "www.example.com",
    hashUserAgent: BROWSER_UA,
    ...overrides,
  });
}

/** An IngestRequest received at T0 from CLIENT_IP, with the default cap, Europe/Oslo and no heatmap points. Overrides win. */
export function ingestRequest(
  projectId: string,
  events: IncomingEvent[],
  overrides: Partial<Omit<IngestRequest, "projectId" | "events">> = {},
): IngestRequest {
  return {
    projectId,
    receivedAt: T0,
    settings: { daily_event_cap: 40_000, timezone: "Europe/Oslo" },
    clientIp: CLIENT_IP,
    events,
    points: [],
    ...overrides,
  };
}

/**
 * Sources a test controls: `salts` handed out in order, then salts of bytes
 * 1, 2, 3 ...; session ids `sessions` in order, then "session-1", "session-2"
 * ...; and the database size, 0 by default.
 */
export function fixedSources(
  options: { salts?: Uint8Array[]; sessions?: string[]; databaseSize?: number } = {},
): IngestSources {
  const salts = [...(options.salts ?? [])];
  const sessions = [...(options.sessions ?? [])];
  let saltCount = 0;
  let sessionCount = 0;
  return {
    makeSalt: () => {
      saltCount += 1;
      return salts.shift() ?? new Uint8Array(16).fill(saltCount);
    },
    newSessionId: () => {
      sessionCount += 1;
      return sessions.shift() ?? `session-${sessionCount}`;
    },
    databaseSize: options.databaseSize ?? 0,
  };
}

/** A project's ProjectStore stub. */
export const storeOf = (projectId: string): DurableObjectStub<ProjectStore> =>
  projectStore(env, projectId);

/** The batch through the ProjectStore's RPC call, as intake sends it. */
export function ingestRpc(
  request: IngestRequest,
): Promise<Result<IngestAnswer, SchemaError | IngestError>> {
  return storeOf(request.projectId).ingest(request);
}

/**
 * The batch through ingestBatch inside the project's object, with `sources`
 * the test controls (salts, session ids, database size). The schema is
 * applied first.
 */
export async function ingestDirect(
  request: IngestRequest,
  sources: IngestSources = fixedSources(),
): Promise<Result<IngestAnswer, IngestError>> {
  const stub = storeOf(request.projectId);
  await stub.ready();
  return runInDurableObject(stub, (_instance, state) =>
    ingestBatch(state.storage, request, sources),
  );
}

/** Runs `work` on the project's SQL inside its object, after the schema is applied. For a slice's own store functions. */
export async function inStore<R>(
  projectId: string,
  work: (sql: SqlStorage, storage: DurableObjectStorage) => R,
): Promise<R> {
  const stub = storeOf(projectId);
  await stub.ready();
  return runInDurableObject(stub, (_instance, state) => work(state.storage.sql, state.storage));
}

// ------------------------------------------------------------ reading a store

/** Rows of any query, read inside the project's object. */
export function storeRows(
  projectId: string,
  query: string,
  ...bindings: SqlStorageValue[]
): Promise<Record<string, SqlStorageValue>[]> {
  return inStore(projectId, (sql) => sql.exec(query, ...bindings).toArray());
}

const asNumber = (value: SqlStorageValue | undefined): number => {
  if (typeof value !== "number") throw new Error(`expected a number column, got ${typeof value}`);
  return value;
};
const asText = (value: SqlStorageValue | undefined): string => {
  if (typeof value !== "string") throw new Error(`expected a text column, got ${typeof value}`);
  return value;
};
const asTextOrNull = (value: SqlStorageValue | undefined): string | null =>
  value === null ? null : asText(value);
const asNumberOrNull = (value: SqlStorageValue | undefined): number | null =>
  value === null ? null : asNumber(value);
const asObject = (value: SqlStorageValue | undefined): JsonObject => {
  const parsed: unknown = JSON.parse(asText(value));
  if (!isJsonObject(parsed)) throw new Error("expected a JSON object column");
  return parsed;
};

export interface StoredEvent {
  id: number;
  uuid: string;
  event: string;
  distinctId: string;
  personId: number | null;
  sessionId: string | null;
  ts: number;
  receivedAt: number;
  bot: boolean;
  page: string | null;
  properties: JsonObject;
  /** The properties column exactly as stored, for byte-level checks (intake-04, events-15). */
  propertiesText: string;
}

/** Every stored event, in storage order. */
export async function storedEvents(projectId: string): Promise<StoredEvent[]> {
  const rows = await storeRows(projectId, "SELECT * FROM events ORDER BY id");
  return rows.map((row) => ({
    id: asNumber(row.id),
    uuid: asText(row.uuid),
    event: asText(row.event),
    distinctId: asText(row.distinct_id),
    personId: asNumberOrNull(row.person_id),
    sessionId: asTextOrNull(row.session_id),
    ts: asNumber(row.ts),
    receivedAt: asNumber(row.received_at),
    bot: asNumber(row.bot) === 1,
    page: asTextOrNull(row.page),
    properties: asObject(row.properties),
    propertiesText: asText(row.properties),
  }));
}

export interface StoredPerson {
  id: number;
  createdAt: number;
  identified: boolean;
  properties: JsonObject;
  propertyTimes: JsonObject;
  /** Sorted. */
  distinctIds: string[];
}

/** Every person with its distinct ids, by id. */
export async function storedPersons(projectId: string): Promise<StoredPerson[]> {
  const persons = await storeRows(projectId, "SELECT * FROM persons ORDER BY id");
  const links = await storeRows(
    projectId,
    "SELECT distinct_id, person_id FROM person_distinct_ids ORDER BY distinct_id",
  );
  return persons.map((row) => {
    const id = asNumber(row.id);
    return {
      id,
      createdAt: asNumber(row.created_at),
      identified: asNumber(row.identified) === 1,
      properties: asObject(row.properties),
      propertyTimes: asObject(row.property_times),
      distinctIds: links
        .filter((link) => asNumber(link.person_id) === id)
        .map((link) => asText(link.distinct_id)),
    };
  });
}

/** The person a distinct id belongs to, or null. */
export async function personIdOf(projectId: string, distinctId: string): Promise<number | null> {
  const rows = await storeRows(
    projectId,
    "SELECT person_id FROM person_distinct_ids WHERE distinct_id = ?",
    distinctId,
  );
  return rows.length === 0 ? null : asNumber(rows[0]?.person_id);
}

/** A counter's value for a day (YYYY-MM-DD), or null when it has no row. */
export async function counterValue(
  projectId: string,
  day: string,
  name: "events" | "recording_bytes" = "events",
): Promise<number | null> {
  const rows = await storeRows(
    projectId,
    "SELECT value FROM counters WHERE day = ? AND name = ?",
    day,
    name,
  );
  return rows.length === 0 ? null : asNumber(rows[0]?.value);
}

/** Every counter row, by day then name. */
export async function storedCounters(
  projectId: string,
): Promise<{ day: string; name: string; value: number }[]> {
  const rows = await storeRows(projectId, "SELECT * FROM counters ORDER BY day, name");
  return rows.map((row) => ({
    day: asText(row.day),
    name: asText(row.name),
    value: asNumber(row.value),
  }));
}

/** Every salt row, by day. */
export async function storedSalts(
  projectId: string,
): Promise<{ day: string; salt: Uint8Array; expiresAt: number }[]> {
  const rows = await storeRows(projectId, "SELECT * FROM salts ORDER BY day");
  return rows.map((row) => {
    if (!(row.salt instanceof ArrayBuffer)) throw new Error("expected a BLOB salt");
    return {
      day: asText(row.day),
      salt: new Uint8Array(row.salt),
      expiresAt: asNumber(row.expires_at),
    };
  });
}

/** Every cookieless session row, by hash. */
export async function storedSessions(
  projectId: string,
): Promise<{ hash: string; day: string; sessionId: string; lastTs: number }[]> {
  const rows = await storeRows(projectId, "SELECT * FROM cookieless_sessions ORDER BY hash");
  return rows.map((row) => ({
    hash: asText(row.hash),
    day: asText(row.day),
    sessionId: asText(row.session_id),
    lastTs: asNumber(row.last_ts),
  }));
}

/**
 * Every row of every table in the store, store_meta included, as one text:
 * each table's name, then its rows as JSON, BLOBs as lower-case hex. For
 * checks that a value appears in no column at all, such as the client IP
 * (intake-07) or the cookieless sentinel (cookieless-01).
 */
export async function storeText(projectId: string): Promise<string> {
  return inStore(projectId, (sql) => {
    const tables = sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .toArray()
      .map((row) => asText(row.name))
      .filter((name) => !name.startsWith("sqlite_") && !name.startsWith("_cf_"));
    const parts: string[] = [];
    for (const table of tables) {
      // Table names come from sqlite_master, never from a test's input.
      const rows = sql.exec(`SELECT * FROM "${table}"`).toArray();
      const shown = rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            value instanceof ArrayBuffer
              ? [...new Uint8Array(value)]
                  .map((byte) => byte.toString(16).padStart(2, "0"))
                  .join("")
              : value,
          ]),
        ),
      );
      parts.push(`${table}\n${JSON.stringify(shown)}`);
    }
    return parts.join("\n");
  });
}

/**
 * Whether the project's ProjectStore was ever contacted in this test file:
 * an object the Worker never reached has no storage and is not listed
 * (intake-02, intake-24, intake-28). Reading the store makes it contacted,
 * so ask this first.
 */
export async function wasContacted(projectId: string): Promise<boolean> {
  const wanted = storeOf(projectId).id;
  const ids = await listDurableObjectIds(env.PROJECT_STORE);
  return ids.some((id) => id.equals(wanted));
}

/** The calendar day of `ms` in `timeZone`, YYYY-MM-DD, as a test computes it independently of the code under test. */
export function dayIn(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}
