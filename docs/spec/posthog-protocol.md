# PostHog SDK wire protocol

Pinned sources. Every claim below was read from these commits.

| Short name | Repository | Commit | Notes |
|---|---|---|---|
| JS | https://github.com/PostHog/posthog-js | `3deae6600373fb6a1b3e0023c28cb4fbf4c0ea27` (2026-10-19) | `JS:packages/browser` is posthog-js 1.438.12. `JS:packages/node` is posthog-node 5.56.2 and lives in this monorepo, so no separate node clone was needed. `JS:packages/core` is @posthog/core 1.59.1 and holds the shared node transport. |
| iOS | https://github.com/PostHog/posthog-ios | `ed6d2dd8b67ec9a53228a67d547b875a9d880f23` (2026-10-16) | posthog-ios 3.92.0 (`PostHog/PostHogVersion.swift:16`). |
| PH (secondary) | https://github.com/PostHog/posthog | `edc1585d12ee9b0f22d4d76225085a3e9322248b` (master when read) | PostHog's own Rust capture service. Used only to confirm what the server does with SDK output (clock skew, cookieless, decoding). The SDK sources are the primary evidence. |
| Docs | https://posthog.com/docs/api/capture , https://posthog.com/docs/api/flags | read 2026-10-19 | Confirmation only. |

Citation form: `JS:path:line` means a file in the posthog-js checkout. Paths are relative to the repo root.

Method note. The browser SDK in this version differs from older write-ups in several ways (no `compression=gzip-js` query parameter, no `/decide/` call, no `config=true` on the browser flags call). Old blog posts and old server code are therefore a poor guide. Section 13 lists what was not verified.

---

## 0. What a minimal compatible server must serve

| Path (both with and without trailing slash) | Method | Who calls it | Required |
|---|---|---|---|
| `/e/` | POST | browser, events (default) | yes |
| `/i/v0/e/` | POST | browser, only if remote config says so | optional alias |
| `/batch/` and `/batch` | POST | node (`/batch/`), iOS (`/batch`) | yes |
| `/s/` | POST | browser and iOS session replay | only for replay |
| `/flags/?v=2` and `/flags?v=2` | POST | browser (`/flags/`), iOS and node (`/flags`) | yes (may return empty flags) |
| `/array/<token>/config` | GET | browser, iOS | yes (this is where features are turned on) |
| `/array/<token>/config.js` | GET (script tag) | browser `array.js` and `posthog-js` module builds | optional, 404 falls back to the JSON one |
| `/static/<version>/<name>.js`, `/static/<name>.js?v=<version>` | GET (script tag) | browser lazy extensions | yes for replay, dead clicks, exceptions, web vitals, surveys (unless the customer uses a `.full` / `no-external` bundle) |
| `OPTIONS` on every POST path | OPTIONS | browser preflight | yes if any request uses `application/json` or custom headers |

Response that every ingest endpoint should return: HTTP **200** with body `{"status":1}` (PH `rust/capture/src/api.rs`, `CaptureResponseCode::Ok = 1`). The browser treats any other 2xx or 3xx as a failure and retries (section 2.5). Never return 201, 202 or 204 to the browser.

---

## 1. Shared facts

### 1.1 `api_host` handling in the browser

- `api_host` is trimmed and a trailing `/` removed (`JS:packages/browser/src/utils/request-router.ts:37-43`).
- If `api_host` is not one of PostHog's own cloud hosts, the router treats it as region `custom` (`:70-82`) and every endpoint is `api_host + path` (`:170-172`). That includes the asset path: `/array/<token>/config` and `/static/...` go to the same host as events (`:163-172`).
- `asset_host` overrides only paths starting with `/static/` (`:84-96`).
- `flags_api_host` overrides only flags (`:45-52`).
- `rewriteRequestPath` is an opt-in hook that lets a customer rewrite the URL (`:103-137`). Only the ingestion paths `/s/`, `/e/`, `/i/` are tracked as "ingestion endpoints" (`:22`).
- With a custom host, every event gets the property `$lib_custom_api_host = <api_host>` (`JS:packages/browser/src/posthog-core.ts:2229-2231`). It is harmless.

### 1.2 Library identifiers

| SDK | `$lib` | HTTP `User-Agent` |
|---|---|---|
| browser | `web` (`JS:packages/browser/src/config.ts:7`) | the browser's own |
| node | `posthog-node` (`JS:packages/node/src/entrypoints/index.node.ts:17-18`); `posthog-edge` on edge runtimes (`index.edge.ts:7-8`) | `posthog-node/<version>` (`JS:packages/node/src/client.ts:834`) |
| iOS/macOS | `posthog-ios` (`iOS:PostHog/PostHogVersion.swift:19-22`) | `posthog-ios/<version>` (`iOS:PostHog/PostHogApi.swift:86`) |

### 1.3 Token placement

| SDK | Events | Replay | Flags | Remote config |
|---|---|---|---|---|
| browser | `api_key` at the top of the batch wrapper (copied from the first event's `properties.token`) and `properties.token` on every event (`JS:packages/browser/src/request.ts:588-592`, `posthog-core.ts:2173`) | `properties.token` on each event only. There is no wrapper (section 7.2) | body field `token` (`JS:packages/browser-common/src/feature-flags.ts:1023`) | in the path |
| node | `api_key` in the wrapper (`JS:packages/core/src/posthog-core-stateless.ts:1594`) | n/a | body field `token` (`:807`) | n/a |
| iOS | `api_key` in the wrapper (`iOS:PostHog/PostHogApi.swift:186`) | `api_key` on each event (`:209-211`) | body field **`api_key`** (`:356`) | in the path |

The server must accept `token`, `api_key` and `properties.token` as the project key.

### 1.4 Event uuid

- Browser: UUIDv7 made on the client, `uuid` at event top level (`JS:packages/browser/src/posthog-core.ts:1846-1851`). After a custom `before_send`, the uuid is kept if valid, else a new one is made (`:2006`).
- Node: UUIDv7 in `prepareMessage` (`JS:packages/core/src/posthog-core-stateless.ts:1394`).
- iOS: UUIDv7, `uuid` at top level (`iOS:PostHog/Models/PostHogEvent.swift:39,99`).
- Use it as the dedupe key. Retries resend the same uuid.

### 1.5 Time fields and clock skew

What each SDK sends:

| Field | Browser | Node | iOS |
|---|---|---|---|
| event `timestamp` | ISO-8601 string with ms, `Z` (`JS:packages/browser/src/request.ts:577-585`) | ISO string; client may pass its own (`posthog-core-stateless.ts:1393,1375-1388`) | `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` (`iOS:PostHog/Utils/DateUtils.swift:15-16`) |
| `sent_at` in body | yes, on the batch wrapper (`request.ts:591`); on each item for replay and for `/flags` (`request.ts:506-515`) | yes, on the wrapper (`posthog-core-stateless.ts:1603`) | yes on `/batch` wrapper (`iOS:PostHogApi.swift:188`). **Not** on `/s/` snapshot bodies (`:213`). |
| `sent_at` / `_` in query | only for GET/POST calls that set `timestampMode: 'query'` (surveys, product tours, web experiments, early access). `sent_at=<Date.now()>` on POST, `_=<Date.now()>` on GET (`request.ts:569`) | no | no |
| `offset` | never sent by these SDKs | no | no |
| `$time` property | epoch seconds, float (`JS:packages/browser-common/src/utils/event-utils.ts:365`) | no | no |
| `$insert_id` | random string (`event-utils.ts:364`) | no | no |

Which field the server uses (PH `rust/common/types/src/timestamp.rs`, functions `parse_event_timestamp` and `handle_timestamp`):

1. If `timestamp` parses and `sent_at` is present: `skew = sent_at - server_now`; `event_time = timestamp - skew`.
2. Else if `timestamp` parses: use it as is.
3. Else: `server_now`.
4. A legacy `offset` (ms, in the event) overrides everything: `event_time = server_now - offset`. No current SDK sends it.
5. If the event property `$ignore_sent_at` is true, step 1 is skipped (PH `rust/capture/src/events/analytics.rs`, `process_single_event`).
6. If the result is more than 23 hours after server_now, it is clamped to server_now.
7. `sent_at` is read from the request body wrapper, else from the query (`sent_at`) (PH `rust/capture/src/payload/analytics.rs:93`).

So the answer to "which field does the server use": `timestamp` corrected by `(sent_at - now)`. Our server should do the same, otherwise events from clients with a wrong clock are placed at the wrong time. For recordings the browser puts `sent_at` on every event of the array (section 7.2).

When a customer passes a custom `timestamp` to `capture`, the browser also sets `$event_time_override_provided = true` and `$event_time_override_system_time` (`JS:packages/browser/src/posthog-core.ts:1953-1956`).

---

## 2. Browser transport

All of this is in `JS:packages/browser/src/request.ts`, `request-dispatch.ts`, `request-queue.ts`, `retry-queue.ts`, `rate-limiter.ts`.

### 2.1 Default transport and headers

- Default transport is `fetch` (`request.ts:636`). `api_transport: 'XHR'` switches to XHR (`request-dispatch.ts:55`, `request.ts:658-659`). `sendBeacon` is used on page unload (section 2.4).
- `Content-Type` is set by the body encoding (below). No other header is set unless the customer sets `request_headers` (`request-dispatch.ts:56-59`).
- `fetch` options: `referrerPolicy: 'strict-origin'` (`request.ts:427`), `keepalive` true for POSTs while the shared in-flight budget stays under 51,200 bytes (`:55-59, 433-447`), a 60 s abort timeout (`:634`). No `credentials` option, so cross-origin `fetch` sends no cookies.
- XHR sets the same headers and no `withCredentials` (`:278-323`).

### 2.2 Body encodings

The encoding depends on the `compression` value, which is resolved when the request is sent (`request-dispatch.ts:60-63`).

| Compression | Query string | Content-Type | Body |
|---|---|---|---|
| `gzip-js` (default until remote config says otherwise) | **none**. The code removes any `compression` param (`request.ts:571-574`) | `text/plain` (`:52,134-139`) | raw gzip bytes of the JSON (fflate `gzipSync`, `mtime: 0`), or native `CompressionStream` output. No `Content-Encoding` header. |
| `base64` | `?compression=base64` (`:573`) | `application/x-www-form-urlencoded` (`:54,141-150`) | `data=` + `encodeURIComponent(base64(utf8(JSON)))` |
| none | none | `application/json` (`:53,152-157`) | the JSON text |

Rules that matter:

- **Detect gzip by the two magic bytes `1f 8b`.** A browser gzip request has no `compression` param and no `Content-Encoding`. The Content-Type is `text/plain`, so a framework that decodes `text/plain` as UTF-8 text will corrupt the body. Read raw bytes.
- `lz64` does not exist in the current client code. The only hit for `lz64` in `packages/` is a test fixture (`JS:packages/browser/src/__tests__/extensions/test_data/sessionrecording-utils-test-data.ts`). The PostHog docs still list `lz64` in `supportedCompression` (https://posthog.com/docs/api/flags), but the SDK enum has only `gzip-js` and `base64` (`JS:packages/core/src/types.ts:362-365`). Supporting `lz64` is not needed.
- The form body for `base64` is a standard (not URL-safe) base64 of UTF-8, then percent-encoded. A server that url-decodes the form gets plain base64 back.
- If gzip fails on the device, the SDK falls back to uncompressed JSON, or to base64 for beacons (`request.ts:160-183`). So a server must accept all three on every ingest path.
- `compression` is decided by the last remote config: `supportedCompression` containing `"gzip-js"` gives gzip; else containing `"base64"` gives base64; else **none** (`posthog-core.ts:1361-1370`). Before the first remote config arrives, the default is gzip (`:907`). The literal string must be `gzip-js`. A value of `"gzip"` (as in the PostHog docs sample) does not match, and the SDK then sends uncompressed `application/json`, which forces a CORS preflight.
- `/flags` uses `compression: 'best-available'` with a fallback of `base64` (`JS:packages/browser/src/extensions/browser-client.ts:214-216`, `feature-flags-config.ts:25`). Without `supportedCompression` the flags call is `POST /flags/?v=2&compression=base64` with a form body.

### 2.3 Batching and flush

- Default `request_batching: true` (`posthog-core.ts:361`). The queue flushes every 3000 ms (`request-queue.ts:7`); `request_queue_config.flush_interval_ms` is clamped to 250-5000 (`:24-30`).
- A call to `capture()` is queued only when it passes no options or passes `_batchKey` (`posthog-core.ts:2058`). A capture with options but no `_batchKey` is sent at once as a one-event request. In practice that is `$identify`, which passes `$set` / `$set_once` as options (`:3385`). `$set`, `$create_alias`, `$groupidentify` pass no options and are batched. **Ordering across requests is therefore not guaranteed.** An `$identify` can arrive before earlier anonymous events. The code says so (`:1936-1938`).
- The queue groups items by `batchKey || url` plus `:batchGroup` (`request-queue.ts:103`). Items with the same key become one request whose `data` is an array of the items (`:107-111`). `$exception` events use `_batchKey: 'exceptionEvent'` (`posthog-exceptions.ts:190-194`), so exceptions travel in their own request to the same `/e/` URL. Replay uses `recordings` plus `:<session>-<window>` (section 7).
- Wrapper for events, whether batched or not: `{"api_key": <token>, "batch": [event, ...], "sent_at": "<ISO>"}` (`request.ts:577-593, 644-646`).
- Replay is not wrapped (section 7.2).
- On `pagehide`/`unload` the SDK captures `$pageleave` (if enabled) and flushes both queues through `sendBeacon` (`posthog-core.ts:1442-1468`, `request-queue.ts:42-56`). Events go before recordings.

### 2.4 `sendBeacon` and CORS

- A beacon needs a CORS-safelisted content type, so the SDK never beacons `application/json`: with no compression it forces `base64` (`request.ts:638-642`). With gzip it beacons a `text/plain` Blob (`:530`).
- If the browser refuses the beacon, the SDK halves the batch, or falls back to `fetch` with `keepalive` off (`:535-555`).
- Requests that need **no preflight**: gzip (`text/plain`), base64 (`x-www-form-urlencoded`), `GET /array/...`, and script tags. Requests that **do** need a preflight: uncompressed `application/json`, and anything when the customer sets `request_headers`.
- CORS config PostHog itself runs (PH `rust/capture/src/router.rs:228-232`): methods `GET, POST, OPTIONS`; allow headers = mirror the request; allow origin = mirror the request; allow credentials `true`. Do the same. Reason: `sendBeacon` sends credentials, and a wildcard `Access-Control-Allow-Origin: *` is rejected by browsers in that mode (this part is a web-platform rule, not read from the SDK). The beacon is still delivered, but the console shows an error.
- `<script>` loads (`config.js`, `/static/*.js`) set `crossOrigin = 'anonymous'` (`JS:packages/browser/src/entrypoints/external-scripts-loader.ts:64`), so they also need `Access-Control-Allow-Origin`.
- Add `Access-Control-Max-Age` on preflight answers (recommendation, not SDK behaviour).

### 2.5 Response handling and retry (events and replay)

- The response is parsed as JSON **only when status is exactly 200** (`request.ts:308-314, 466-472`).
- `Retry-After` is read (capped at 30 s) and used as a floor for the next delay (`request.ts:266-276`, `retry-queue.ts:124`).
- Retry rule (`JS:packages/browser/src/retry-queue.ts:94-106`): a request is retried when `status !== 200` **and** (`status < 400` **or** `status >= 500`). So these are retried: 0 (network, CORS, blocked, timeout), 201, 202, 204, 3xx, 5xx. These are **not** retried and the events are dropped: every 4xx, including 408, 413 and 429.
- Limits: 10 retries for HTTP statuses, 3 retries for status 0 (`:12-15, 95`).
- Backoff: `raw = 3000 * 2^n` ms, `capped = min(30 min, raw)`, `delay = ceil(capped + (rand - 0.5) * (capped - raw/2))`; the queue is polled every 3000 ms (`:27-34, 44`). First retry is 2.25-3.75 s.
- Each retry adds `?retry_count=<n>` to the URL (`:86-88`). The same body, same uuids.
- The retry queue is memory only. On unload it flushes through beacon (`:178-213`).
- Server-side quota signal: any response body that parses as JSON with `quota_limited: ["events"]` (or `"recordings"`, `"exceptionEvent"`, `"logs"`) pauses that batch key for 60 s (`rate-limiter.ts:135-162`). The key must equal the `batchKey`; events with no key use `"events"`.
- `on_request_error` default logs any status >= 400 (`request-dispatch.ts:78-80`).
- Client-side rate limit: 10 events/s with burst 100, persisted. Over the limit, events are dropped with a `$$client_ingestion_warning` event (`rate-limiter.ts:12-13, 109-133`).

---

## 3. Browser event capture

### 3.1 Request

- Default URL: `POST {api_host}/e/` (`JS:packages/browser/src/posthog-core.ts:736`, used at `:2024`).
- The remote config key `analytics.endpoint` replaces it (`:1372-1374`). The PostHog cloud value is `/i/v0/e/`, so a server that wants the newer path can answer `"analytics": {"endpoint": "/i/v0/e/"}`. If the key is absent the SDK stays on `/e/`.
- No query string except `compression=base64` and `retry_count` (section 2). In particular there is no `ip=`, `ver=` or `_=` on events in this version.
- `/batch/` and `/capture/` are not used by the browser SDK. The PH router also serves `/capture`, `/track`, `/engage` (PH `router.rs`); old SDKs and other clients use them.

### 3.2 Body

```json
{
  "api_key": "<token>",
  "batch": [
    {
      "uuid": "0192...",
      "event": "$pageview",
      "properties": { "token": "<token>", "distinct_id": "...", "...": "..." },
      "$set": { },
      "$set_once": { },
      "$unset": [ ],
      "timestamp": "2026-10-19T12:00:00.123Z"
    }
  ],
  "sent_at": "2026-10-19T12:00:03.001Z"
}
```

- Event keys: `uuid`, `event`, `properties`, `timestamp`, and optionally top-level `$set`, `$set_once`, `$unset` (`posthog-core.ts:1848-1956`). **`distinct_id` is inside `properties`**, not at event top level.
- Normal events have no per-event `sent_at`; only the wrapper has it.
- `$set` / `$set_once` can appear in two places. Top level comes from the `options` argument (used by `$identify`, section 4). `properties.$set` / `properties.$set_once` is used by the `$set` event. The SDK itself merges them with top level winning (`posthog-core.ts:1992-1996`, commented "taken from the plugin-server normalizeEvent"). The server must do the same merge.
- `$set_once` carries the `$initial_*` person properties (referrer, URL, campaign) on the first event of a person-processed user and on every `$identify` (`posthog-core.ts:1932-1947, 2349-2379`).

### 3.3 Properties the browser sets

Built in `calculateEventProperties` (`JS:packages/browser/src/posthog-core.ts:2150-2334`) from `getEventProperties` (`JS:packages/browser-common/src/utils/event-utils.ts:290-374`). Later entries override earlier ones: page/UA info, then persisted super properties, then session properties, then event properties (`:2299-2302`).

| Property | Value | Source |
|---|---|---|
| `token` | project token | `posthog-core.ts:2173` |
| `distinct_id` | persisted id | persistence |
| `$config_defaults` | the `defaults` init option | `:2174` |
| `$session_id`, `$window_id` | UUIDv7 strings, from the session manager | `:2201-2209` |
| `$lib`, `$lib_version` | `web`, SDK version | `event-utils.ts:362-363` |
| `$current_url` | full `location.href` (query masked if configured, hash kept unless `disable_capture_url_hashes`) | `:347-351` |
| `$host`, `$pathname` | `location.host`, `location.pathname` | `:352-353` |
| `$referrer`, `$referring_domain` | `document.referrer` or `$direct`; host of referrer | `event-utils.ts:197-215` (stored per session) |
| `$screen_width`, `$screen_height` | `window.screen` | `:358-359` |
| `$viewport_width`, `$viewport_height` | `window.innerWidth/innerHeight` | `:360-361` |
| `$browser`, `$browser_version`, `$os`, `$os_version`, `$device`, `$device_type`, `$webview_app`, `$webview_app_version` | **parsed on the client** from the user agent | `:302-343` |
| `$raw_user_agent` | UA string, cut to 1000 chars | `:354` |
| `$browser_language`, `$browser_language_prefix`, `$timezone`, `$timezone_offset` | from the browser | `:343-344, 356-357` |
| `$insert_id`, `$time` | random id, epoch seconds | `:364-365` |
| `$pageview_id` | uuid of the current `$pageview` event | `page-view.ts:92` |
| `$is_identified` | boolean | `posthog-core.ts:2304` |
| `$process_person_profile` | boolean, set last so nothing can override it | `:2325-2327` |
| `$device_id`, `$user_id`, `$groups`, `$active_feature_flags`, `$feature/<key>` | super properties from persistence | persistence |
| `utm_*`, `gclid` etc., `$search_engine`, `ph_keyword` | campaign and referrer parsing | `event-utils.ts:50-175` |
| `$sdk_debug_*`, `$recording_status` | replay diagnostics | `:2214-2227` |

Answer to "must the server parse the user agent": **no**. The browser sends parsed `$browser`, `$os`, `$device_type` and friends plus `$raw_user_agent`. Server-side UA parsing is only needed for bot filtering and, in cookieless mode, for the hash input (section 5). iOS and node send no browser fields.

`$pageview` adds `title` (`posthog-core.ts:2243-2245`) and the previous-page block of section 8.2.

### 3.4 Pageview and pageleave

- `capture_pageview` is `true` by default; with `defaults >= '2025-05-24'` it is `'history_change'` (`posthog-core.ts:297, 327`). `capture_pageleave: 'if_capture_pageview'`.
- First pageview fires 1 ms after load (`:1410-1419`). `$pageleave` is sent from `_handle_unload` (`:1461-1463`) and goes out by beacon.

---

## 4. Identity

All in `JS:packages/browser/src/posthog-core.ts`.

| Call | Event name | Wire shape |
|---|---|---|
| `identify(id, set, setOnce)` where the id changes and the user was anonymous | `$identify` | `properties.distinct_id = <new id>`, `properties.$anon_distinct_id = <old anonymous id>` (omitted when `reuseAnonymousId` is on), top-level `$set` (always present, possibly empty) and `$set_once` (present when non-empty; it includes the `$initial_*` properties). Sent immediately, not batched. (`:3363-3395`) |
| `identify(id, ...)` with the same id while anonymous | `$set` | `properties.$set`, `properties.$set_once` (`:3413`) |
| `identify(id, ...)` same id, already identified, new props | `$set` | same (`:3420-3424`, `:3507`) |
| `setPersonProperties` | `$set` | `properties.$set`, `properties.$set_once` (`:3507`) |
| `alias(alias, original)` | `$create_alias` | `properties.alias = <alias>`, `properties.distinct_id = <original>` (`:4236`) |
| `group(type, key, props)` | `$groupidentify` | `properties.$group_type`, `$group_key`, optional `$group_set` (`:3621-3628`). Also stores `$groups: {type: key}` as a super property sent on every later event. |
| `reset()` | none | clears persistence, makes a new anonymous `distinct_id` (UUIDv7) and `$device_id`, new session. Sends nothing by itself. Next events carry the new id. Flags are reloaded (`:3818-3956`). |
| `createPersonProfile()` | `$set` with empty props | `:4736-4746` |
| `unsetPersonProperties` | `$set` | `properties.$unset = [keys]` (`:3558`). Top-level `$unset` is also supported by `capture` options (`:1928-1931`) and should be accepted. |

Person profiles:

- Default `person_profiles` is `'identified_only'` (`:388`).
- `$process_person_profile` is **false** when the config is `'never'`, or when it is `'identified_only'` and the user is not identified, has no groups, no alias and never triggered person processing (`:4704-4713`). It becomes true after `identify`, `alias`, `group`, `setPersonProperties`, `createPersonProfile` (`:4781-4791`) and stays true.
- Server rule: when `$process_person_profile` is `false`, do not create or update a person for that event. When it is true, apply `$set`, `$set_once`, `$unset`, merge on `$identify` and `$create_alias`, and handle `$groupidentify`.
- Node sets `$process_person_profile: false` and a random uuid as distinct id when the caller gave no distinct id (`JS:packages/node/src/client.ts:3269-3272`).
- Server-side merge rules for `$identify` / `$create_alias` / `$groupidentify` are PostHog server behaviour and were not read from the SDK. The SDK only supplies the fields above.

---

## 5. Cookieless mode

`cookieless_mode: 'always' | 'on_reject'` (`JS:packages/types/src/posthog-config.ts:2439-2451`; the doc comment says the server must have cookieless enabled for the project).

What the browser does (`JS:packages/browser/src/posthog-core.ts`):

- `'always'`: no cookies, no storage (`_is_persistence_disabled`, `:4794-4796`), no session manager, so **no `$session_id` and no `$window_id`** (`:954-968`). Session replay cannot start (`session-recording.ts:114-116`). `opt_in_capturing` and `opt_out_capturing` are ignored (`:4866-4869, 4942-4945`).
- `'on_reject'`: normal mode until the user rejects consent. Then the SDK resets, switches to cookieless identity and drops the session manager (`:4955-4979`). After a later opt-in it resets again and returns to normal mode (`:4862-4900`).
- Distinct id is the fixed sentinel string **`$posthog_cookieless`** (`constants.ts:91`; set at `:1063-1070`, `:4963-4966`). `$device_id` is `null`.
- Every event carries **`$cookieless_mode: true`** (`constants.ts:92`, `posthog-core.ts:2176-2179`).
- `$snapshot` events are never sent in this mode (`:1790-1792`).
- `identify()` refuses the sentinel as an id (`:3242-3247`).
- Events still carry `$raw_user_agent`, `$host`, `$timezone`, and the usual page properties.

What the server must do. The SDK sends nothing else; the visitor identity is made on the server. PostHog's server does this (PH `rust/common/cookieless/src/hash.rs`, `constants.rs`; secondary source):

1. Treat `distinct_id == "$posthog_cookieless"` plus `$cookieless_mode == true` as "compute the id".
2. Input: a per-project daily salt, the project id, the request IP, the root domain from `$host`, the `$raw_user_agent`, a counter `n` (identify count), and optional `$cookieless_extra` (cut to 100 chars). Hash: SipHash-2-4 with the 16-byte salt as key, joined as `team-ip-domain-ua-n-extra` (`hash.rs:27-135`).
3. The salt day is the day in the event's `$timezone`; salts live about 24 h plus up to 72 h ingestion lag (`constants.rs`).
4. Session id: assigned by the server, with 30 minutes inactivity (`SESSION_INACTIVITY_MS`, `constants.rs`). Because the browser sends none.
5. Replace distinct id with `cookieless_<hash>`. Never store `$posthog_cookieless` as a real person; the SDK comment says all visitors would collapse to one person (`posthog-core.ts:644-647`).

A minimal server can do a simpler version of the same thing (hash of salt + IP + UA + host), but must keep the IP only long enough to hash it.

---

## 6. Remote config, flags, and what the SDK needs on load

### 6.1 Load sequence (browser)

`init` -> `_loaded()` (`posthog-core.ts:1391-1423`) -> `RemoteConfigLoader.load()` (`JS:packages/browser/src/remote-config.ts:35-67`):

1. If `window._POSTHOG_REMOTE_CONFIG[token].config` already exists (set by a token-specific `array.js`), use it. No request.
2. Else if flags are disabled (`advanced_disable_flags`), stop. No network config.
3. Else, if `__PosthogExtensions__.loadExternalDependency` exists (builds that lazy-load, which includes `array.js` and the default `posthog-js` module), load `GET {api_host}/array/<token>/config.js` as a script (`external-scripts-loader.ts:128-133`). The callback ignores script errors, so a 404 is harmless (`remote-config.ts:17-25`).
4. If step 3 gave no config, `GET {api_host}/array/<token>/config` through `fetch`, no body, no custom headers (`:27-33, 51-58`). Status 200 required for JSON parsing (`request.ts:466`).
5. `_onRemoteConfig` (`posthog-core.ts:1340-1389`) sets compression and the analytics endpoint, then passes the result to every extension.
6. Then flags: `ensureFlagsLoaded()` unless the config has `hasFeatureFlags: false` or `advanced_disable_feature_flags_on_first_load` is set (`remote-config.ts:96-102`).

There is **no `/decide/` call** in this version (no source hit; only the deprecated config name `advanced_disable_decide`). The browser never sends `config=true` to `/flags`. `/flags/?v=2&config=true` is used by `JS:packages/core` (react-native and similar), not by the browser (`JS:packages/core/src/posthog-core-stateless.ts:804`).

`config.js` format. The script must assign: `window._POSTHOG_REMOTE_CONFIG = window._POSTHOG_REMOTE_CONFIG || {}; window._POSTHOG_REMOTE_CONFIG["<token>"] = { config: {...}, siteApps: [] };` (type at `JS:packages/browser/src/utils/globals.ts:55-61`; test fixture `__tests__/remote-config.test.ts:143-145,196-199`). The `config` object is the same JSON as the `/array/<token>/config` response.

### 6.2 `/array/<token>/config` response

Type: `JS:packages/browser-common/src/types/remote-config.ts:136-211`. A server only needs the keys it wants to act on. Missing keys mean "no change from last known value, else off".

Minimum useful config for us:

```json
{
  "supportedCompression": ["gzip-js", "base64"],
  "hasFeatureFlags": false,
  "autocapture_opt_out": false,
  "elementsChainAsString": true,
  "analytics": { "endpoint": "/e/" },
  "heatmaps": false,
  "captureDeadClicks": false,
  "autocaptureExceptions": false,
  "capturePerformance": false,
  "surveys": false,
  "sessionRecording": false,
  "defaultIdentifiedOnly": true,
  "siteApps": []
}
```

What each key does and what happens without it:

| Goal | Key | Behaviour | Source |
|---|---|---|---|
| Work with no flags | `hasFeatureFlags: false` | SDK skips `/flags` completely | `remote-config.ts:96` |
| (a) alternative | omit it and answer `/flags` with an empty set | one `/flags` call per load and per identify/reset | section 6.3 |
| Compression | `supportedCompression: ["gzip-js"]` (add `"base64"`) | gzip for events. Without it: uncompressed JSON. | `posthog-core.ts:1361-1370` |
| Autocapture on | `autocapture_opt_out: false` | **Autocapture stays off until a config response carries this key.** On a failed fetch it uses the last stored value and defaults to off. Local `autocapture: false` also turns it off. | `autocapture.ts:565-592, 629-654` |
| Autocapture off | `autocapture_opt_out: true` | | same |
| Smaller autocapture events | `elementsChainAsString: true` | then `$elements` is not sent, only `$elements_chain`. Default sends both. | `autocapture.ts:287-292, 579-581` |
| Heatmaps on/off | `heatmaps: true/false` | local `capture_heatmaps` (then `enable_heatmaps`) wins over the server | `heatmaps.ts:103-111, 131-152` |
| Dead clicks on/off | `captureDeadClicks: true/false` | local `capture_dead_clicks` (boolean or object) wins | `extensions/dead-clicks-autocapture.ts:12-25, 42-59` |
| Exception autocapture on/off | `autocaptureExceptions: true/false` | local `capture_exceptions` wins | `extensions/exception-autocapture/index.ts:42-57, 133-157` |
| Suppression rules / extension errors | `errorTracking: {suppressionRules, captureExtensionExceptions}` | optional | `posthog-exceptions.ts:74-97` |
| Web vitals on/off | `capturePerformance: {web_vitals: true, web_vitals_allowed_metrics?: [...]}` | boolean `false` turns off. Local `capture_performance.web_vitals` wins. | `JS:packages/browser/src/extensions/web-vitals/index.ts:137-191` |
| Network timing in replay | `capturePerformance.network_timing` and `sessionRecording.networkPayloadCapture` | see 7.5 | `lazy-loaded-session-recorder.ts:813-832` |
| Surveys on/off | `surveys: true/false/[...]` | `true` makes the SDK `GET /api/surveys/?token=...` (`posthog-surveys.ts:364`). `false` or missing: no surveys. Local `disable_surveys` also turns off. | `posthog-surveys.ts:137-162` |
| Person profiles default | `defaultIdentifiedOnly` | present in the type; the browser applies its own `person_profiles` default (`posthog-core.ts:1379-1383`) | |
| Product tours, conversations, logs, site apps, toolbar | `productTours`, `conversations`, `logs`, `siteApps`, `toolbarParams` | leave out; features stay off. `opt_in_site_apps` defaults to false. | |
| Recording | `sessionRecording` | see section 7 | |

If `/array/<token>/config` returns 404 or a non-200 (`remote-config.ts:69-78, 89-94`):

- `ok:false` is passed to every extension. Pageviews and `$pageleave` still work (local config).
- Compression becomes "none" (`posthog-core.ts:1361`), so events go as `application/json` and need CORS preflight.
- Autocapture stays **off** with no stored value. Heatmaps, dead clicks, exceptions, web vitals, surveys and replay stay off or keep their last stored value. Replay logs "config refresh failed, recording will not start until page reload" (`session-recording.ts:324-333`).
- Flags still load: `hasFeatureFlags` is not `false`, so `/flags` is called.
- No retry of the config request.

Which options are local and which come from the server (summary):

- Local init always wins for: `capture_heatmaps`/`enable_heatmaps`, `capture_dead_clicks`, `capture_exceptions`, `capture_performance`, `disable_surveys`, `autocapture`, `disable_session_recording`, `session_recording.*` masking and sample rate, `enable_recording_console_log`, `person_profiles`, `capture_pageview`, `capture_pageleave`.
- Server-only: `sessionRecording.minimumDurationMilliseconds`, `linkedFlag`, `urlTriggers`, `eventTriggers`, `triggerGroups`, `endpoint`, `scriptConfig.script`, `supportedCompression`, `analytics.endpoint`, `elementsChainAsString`, `errorTracking.suppressionRules`.
- Server config is cached in persistence. Replay config is stale after 1 hour (`constants.ts:30`) and the recorder refetches (`session-recording.ts:360-415`).

### 6.3 `/flags` request and response (browser)

Request: `POST {flags_api_host or api_host}/flags/?v=2` (`JS:packages/browser-common/src/feature-flags.ts:1052`); `&only_evaluate_survey_feature_flags=true` only with that option. Body, optionally gzipped or base64 as in 2.2, with `sent_at` added to the body (`sentAt: 'body'`, `:1170`; `request.ts:506-515`):

```json
{
  "token": "<token>",
  "distinct_id": "...",
  "groups": {},
  "$anon_distinct_id": "...",
  "$device_id": "...",
  "person_properties": { "$lib": "web", "$lib_version": "1.438.12" },
  "group_properties": {},
  "timezone": "Europe/Oslo",
  "disable_flags": true,
  "evaluation_contexts": ["..."],
  "flag_keys": ["..."],
  "sent_at": "<ISO>"
}
```

(`feature-flags.ts:1022-1050`. `disable_flags`, `evaluation_contexts`, `flag_keys` appear only when set.)

Timeout 3000 ms (`posthog-core.ts:375`). Retry: once, 500 ms later, only for 502, 504 and for client timeouts (`feature-flags.ts:73-83, 1144-1184`; `feature_flag_request_max_retries: 1`). After 3 consecutive status-0 failures the SDK stops asking until connectivity changes (`:63`).

The SDK reloads flags on identify, reset, group changes and `setPersonPropertiesForFlags` (debounced 5 ms, `:916-951`).

Response the browser needs:

```json
{ "featureFlags": {}, "featureFlagPayloads": {}, "flags": {}, "errorsWhileComputingFlags": false }
```

- Anything with status 200 works. If neither `flags` nor `featureFlags` is present, nothing is updated and the reload is marked "error" (`feature-flags.ts:158-160, 1111-1118`).
- A `flags` map (v2) wins: the SDK builds `featureFlags` and payloads from `flags[k].variant ?? flags[k].enabled` and `flags[k].metadata.payload` (`:250-267`). Full v2 entry per the docs: `{key, enabled, variant, reason, metadata:{id,version,payload}}` (https://posthog.com/docs/api/flags).
- Optional: `quotaLimited: ["feature_flags"]` (SDK stops using the response and warns, `:1098-1106`), `requestId`, `evaluatedAt`, `minimalFlagCalledEvents`.
- A 404 or 5xx is not fatal. The SDK records an error and keeps whatever flags it has cached. Nothing else breaks.

---

## 7. Session recording

### 7.1 When it starts

`JS:packages/browser/src/extensions/replay/session-recording.ts`:

1. Remote config must contain `sessionRecording` as an **object**. `false` discards and stops (`:335-339`). A missing key means "no fresh config" and replay waits (`:324-333`). Recording is enabled when the persisted config has `enabled` (true for any object) and local `disable_session_recording` is not true and the user is not opted out (`:139-144`).
2. The recorder script is lazy-loaded from `/static/<version>/<name>.js` (then `/static/<name>.js?v=<version>`), `name` = `sessionRecording.scriptConfig.script` or `lazy-recorder` (`:353-358`; `external-scripts-loader.ts:135-169`). It is skipped if the page already has `rrweb.record` and `initSessionRecording`, which is the case for `array.full*` and `posthog-js/dist/posthog-recorder` builds (`:190-197`). A blocked or missing script only sets `$sdk_debug_recording_script_not_loaded` and logs (`:213-221`).
3. Not available in `cookieless_mode: 'always'` (constructor throws, `:114-116`).

### 7.2 Request

- Path: `POST {api_host}{sessionRecording.endpoint || "/s/"}` (`JS:packages/browser/src/extensions/replay/external/lazy-loaded-session-recorder.ts:100, 1238-1240, 2543`). The server may set `endpoint` (e.g. `"/s/"`).
- Each flush calls `capture('$snapshot', props, {_url, _noTruncate: true, _batchKey: 'recordings', skip_client_rate_limiting: true})` (`:2540-2548`). Same encodings as events (2.2).
- Body is a **bare JSON array** of `$snapshot` events, each with its own `sent_at` and no `api_key` wrapper (`request.ts:506-515, 647-649`; `posthog-core.ts:2032`). The token is in each event's `properties.token`.
- Chunks from the same `session-window` are merged into one request by the request queue (3 s cadence, `posthog-core.ts:2034-2040`, `request-queue.ts:103-111`).

### 7.3 `$snapshot` event

```json
{
  "uuid": "...",
  "event": "$snapshot",
  "properties": {
    "token": "<token>",
    "distinct_id": "...",
    "$config_defaults": "unset",
    "$snapshot_bytes": 123456,
    "$snapshot_data": [ { "type": 4, "data": {}, "timestamp": 1760000000000 } ],
    "$session_id": "...",
    "$window_id": "...",
    "$lib": "web",
    "$lib_version": "1.438.12",
    "$snapshot_host": "example.com"
  },
  "timestamp": "<ISO>",
  "sent_at": "<ISO>"
}
```

- `$snapshot_data` is an array of rrweb events. `$snapshot_bytes` is the estimated JSON size of the array (`lazy-loaded-session-recorder.ts:2383-2406`).
- For `$snapshot`, the SDK skips the usual page, UA and persistence properties. It sets only `token`, `$config_defaults`, `distinct_id`, plus what the recorder passes (`posthog-core.ts:2181-2192`). `$snapshot_source` **is not set** by this version (no hit in `JS:packages/browser/src`). Older web versions and mobile SDKs use it; treat it as optional.
- Optional diagnostics: `$sdk_debug_replay_throttled_mutations_dropped` and similar (`:2391-2405`).

### 7.4 Batching, flush, size

- The recorder keeps a buffer. A flush timer of 2000 ms starts on the first event added (`RECORDING_BUFFER_TIMEOUT`, `:136, 2199-2205`). The buffer is also flushed when adding an event would pass about 0.9 MiB (`RECORDING_MAX_EVENT_SIZE = 1024*1024*0.9`, `:135, 2491-2514`).
- On flush the buffer is split by halving while it is at least 6.3 MiB (`7 MiB * 0.9`) and has more than one event (`sessionrecording-utils.ts:185-213`). A single event is never split, so one very large full snapshot can make a request larger than 1 MiB. PostHog's own limit for `/s/` is 25 MiB (PH `router.rs:41`). Accept at least that.
- Flush is held when the status is buffering, paused, disabled or below minimum duration (`:2360-2371`), and when the session started or rotated with no user interaction (`:2325-2328`). Then the buffer waits; on page unload it is parked in `sessionStorage` for the next page in the tab (`:2277-2288`).
- A buffer that would open a recording with only custom (marker) events is held back (`:2213-2221`).
- Request level retry and backoff: same as events (2.5). `quota_limited: ["recordings"]` pauses recordings for 60 s.

### 7.5 Compression inside the payload

Besides the request-level gzip, the recorder compresses the heavy rrweb events itself (`cv: '2024-10'`):

- Applies to `FullSnapshot` (type 2), and `IncrementalSnapshot` (type 3) with source `Mutation` (0) or `StyleSheetRule` (8) (`:316-323`). Other events stay plain JSON. Controlled by `session_recording.compress_events` (default true, `:2075`).
- Full snapshot: `data` becomes a string. Mutation: `texts`, `attributes`, `removes`, `adds` each become a string. Stylesheet: `adds`, `removes` become strings. The event gets `cv: "2024-10"` (`:209-247, 345-440`).
- Each string is `strFromU8(gzip(JSON.stringify(value)), true)`: the gzip bytes as a **latin1 string** (one JS char per byte), so after JSON encoding bytes `0x80-0xFF` are two-byte UTF-8 (`:249-251`). The source comment in `sessionrecording-utils.ts:50-53` says "base64"; the code is latin1.
- A server that only stores replay does not have to decode this. A player (PostHog's replay player, or our own) must gunzip those fields when `cv` is set.

### 7.6 rrweb version, plugins, event types

- rrweb is PostHog's fork `@posthog/rrweb` 0.1.8, with `@posthog/rrweb-record` 0.0.88, `@posthog/rrweb-snapshot` 0.0.68, `@posthog/rrweb-types` 0.0.62, and `@posthog/rrweb-plugin-console-record` 1.0.8 (`JS:packages/rrweb/*/package.json`, `JS:packages/rrweb/README.md`: "please don't use it yourself").
- Event `type` enum (`JS:packages/rrweb/types/src/index.ts:1-9`): 0 DomContentLoaded, 1 Load, 2 FullSnapshot, 3 IncrementalSnapshot, 4 Meta, 5 Custom, 6 Plugin. Incremental `source` enum (`:76-94`): 0 Mutation, 1 MouseMove, 2 MouseInteraction, 3 Scroll, 4 ViewportResize, 5 Input, 6 TouchMove, 7 MediaInteraction, 8 StyleSheetRule, 9 CanvasMutation, 10 Font, 11 Log, 12 Drag, 13 StyleDeclaration, 14 Selection, 15 AdoptedStyleSheet, 16 CustomElement.
- Full snapshot cadence: every `full_snapshot_interval_millis`, default 5 minutes (`:1006-1018`). One is also taken at start, and after session rotation, or when an incremental event would ship for a session that has none (`:1773-1798`). There is no `checkoutEveryNms`.
- Custom events the SDK adds: `$remote_config_received`, `$session_options`, `$posthog_config`, `$url_changed`, `$session_idle`, `$session_ending`, `$session_starting`, JSON-LD (`:3047-3054, 973`).
- Plugins (`:834-869`):
  - Console: `rrweb/console@1`, type 6, only when `enable_recording_console_log` (local) or `sessionRecording.consoleLogRecordingEnabled` (server) is true. Strings are cut to 2000 chars and 10 per log (`sessionrecording-utils.ts:149-183`).
  - Network: `rrweb/network@1`, type 6 (`network-plugin.ts:1205`). Added only if some part is on: `recordHeaders` or `recordBody` (local `session_recording.recordHeaders/recordBody` OR server `networkPayloadCapture`), or network timing (`capture_performance.network_timing` local, else server `capturePerformance`). Not added on localhost. Requests to `/s/`, `/e/`, `/i/` paths are ignored (`:158-183`).
  - **To turn network capture off from the server:** omit `networkPayloadCapture` or set `{"recordHeaders":false,"recordBody":false}`, and set `capturePerformance` to `false` (or without `network_timing`). Also leave the console flag false if wanted.

### 7.7 Masking

Masking happens in the browser, before anything is sent.

- Defaults (`:2806-2835`): `maskAllInputs: true`, `maskInputOptions: {password: true}`, block class `ph-no-capture`, mask-text class `ph-mask`, ignore class `ph-ignore-input`, `inlineStylesheet: true`, `recordCrossOriginIframes: false`, `collectFonts: false`, `recordAfter: 'DOMContentLoaded'` (`:3000`).
- Server masking keys: `sessionRecording.masking: {maskAllInputs, maskTextSelector, blockSelector, maskAllElementAttributes}`. A local value in `posthog.init({session_recording})` wins field by field (`:679-710`). The SDK warns when both differ (`:718-761`).
- Canvas: `recordCanvas`, `canvasFps` (max 12), `canvasQuality` from the server or `session_recording.captureCanvas` (`:777-803`).

### 7.8 Sampling and minimum duration

- `sessionRecording.sampleRate`: a decimal between 0 and 1, sent as a string such as `"0.5"` or as a number. Local `session_recording.sampleRate` wins (`session-recording.ts:247-257, 267-275`). Decision is per session, deterministic on session id (`recording-strategies.ts:257-293`).
- `sessionRecording.minimumDurationMilliseconds`: number; the recorder holds the buffer until the session is long enough (`recording-strategies.ts:218-226`; `lazy-loaded-session-recorder.ts:2447-2478`). Server only. With `strictMinimumDuration` (default for `defaults >= '2025-11-30'`) the buffer duration is used.
- Triggers: `linkedFlag`, `urlTriggers`, `urlBlocklist`, `eventTriggers`, `triggerMatchType`, `version: 2` with `triggerGroups`. Leave all out for "always record".

Minimal config that turns replay on with our endpoint, no sampling, no network capture:

```json
"sessionRecording": {
  "endpoint": "/s/",
  "sampleRate": null,
  "minimumDurationMilliseconds": 0,
  "consoleLogRecordingEnabled": false,
  "networkPayloadCapture": { "recordHeaders": false, "recordBody": false },
  "masking": { "maskAllInputs": true },
  "recordCanvas": false
},
"capturePerformance": false
```

### 7.9 Session id rules

`JS:packages/browser/src/sessionid.ts`. Generated on the client (UUIDv7); `$window_id` also UUIDv7, per tab.

- New session when there is none, when `now - lastActivity > session_idle_timeout_seconds` (default 1800 s, clamped to 60-36000 s, `:17-20, 98-106, 381-386, 446-448`), or when `|now - sessionStart| > 24 h` (`:20, 439-440`).
- Activity extends the session only for non-read-only checks, i.e. for user-driven events (`:509-512`).
- Separate replay idle threshold: 5 minutes (`RECORDING_IDLE_THRESHOLD_MS`, `lazy-loaded-session-recorder.ts:134, 615-617`). While idle the recorder drops most events and takes a fresh full snapshot on wake.
- `reset()` also starts a new session.

---

## 8. Heatmaps, scroll depth, clicks

### 8.1 Heatmaps

`JS:packages/browser/src/heatmaps.ts`.

- Enable: `heatmaps: true` in remote config, or local `capture_heatmaps` (truthy object or true) / `enable_heatmaps` (`:103-111, 131-152`).
- Event: name **`$$heatmap`**, one property `$heatmap_data`, sent through normal capture (so `/e/`, batched) (`:317-319`).
- `$heatmap_data` shape: `{ "<full URL>": [ { "x": number, "y": number, "target_fixed": boolean, "type": "click" | "rageclick" | "deadclick" | "mousemove" } ] }` (`:235-252, 286-310`).
- URL key: `window.location.href`, hash stripped if `disable_capture_url_hashes`, personal-data query parameters masked to `<masked>` if `mask_personal_data_properties` (`:291-301`).
- Coordinates: `x = clientX + scrollX`, `y = clientY + scrollY` (page coordinates), but **viewport coordinates** (no scroll added) when the target or an ancestor has `position: fixed` or `sticky` (`target_fixed: true`) (`:240-251`). No scaling is done on the client. The event also carries `$viewport_width` and `$viewport_height` (normal event properties) so the server can scale; PostHog's server keeps exactly these for its heatmap extraction: `$heatmap_data, $viewport_height, $viewport_width, $session_id, $prev_pageview_pathname, $prev_pageview_max_scroll, $current_url` (PH `rust/capture/src/events/analytics.rs`, `HEATMAP_PROPERTY_KEYS`).
- Flush: every 5000 ms while the tab is visible (`flush_interval_milliseconds` can change it) and on `beforeunload` (`:22, 95-101, 169-178, 186`).
- `mousemove` points are taken 500 ms after the mouse stops (`:274-284`).
- A rage click adds an extra point with `type: "rageclick"` (`:261-269`; thresholds below).
- Dead clicks feed `type: "deadclick"` points (`:160-167`).

### 8.2 Scroll depth

`JS:packages/browser/src/page-view.ts:77-161`. The data for the page you just left rides on the next `$pageview` or on `$pageleave`:

`$prev_pageview_id`, `$prev_pageview_pathname`, `$prev_pageview_duration` (seconds), `$prev_pageview_last_scroll`, `$prev_pageview_max_scroll`, `$prev_pageview_last_content`, `$prev_pageview_max_content` (pixels), and the four `_percentage` variants (0 to 1). Scroll values come from `scroll-manager.ts:44-63`. Turn off with `disable_scroll_properties`.

### 8.3 Autocapture

`JS:packages/browser/src/autocapture.ts`. Event `$autocapture` for click, change, submit (and `$copy_autocapture` for clipboard). Properties (`:287-296`): `$event_type` (`click`, `change`, `submit`), `$ce_version: 1`, `$elements` (unless `elementsChainAsString`), **`$elements_chain`**, `$el_text`, `$external_click_url`, `$element_selectors`.

`$elements_chain` grammar (`JS:packages/browser-common/src/utils/autocapture-utils.ts:807-840`). One entry per element, target first, joined by `;`. No space.

```
chain   = element *( ";" element )
element = [tag] *( "." class ) ":" *( key '="' value '"' )
```

- `tag` is the lowercase tag name. Classes are sorted and appended as `.class` with `"` removed.
- After `:` come attributes with no separator between pairs. Keys are sorted lexically after being merged from: `text` (the `$el_text`, max 400 chars, only if non-empty), `nth-child`, `nth-of-type` (default 0), `href` (max 2048 chars), `attr_id`, then every `attr__*` attribute of the element (for example `attr__class`, `attr__href`, `attr__id`).
- In both keys and values, `"` is escaped as `\"`.
- Example: `a.btn.primary:text="Buy"nth-child="2"nth-of-type="1"href="/buy"attr__class="btn primary"attr__href="/buy";div:nth-child="1"nth-of-type="1"attr__class="card";body:nth-child="2"nth-of-type="1"`.

`$elements` (older form, an array of objects): `{tag_name, $el_text, classes, attr__*, nth_child, nth_of_type}` (`autocapture.ts:86-146`).

- `$rageclick`: a `$autocapture` click that is also a rage click is followed by an extra event named `$rageclick` with the same properties (`autocapture.ts:670-678`). Rule: 3 clicks, each within 30 px (Manhattan distance to the last click) and 1000 ms of the previous one (`JS:packages/browser/src/extensions/rageclick.ts:8-52`).
- `$dead_click` (and `$dead_swipe`): event with the element properties of `autocapture` plus `$dead_click_last_mutation_timestamp`, `$dead_click_event_timestamp`, `$dead_click_scroll_timeout`, `$dead_click_mutation_timeout`, `$dead_click_absolute_timeout`, `$dead_click_selection_changed_timeout`, `$dead_click_visibility_changed_timeout`, `$dead_click_*_delay_ms`; the event `timestamp` is the click time, so `$event_time_override_*` is set (`JS:packages/browser/src/entrypoints/dead-clicks-autocapture.ts:809-869`). Needs the script `dead-clicks-autocapture.js`.
- `$pageview`, `$pageleave`, `$web_vitals` (properties `$web_vitals_<NAME>_value`, `$web_vitals_<NAME>_event`, `$current_url`; flushed after about 5 s, `JS:packages/browser/src/extensions/web-vitals/index.ts:245-265`), `$exception` (`$exception_list` etc., `_batchKey: 'exceptionEvent'`, `posthog-exceptions.ts:189-194`), `$feature_flag_called`, `$groupidentify`, `$set`, `$identify`, `$create_alias`, `$snapshot`, `$$heatmap`, `$$client_ingestion_warning`, `$opt_in`. All travel as ordinary events.

---

## 9. posthog-node

Package `posthog-node` 5.56.2, in `JS:packages/node`, built on `JS:packages/core/src/posthog-core-stateless.ts`.

### 9.1 Path and shape

- Default mode **v0**: `POST {host}/batch/` (`getBatchEndpointPath`, `:1572-1574`). A newer `/i/v1/analytics/events` sender exists but is opt-in through the env var `POSTHOG_CAPTURE_MODE=v1`; default is `v0` (`JS:packages/node/src/capture-v1/config.ts:1-18`). It was not specified further here.
- `$ai_*` events (from `captureAi`) use `POST {host}/i/v0/ai/batch/` (`JS:packages/node/src/ai-capture/routing.ts:3`, `client.ts:524-525`). The same body shape. Our server can send them to the normal pipeline.
- Body (`:1593-1604`):

```json
{
  "api_key": "<token>",
  "batch": [
    { "uuid": "...", "event": "...", "distinct_id": "...",
      "properties": { "$lib": "posthog-node", "$lib_version": "5.56.2", "$is_server": true, "$geoip_disable": true, "...": "..." },
      "timestamp": "2026-10-19T12:00:00.123Z" }
  ],
  "sent_at": "2026-10-19T12:00:03.001Z",
  "historical_migration": true
}
```

- `distinct_id` is at the **event top level** (and not in properties) (`:575-579, 1405-1408`). `historical_migration` is present only when the client option `historicalMigration` is true (`:1606-1608`). Server meaning: a backfill; accept old timestamps and keep it off realtime paths.
- `$geoip_disable: true` is added unless `disableGeoip: false` (default true, `:450, 1397-1403`). When set, do not geolocate.
- Identify: event `$identify`; person data is inside `properties.$set` and `properties.$set_once`, plus `properties.$anon_distinct_id` when given (`JS:packages/node/src/client.ts:1148-1165`). If the caller passes plain properties they all go in `$set`.
- Set: `$set` event, props in `properties.$set` / `$set_once` (`client.ts:1222-1240`). Alias: `$create_alias` with `properties.alias` and `properties.distinct_id` (`posthog-core-stateless.ts:671-690`). Group: `$groupidentify` with `$group_type`, `$group_key`, `$group_set`, and `distinct_id` = the given one or `$<type>_<key>` (`:714-736`). Groups on events: `properties.$groups` (`client.ts:3355-3357`).
- No `$session_id` unless the caller sets a context session. No UA parsing needed.

### 9.2 Headers, compression

- `Content-Type: application/json`, `User-Agent: posthog-node/<version>`, and `Content-Encoding: gzip` with a gzip body unless `disableCompression` is set or gzip is unavailable (`:1614-1623`, `:463`). No `compression` query param. Honour `Content-Encoding`.

### 9.3 Flush and retry

- Queue in memory. Flush when the queue reaches `flushAt` (default 20) or `flushInterval` (node default 5000 ms, `client.ts:237`; core default 10000) after the first enqueue (`posthog-core-stateless.ts:1293-1310, 432-435`). `maxBatchSize` 100, `maxQueueSize` 10000 in node (`client.ts:236`; core default 1000), oldest event dropped when full.
- `captureImmediate` and `identifyImmediate` send one event at once through the same `/batch/` call.
- Request timeout 10 s, 3 retries with a fixed 3 s delay (`fetchRetryCount`, `fetchRetryDelay`, `:441-446`). Retried: 408, 429, any 5xx, and network errors (`:268-273`).
- Success is any status from 200 to 299. A 3xx or 4xx throws (`:1965-1970`).
- 413 with more than one event: halve `maxBatchSize` and resend the same batch (`:1722-1731`).
- After retries, a batch that failed with an HTTP error (not a network error) is **removed from the queue**. Only network errors keep it for the next flush (`:1735-1743`). So a server returning 503 for long enough loses data.
- The response body is ignored (`successful-write` cancels it).

### 9.4 Flags (when used)

- `POST {host}/flags/?v=2` (note `/flags/`), JSON, not compressed. Body: `token`, `distinct_id`, `groups`, `person_properties`, `group_properties`, optional `$device_id`, `evaluation_contexts`, `evaluation_runtime: "server"`, `geoip_disable` (`posthog-core-stateless.ts:804-834`). Timeout 3 s, one retry for 502/504 and network errors. Needs a v2-style JSON like section 6.3.
- Local evaluation runs only when a `secretKey`/`personalApiKey` is set: `GET {host}/flags/definitions?token=<token>&send_cohorts` with `Authorization: Bearer ...` (`JS:packages/node/src/extensions/feature-flags/feature-flags.ts:1105`). Otherwise node never polls.
- Node does not call `/array/<token>/config` on start (`getRemoteConfig` is used by the stateful core only, `posthog-core.ts:730`).

---

## 10. posthog-ios on macOS

SwiftPM and CocoaPods support macOS 10.15+ (`iOS:Package.swift:6-8`, `PostHog.podspec:21-24`). Everything below also holds on iOS unless marked.

### 10.1 What works on macOS

| Feature | macOS | Evidence |
|---|---|---|
| `capture`, `identify`, `alias`, `group`, `screen`, `reset`, `register`, flags | yes | `PostHogSDK.swift` (no platform guard on these) |
| Lifecycle events (`Application Installed/Updated/Opened/Backgrounded`) | yes | `AppLifeCycle/ApplicationLifecyclePublisher.swift:97-109` |
| Automatic `$screen` on view change | **no**. The `viewDidAppear` swizzle is `#if os(iOS) \|\| os(tvOS)` only. Manual `screen()` works. | `ScreenViews/ApplicationScreenViewPublisher.swift:66, 142` |
| Autocapture of taps | **no** (`os(iOS) \|\| macCatalyst`) | `PostHogConfig.swift:623-631` |
| **Session replay** | **no**. The config property `sessionReplay`, the integration and the config processing are all `#if os(iOS)`. | `PostHogConfig.swift:437-461, 608-615`; `Replay/PostHogReplayIntegration.swift:9`; `PostHogRemoteConfig.swift:248, 489, 521, 584` |
| Surveys | no (iOS only) | `PostHogConfig.swift:617` inside `os(iOS)` |
| Error tracking autocapture (`$exception`) | yes (iOS, macOS, tvOS) | `PostHogConfig.swift:596-600` |
| Push open events | yes (token registration is iOS only) | `:633-646` |
| Logs (`captureLog`) | yes, `POST /i/v1/logs?token=<token>` OTLP JSON | `PostHogApi.swift:233-254` |

So for a macOS app a server needs `/batch`, `/flags`, `/array/<token>/config`, and optionally `/i/v1/logs`. It does not need `/s/` for macOS, but iOS apps using the same server do.

### 10.2 Calls on start

1. `GET {host}/array/<token>/config` (`PostHogApi.swift:157-176, 501-546`), through a URLSession with `reloadRevalidatingCacheData`, so ETag / `Last-Modified` / 304 are honoured (`:75-78`). Success is 200-299. No retry. A failed fetch logs "Remote config response is missing, skipping loading flags" and flags are **not** loaded (`PostHogRemoteConfig.swift:183-188`).
2. If the config has no `hasFeatureFlags: false`, then `POST {host}/flags?v=2` (path `/flags`, no trailing slash, `PostHogApi.swift:341-345`; `PostHogRemoteConfig.swift:191-205`).
3. The config keys iOS reads: `hasFeatureFlags`, `sessionRecording` (iOS only: `endpoint`, `sampleRate`, `minimumDurationMilliseconds`, `linkedFlag`), `errorTracking.autocaptureExceptions`, `push.appIds`, `quotaLimited` (`mobile_recordings`, `feature_flags`) (`PostHogRemoteConfig.swift:191, 326-344, 360, 478, 585-630, 686-710, 721-760`).

### 10.3 `/batch` request

- `POST {host}/batch` (no trailing slash; `PostHogApi.swift:179`).
- Headers: `Content-Type: application/json; charset=utf-8`, `User-Agent: posthog-ios/3.92.0`, `Accept-Encoding: gzip`, and `Content-Encoding: gzip` with a gzip body when `config.compression == .gzip` (the default; `.none` disables it; a failed gzip falls back to plain) (`PostHogApi.swift:85-88, 98-109, 127-137`; `PostHogCompression.swift`). No query string.
- Body (`:184-189`; event `iOS:PostHog/Models/PostHogEvent.swift:92-107`):

```json
{
  "api_key": "<token>",
  "batch": [
    { "event": "$screen", "distinct_id": "...", "uuid": "0192...",
      "timestamp": "2026-10-19T12:00:00.123Z",
      "properties": { "$screen_name": "Home", "$session_id": "...", "$lib": "posthog-ios", "...": "..." } }
  ],
  "sent_at": "2026-10-19T12:00:03.001Z"
}
```

- `distinct_id` at event top level, not in `properties` (except for snapshots, section 10.5).
- Person data is **inside `properties`**: `properties.$set`, `properties.$set_once` (`PostHogSDK.swift:726-731`). `$identify` has `properties.distinct_id` and `properties.$anon_distinct_id` (omitted with `reuseAnonymousId`) (`:1068-1091`). `$create_alias` has `properties.alias` (`:1862-1867`). `$groupidentify` has `$group_type`, `$group_key`, optional `$group_set`, with `distinct_id` = the current user (`:1917-1935`). `$screen` has `$screen_name` (`:1741-1748`). Every event has `$is_identified` and `$process_person_profile`; `$geoip_disable: true` when `disableGeoIp` (default false) (`:790-799`).
- Context properties on macOS: `$app_name`, `$app_version`, `$app_build`, `$app_namespace`, `$device_manufacturer: "Apple"`, `$device_model`, `$device_name`, `$device_type: "Desktop"`, `$os_name: "macOS"`, `$os_version`, `$is_emulator`, `$is_testflight`, `$is_sideloaded`, `$is_ios_running_on_mac`, `$is_mac_catalyst_app`, `$locale`, `$timezone`, `$screen_width/$screen_height` (key window screen), `$network_wifi/$network_cellular`, `$lib`, `$lib_version` (`PostHogContext.swift:47-131, 283-317`). There is no `$browser`, `$os`, or `$raw_user_agent`. `$os_name` is the OS field (the browser SDK comments treat `$os_name` as an alias of `$os`, `event-utils.ts:74`).
- No `token` property in `properties`. Use `api_key`.
- Session: `$session_id` UUIDv7, 30 min idle, 24 h max (`PostHogSessionManager.swift:66-69`). No `$window_id` on events (set only for replay, iOS).

### 10.4 Queue, flush, retry

- Persisted on disk. Defaults: `flushAt` 20, `maxQueueSize` 1000, `maxBatchSize` 50, `flushIntervalSeconds` 30 (`PostHogConfig.swift:25-36`). Flush on reaching `flushAt`, on the 30 s timer, on foreground/reachability return, and on `flush()` (`PostHogSDK.swift:838-847`).
- Timeout 10 s per request (`PostHogApi.swift:60`).
- Retried (queue paused, then the same batch again): network failure, 408, 429, 500, 502, 503, 504, any 3xx (`QueueEndpoint+Factories.swift:8-13`). Delay `max(min(retryCount * 1 s, 30 s), Retry-After)` (`PostHogQueue.swift:156-166`, `PostHogSDK.swift:25-26`). The count of retries is not capped; records stay on disk (FIFO eviction at `maxQueueSize`).
- 413: batch halved and resent; a single event that still gets 413 is dropped (`PostHogQueue.swift:173-190`).
- Everything else (200-299 and all other 4xx and 501/505+) counts as done and the records are **removed** (`:192-196`). A 404 or 401 from our server therefore loses events silently.
- Response body is not used on `/batch`.

### 10.5 `/s/` snapshots (iOS only, for completeness)

`POST {host}{snapshotEndpoint}` (default `/s/`, set from config `sessionRecording.endpoint`, `PostHogConfig.swift:430`, `PostHogRemoteConfig.swift:332-334, 604-606`). Body is a bare JSON array of events; each has `api_key` at event level, `distinct_id`, `uuid`, `timestamp`, `event: "$snapshot"`, and `properties` with `$snapshot_data`, `$session_id`, `$window_id` (equal to the session id), `distinct_id`, `$lib`... No `sent_at`. Same gzip and retry rules (`PostHogApi.swift:203-225`; `QueueEndpoint+Factories.swift:43-69`). The queue only batches snapshots with the same `distinct_id` and `$session_id`. Not needed for macOS.

### 10.6 `/flags?v=2` (iOS)

- Body JSON (not gzipped; `getURLRequest(url)` without `gzipped`, `:352`): `api_key`, `distinct_id`, `groups`, `timezone`, `geoip_disable`, and when set `$anon_distinct_id`, `$device_id`, `person_properties`, `group_properties`, `evaluation_contexts` (`:354-381`). The key is `api_key`, not `token`.
- Response parsed as a JSON object. The SDK requires **both** `featureFlags` and `featureFlagPayloads` to exist (derived from `flags` if `flags` is present, `normalizeResponse` at `PostHogRemoteConfig.swift:1187-1216`). If either is missing it logs "Flags response missing correct featureFlags format" and treats the load as failed (`:509-518`). Minimal answer: `{"featureFlags":{},"featureFlagPayloads":{},"flags":{},"errorsWhileComputingFlags":false}`.
- Retry: once, only for 502, 504 and a set of network errors; delay 0.3 s * 2^(n-1) up to 30 s (`PostHogApi.swift:391-499`).

---

## 11. Practical failure list for a minimal server

1. **Status code.** Browser retries anything that is not exactly 200 unless it is 4xx. Return 200 with `{"status":1}`. Do not use 204.
2. **Dropping on 4xx.** Browser, node and iOS all drop data on most 4xx (node and iOS retry 408 and 429; the browser retries neither). Return 5xx when you want every client to resend. To slow the browser down, use `quota_limited` in a 200 body (2.5).
3. **gzip with `text/plain`.** No `Content-Encoding` on browser gzip. Sniff `1f 8b`. Do not parse the body as text first.
4. **`supportedCompression` string.** Must contain `gzip-js`. `gzip` is ignored. Without a match, the browser falls to uncompressed JSON.
5. **Preflight.** With no gzip/base64, or with `request_headers`, browsers send `OPTIONS` first. Answer it on all POST paths with mirrored `Access-Control-Allow-Origin`, `Access-Control-Allow-Headers`, `Access-Control-Allow-Credentials: true`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`.
6. **`sendBeacon` and credentials.** Beacons send credentials. A wildcard origin makes the browser report a CORS error on the response; the data still arrives. Mirror the origin to avoid it.
7. **Trailing slashes.** Accept `/e` and `/e/`, `/batch` and `/batch/`, `/flags` and `/flags/`, `/s` and `/s/`. Ignore the query on `/flags` (`v=2`, optional `config=true`, `ip`, `ver`, `_`, `compression`, `retry_count`, `sent_at`).
8. **Autocapture silently off.** Needs `autocapture_opt_out: false` in the config.
9. **Replay needs three things:** `sessionRecording` as an object in the config, the recorder JS reachable at `/static/<version>/lazy-recorder.js` or `/static/lazy-recorder.js?v=<version>` (or a `.full` build), and `/s/` accepting arrays. Without the script the SDK only logs an error.
10. **`/static` assets must come from the matching posthog-js version.** The SDK requests `/static/<posthog.version>/<kind>.js` first (`strict_script_versioning: 'fallback'`, `posthog-core.ts:346`) and falls back to the unversioned path. `kind` values: `recorder`, `lazy-recorder`, `dead-clicks-autocapture`, `exception-autocapture`, `web-vitals` (+ `-with-attribution`, `-soft-navs`), `surveys`, `tracing-headers`, `logs`, `conversations`, `product-tours`, `toolbar` (`JS:packages/browser/src/utils/globals.ts:205-221`). Customers can avoid all of this with `array.full.no-external.js` / `module.full.no-external` builds and `disable_external_dependency_loading`.
11. **Out-of-order events.** `$identify` is sent immediately while earlier anonymous events wait in the 3 s queue. Merge logic must not depend on arrival order. Use `timestamp` plus skew correction.
12. **Body size.** Accept at least 20 MiB for events and 25 MiB for replay (PH limits). A single replay chunk can exceed 1 MiB.
13. **Replay data format.** Keep `$snapshot_data` as received. Heavy events carry `cv: "2024-10"` and gzip-latin1 strings; do not re-encode them as UTF-8 blindly.
14. **Person properties location.** Accept `$set`/`$set_once` both at event top level (browser `$identify`) and inside `properties` (browser `$set`, node, iOS). Distinct id both in `properties.distinct_id` (browser) and at top level (node, iOS).
15. **Cookieless needs server hashing.** Without it all visitors share one person.
16. **Flags response.** iOS fails without `featureFlagPayloads`. The browser works with only `flags` or only `featureFlags`. Return all four keys.
17. **`config.js` 404.** Harmless, costs one failed request per load. Implement it to avoid console noise.
18. **iOS retries 3xx.** A redirect on `/batch` is retried, not followed as success. Do not redirect ingest paths.
19. **Browser quota key.** To pause clients use `quota_limited` with the batch key name, not an HTTP status.
20. **Base64 form body.** Content-Type `application/x-www-form-urlencoded`, field `data`, optional field `compression` via query. Percent-decode, then base64-decode, then (maybe) gunzip, then parse JSON.

---

## 12. Quick reference: which SDK uses which path by default

| SDK | Events | Replay | Flags | Config |
|---|---|---|---|---|
| browser (posthog-js 1.438.12) | `POST /e/` (or remote `analytics.endpoint`) | `POST /s/` (or remote `sessionRecording.endpoint`) | `POST /flags/?v=2` | `GET /array/<token>/config.js` then `GET /array/<token>/config` |
| node (5.56.2) | `POST /batch/` | none | `POST /flags/?v=2` | none (`/flags/definitions` only with local evaluation) |
| iOS/macOS (3.92.0) | `POST /batch` | `POST /s/` (iOS only) | `POST /flags?v=2` | `GET /array/<token>/config` |

Neither SDK in this checkout calls `/capture/`, `/i/v0/e/` (unless told by remote config), or `/decide/`.

---

## 13. Not verified

- Server-side behaviour for `$identify` merge, `$create_alias`, `$groupidentify` and person property merge precedence. Only the SDK output was read.
- The node v1 sender (`/i/v1/analytics/events`, `POSTHOG_CAPTURE_MODE=v1`). Default is v0.
- Surveys, product tours, conversations, web experiments, toolbar, site apps and logs/metrics (`/i/v1/logs`, `/i/v1/metrics`) request and response shapes. They are opt-in and off unless the config enables them.
- The exact `$exception` property layout beyond the event name and batch key.
- Exact output files of the posthog-js build (`dist/*.js`). The list of "kind" names comes from `PostHogExtensionKind`; file names under `/static/` follow that name.
- The PostHog docs page for cookieless tracking was truncated when fetched, so section 5 relies on the PostHog server source for the algorithm.
- `sendBeacon` credential and wildcard behaviour in section 2.4 is a browser rule, not code in these repos.
