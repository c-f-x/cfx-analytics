# Wave 3 map

Wave 3 is the slices config, recordings and heatmaps. Config answers the SDK's load-time paths and serves the pinned posthog-js scripts from the ASSETS binding. Recordings take `/s/` into the EU R2 bucket through the ProjectStore (`apps/worker/src/platform/ingest.ts`, `ingestSnapshots`) and play them back. Heatmaps turn `$$heatmap` events into points inside the capture batch's transaction (`ingestBatch`) and answer the dashboard's heatmap route. This map tells each test node which behaviours it proves, in which file, through which signature or path. The signatures and their comments are frozen once the test nodes start (D-21).

## How the tests reach the code

Every test goes through one of these doors. Each fails today on an `unbuilt: <name>` error, which the red gate looks for.

| Door | Use it for | Fails today on |
|---|---|---|
| A pure function's input and output | Rules in `apps/worker/src/features/config/core.ts`, `apps/worker/src/features/recordings/core.ts`, `apps/worker/src/features/heatmaps/core.ts`, and range.ts, since folded into it, | That function's marker |
| A slice's store function inside the object: `inStore(projectId, (sql) => ...)` | One table's behaviour, such as `chunksOf`, `latestSnapshot`, `insertPoints` or `readPoints` | That function's marker |
| Chunks straight to a store: `snapshotsDirect(snapshotRequestOf(id, [await snapshotChunk({...})]))`, or the RPC call `snapshotsRpc(...)` | The bytes cap, R2 keys and objects, chunk rows, retries. `snapshotsDirect` passes an in-flight set the test may hold; use `snapshotsRpc` for calls at once. | `unbuilt: ingest.ingestSnapshots` or `unbuilt: ProjectStore.ingestSnapshots` |
| A batch with points: `ingestDirect(ingestRequest(id, events, { points }))` | Points stored in the batch's transaction | `unbuilt: heatmaps.insertPoints` |
| A request through SELF: `capture(await snapshotRequest([...]))`, `capture(await jsRequest(jsBatch(token, [heatmapEvent({...})])))`, a dashboard request with `dashboardHeaders(await dashboardJwt())`; or `fetchApp(appAt(() => T0, mountRecordings), request)` with a fixed clock; or `fetchApp(worker, request, withoutStores())` | What an SDK or the dashboard sees: status, headers, body, and what was stored | The route's marker, such as `unbuilt: recordings.handleSnapshots`, or `unbuilt: heatmaps.pointsFromEvent` on a capture path |

The helpers are in `apps/worker/test/helpers/`:
- `replay.ts` is new. It builds rrweb events (`metaEvent`, `fullSnapshotEvent` with `PageElement` bodies, `inputEvent`, `mouseEvent`, `mutationEvent` with `addedNode`, `styleSheetEvent`, `networkEvent`, `consoleEvent`, `customEvent`), compresses one as posthog-js does (`compressed`, `cv: "2024-10"`), builds `$snapshot` events and `/s/` requests for posthog-js (`jsSnapshot`, `snapshotRequest`) and posthog-ios (`iosSnapshot`, `iosSnapshotRequest`), and `$$heatmap` events for `jsBatch` (`heatmapEvent`). It hands chunks to a store (`snapshotChunk`, `snapshotRequestOf`, `snapshotsDirect`, `snapshotsRpc`) and reads back `storedRecordings`, `storedChunks`, `storedPoints`, `r2Keys`, `r2Bytes` and `chunkEvents`. `gzipBytes`, `gunzipText` and `ndjsonLines` read bodies.
- `capture.ts` adds `appAt(now, ...mounts)`, any slice's routes on a fixed clock, and `ingestRequest` now carries `points: []`. Everything from wave 2 is still there: `capture`, `fetchApp`, `jsRequest`, `jsBatch`, `nodeRequest`, `iosRequest`, `preflightRequest`, `rawRequest`, `ingestDirect`, `inStore`, `storeRows`, `storedEvents`, `counterValue`, `storeText`, `wasContacted`, `dayIn`, `T0`.
- `access.ts` adds `dashboardJwt()`, a valid Access JWT with its certificate set seeded. Send it with `dashboardHeaders(jwt)`.
- `registry.ts` seeds projects: `seedProject({ settings: { recording_enabled: true } })`. `bindings.ts` gives `withoutStores()`.

Rules for every test, besides wave 2's:
- Give each test its own project, and each recording its own `newSessionId()`, so no two tests share rows or R2 keys.
- Recording is off by default. A `/s/` test seeds `recording_enabled: true`, and a heatmap capture test `heatmaps_enabled: true`.
- A chunk's counted bytes are its `gzipped.byteLength`. A cap test that needs chunks of exact sizes passes `snapshotChunk({ ... })` and then sets `gzipped` to bytes of that length: the store counts and writes them as given.
- A row failure after the R2 write (recordings-17): drop the `recordings` table with `inStore` first. `hasChunk` reads only `recording_chunks`, so the R2 write happens and `recordChunk` then fails.
- The dashboard routes need `dashboardHeaders(await dashboardJwt())`. A secret key goes as `authorization: Bearer <newSecretKey()>`.
- A test file name is its source's name, as in wave 2: `ingest.test.ts` for tests through `ingestDirect`, `snapshotsDirect` or `snapshotsRpc`, and `capture.test.ts` for tests through a capture path.

## t-config

Files: `apps/worker/src/features/config/*.test.ts`.

| ID | Test file | Under test |
|---|---|---|
| config-01 | `core.test.ts`, `http.test.ts` | `remoteConfig` with recording on: `sessionRecording` an object with endpoint `/s/`, the rate and minimum duration, `masking.maskAllInputs` true, no `maskTextSelector` or `blockSelector`; the same through `GET /array/<token>/config` |
| config-02 | `core.test.ts`, `http.test.ts` | recording and heatmaps off: `sessionRecording` is `false`, never absent, and `heatmaps` false |
| config-03 | `core.test.ts`, `http.test.ts` | `hasFeatureFlags: false`; `POST /flags/?v=2` answers exactly the four keys. The real SDKs' console is the compatibility suite's (Deferred). |
| config-04 | `core.test.ts` | autocapture on: `autocapture_opt_out: false` |
| config-05 | `core.test.ts`, `http.test.ts` | `scriptOf("/static/1.0.0/lazy-recorder.js")` is null; through SELF that path is 404 and `/static/lazy-recorder.js` is 200 with the pinned bytes. The real SDK's half is deferred. |
| config-06 | `http.test.ts` | `GET /array/<token>/config`: 200, a JSON object |
| config-07 | `core.test.ts`, `http.test.ts` | `flagsToken` with `token`, `api_key`, neither, and a body that is not an object; an unknown and a whitespace-only token (`/array/%20%20/config`) on config, `config.js` and `/flags`: 401 and `wasContacted` false; the registry failing (`UNMIGRATED_REGISTRY` with a fresh token): 503; a `/flags` body that is not JSON: 400 |
| config-08 | `core.test.ts` | `supportedCompression` is exactly `["gzip-js", "base64"]` |
| config-09 | `core.test.ts` | `elementsChainAsString: true`. What posthog-js then sends is the SDK's (Deferred). |
| config-10 | `core.test.ts`, `http.test.ts` | `analytics.endpoint` is `/e/`; a posthog-js batch to `/e/` answers 200. The `/s/` endpoint's answer is proven by recordings. |
| config-11 | `core.test.ts` | the config's keys are exactly those of `RemoteConfig`; `surveys`, `capturePerformance` and `autocaptureExceptions` false, `siteApps` `[]` |
| config-12 | `http.test.ts` | `appAt(now, mountConfig)`: a config read caches the project, its settings change in the registry, a read 59 s later still shows the old, one at 61 s the new |
| config-13 | `core.test.ts` | autocapture off: `autocapture_opt_out: true` |
| config-14 | `core.test.ts` | `heatmaps` follows the setting, and no `capture_heatmaps` key |
| config-15 | `core.test.ts` | `captureDeadClicks` follows the setting, and no `capture_dead_clicks` key |
| config-16 | `core.test.ts` | `sampleRate` null at 1.0, `"0.5"` at 0.5 |
| config-17 | `core.test.ts` | `consoleLogRecordingEnabled: false`, `networkPayloadCapture` with neither headers nor bodies, `recordCanvas: false`, `capturePerformance: false` |
| config-18 | `core.test.ts` | no `linkedFlag`, `urlTriggers`, `urlBlocklist`, `eventTriggers` or `triggerGroups` anywhere |
| config-19 | `core.test.ts`, `http.test.ts` | an iOS request (no Origin, the iOS user agent) to `/array/<token>/config`: endpoint, sample rate and minimum duration present; no `linkedFlag`, `quotaLimited` or `push` |
| config-20 | `core.test.ts`, `http.test.ts` | `configScript` assigns `window._POSTHOG_REMOTE_CONFIG[<token>]` with `config` and `siteApps: []`; `config.js` asked on two hosts gives the same body, naming neither host and holding no placeholder |
| config-21 | `core.test.ts`, `http.test.ts` | `configScript` with a config value holding `</script>` writes no `<`; a token holding a quote or a script tag on `config.js`: 401, and the body does not hold it |
| config-22 | `http.test.ts` | `config.js` and a `/static/` script: a JavaScript content type and the CORS headers |
| config-23 | `http.test.ts` | `/flags` with a gzip body, a base64 form body, plain JSON, and a query with extra keys: the four keys each time |
| config-24 | `http.test.ts` | `/flags` through `fetchApp(worker, request, withoutStores())`: 200 |
| config-25 | `core.test.ts`, `http.test.ts` | `scriptOf` for each of `SCRIPT_KINDS` at both paths; through SELF each is 200 with the same bytes at both |
| config-26 | `core.test.ts`, `http.test.ts` | another version, an unknown kind, a `.js.map` and a deeper path: null and 404 |
| config-27 | `http.test.ts` | each served script's SHA-256 equals `SCRIPT_SHA256` |
| config-28 | `http.test.ts` | with a project whose dead clicks are off, every script is still served (the script paths read no settings) |
| config-30 | `http.test.ts` | POST to `/array/<token>/config` and to `config.js`: 405 |
| config-31 | `core.test.ts`, `http.test.ts` | `cacheControlFor`; the header on a versioned and an unversioned script, the config and `config.js` |
| config-32 | `http.test.ts` | `/flags?v=2&config=true&ip=1&_=1`: exactly the four keys |
| intake-08 | `http.test.ts` | a project with default settings: the config is valid, `sessionRecording` false and `heatmaps` false |
| intake-12 | `http.test.ts` | `preflightRequest` on `/flags`, `/flags/`, `/array/<token>/config`, `config.js` and a `/static/` path; the CORS headers on 200, 401 and 404 answers of those paths. `/s/` is t-recordings'. |
| intake-27 | `http.test.ts` | a project at its daily event cap (its cap reached through `capture`): config and `/flags` still answer 200 as usual |

## t-recordings

Files: `apps/worker/src/features/recordings/*.test.ts`.

| ID | Test file | Under test |
|---|---|---|
| recordings-01 | `store.test.ts`, `http.test.ts` | `chunksOf` after `recordChunk` out of order; through `/s/`, chunks sent out of order play back ordered by first timestamp, each chunk's events in place |
| recordings-02 | `core.test.ts`, `http.test.ts` | `scrub` of an Input event; the stored object (`chunkEvents`) holds asterisks of the same length |
| recordings-03 | `ingest.test.ts`, `http.test.ts` | `snapshotsDirect` at the cap: `quotaLimited`, no R2 key written; a chunk of exactly the remaining bytes is stored; one byte more is refused whole; through `/s/`, 200 with `quota_limited: ["recordings"]` |
| recordings-04 | `http.test.ts` | project A's id with project B's session: 404; `Authorization: Bearer <secret key>` on both dashboard paths: 401 |
| recordings-05 | `core.test.ts`, `store.test.ts`, `http.test.ts` | `chunkMeta`: times, first URL, a mousedown, mouseup and click counting one click, one input change counting one keypress, active time; `listRecordings` after two chunks; the list route's summary |
| recordings-07 | `core.test.ts`, `ingest.test.ts` | `objectKey`; the R2 key `snapshotsDirect` wrote |
| recordings-08 | `core.test.ts`, `http.test.ts` | `isSessionId`, `snapshotOf` with `""`, `a/b`, `..`, `../p_other` and a non-UUID: "bad session"; through `/s/`, 400 and `r2Keys(project + "/")` empty |
| recordings-09 | `core.test.ts`, `ingest.test.ts`, `http.test.ts` | `toNdjson`; the object gunzips to the events in order; sent with CF-Connecting-IP and a user agent, the object's text holds neither |
| recordings-10 | `ingest.test.ts` | cap 1,000 with 600 taken, three 200-byte chunks through `snapshotsRpc` at once: two stored, `counterValue(..., "recording_bytes")` 1,000, one `quotaLimited` |
| recordings-11 | `ingest.test.ts` | after a chunk, the events counter has no row and the bytes counter moved |
| recordings-12 | `ingest.test.ts`, `http.test.ts` | the same chunk twice through `snapshotsDirect`, and twice at once through `snapshotsRpc`: one row, one object, bytes counted once; the same `/s/` request twice: playback returns the events once |
| recordings-13 | `http.test.ts` | recording off: 200 `{"status": 1}`, nothing stored, `wasContacted` false |
| recordings-14 | `store.test.ts` | `chunksOf` with two chunks of the same first_ts: received_at, then uuid |
| recordings-15 | `store.test.ts`, `http.test.ts` | `chunksOf` returns one session's chunks only; an unknown session and a non-UUID session: 404 |
| recordings-16 | `http.test.ts` | a stored chunk's object deleted with `env.RECORDINGS.delete`: 502 `chunk_missing`, the message naming the chunk's uuid |
| recordings-17 | `ingest.test.ts`, `http.test.ts` | the `recordings` table dropped: `snapshotsDirect` answers "row refused", the object is in R2 and its bytes are counted; through `/s/`, 503. The orphan sweep's half is deferred. |
| recordings-18 | `http.test.ts` | 20 chunks of about 2 MB each through `snapshotsDirect`, then the chunks route: every event back, in order |
| recordings-19 | `http.test.ts` | a browser bare array as gzip text/plain; `iosSnapshotRequest` with `api_key` in each event and no `sent_at`; an event with no `$snapshot_source`: each stored, the iOS chunk's times as sent |
| recordings-20 | `http.test.ts` | one request with two sessions: two chunks, one per session |
| recordings-21 | `core.test.ts`, `http.test.ts` | `snapshotOf` with no `$session_id`: "no session"; through `/s/`, the others stored and 200 |
| recordings-22 | `core.test.ts`, `http.test.ts` | `snapshotOf` of a `$pageview`: "not a snapshot"; through `/s/`, nothing of it in any table |
| recordings-23 | `http.test.ts` | two tokens in one array: only the first token's project stores, the other's store is not contacted |
| recordings-24 | `http.test.ts` | a single chunk of 3 MiB decoded: stored whole, every event back |
| recordings-25 | `core.test.ts`, `http.test.ts` | `decodeChunk` of `compressed(...)` full snapshot, mutation and stylesheet rule: plain events, no `cv`; a field that is not latin1 gzip: "undecodable"; through `/s/`, typed text inside decoded fields is scrubbed and the stored object holds no `cv` |
| recordings-26 | `core.test.ts`, `http.test.ts` | `decodeChunk` leaves out a `networkEvent` and keeps a `consoleEvent`; the stored object holds no network event |
| recordings-27 | `core.test.ts`, `ingest.test.ts` | `chunkMeta` with a Meta then a full snapshot: path without query, width; the chunk row's `snapshotPath` and `snapshotWidth` |
| recordings-28 | `core.test.ts`, `http.test.ts` | `chunkMeta` with a skew; through `appAt(() => T0, mountRecordings)` with `sent_at` an hour ahead, the recording's start and end are the rrweb times an hour earlier |
| recordings-29 | `store.test.ts`, `http.test.ts` | `listRecordings` after the distinct id is linked to a person; through SELF, a recording of an anonymous id, then posthog-js's `$identify` through capture: the list names the identified person |
| recordings-30 | `ingest.test.ts`, `http.test.ts` | the counter grows by `gzipped.byteLength`; through `/s/`, the counter equals the R2 object's size, not `$snapshot_bytes` |
| recordings-32 | `core.test.ts`, `http.test.ts` | `scrub` of a full snapshot with an `input` and a `textarea` value, a mutation adding one, and an attribute change of `value`; through `/s/`, the stored object holds asterisks |
| heatmaps-02 | `store.test.ts` | `latestSnapshot`: the newest of two snapshots of a path in the band; a width at the band's top edge counts, one at the next band's start does not; another path, or none, is null. The route's half is t-heatmaps'. |
| intake-05 | `http.test.ts` | the recording half: `/s/` with a body over 25 MiB decoded: 413, nothing stored |
| intake-12 | `http.test.ts` | `preflightRequest` on `/s/` and `/s`; the CORS headers on 200, 401 and 413 answers of `/s/` |
| cookieless-15 | `core.test.ts`, `http.test.ts` | `snapshotOf` with the sentinel: "cookieless"; through `/s/`, nothing stored |
| events-12 | `ingest.test.ts` | the recordings clause: `ingestDirect` with `fixedSources({ databaseSize: STORE_GUARD_BYTES })` stores no event, and `snapshotsDirect` to the same store still stores its chunk |

## t-heatmaps

Files: `apps/worker/src/features/heatmaps/*.test.ts`.

| ID | Test file | Under test |
|---|---|---|
| heatmaps-01 | `core.test.ts`, `ingest.test.ts`, `capture.test.ts` | `pointsFromEvent`: path without query, host, band, bot; `ingestDirect` with points stores them beside the events; through capture with heatmaps on, the points are stored and no event row has `$$heatmap` |
| heatmaps-02 | `http.test.ts` | the heatmap route: the points of the path and band, and the snapshot from chunks stored with `snapshotsDirect` (its `snapshotPath` and `snapshotWidth`), or `snapshot: null` without one |
| heatmaps-04 | `core.test.ts`, `store.test.ts` | a `fixed` point keeps x and y as sent; `readPoints` groups fixed and unfixed points at the same x and y apart. Drawing is the dashboard's (Deferred). |
| heatmaps-05 | `core.test.ts`, `capture.test.ts` | `pointsFromEvent(..., false)` is empty; through capture with heatmaps off, no point and no event row |
| heatmaps-06 | `core.test.ts`, `capture.test.ts` | an event whose `$current_url` and `$pathname` name another page: each URL key's own page key decides |
| heatmaps-07 | `core.test.ts`, `capture.test.ts` | no `$viewport_width`: no points; through capture 200, the batch's other events stored |
| heatmaps-08 | `core.test.ts` | click, rageclick and deadclick points are kept |
| heatmaps-09 | `core.test.ts` | mousemove points are not |
| heatmaps-10 | `core.test.ts` | a missing, non-number and negative x or y skips that point only |
| heatmaps-11 | `store.test.ts`, `http.test.ts` | `readPoints` for band 1,200 returns no point of band 1,100 or 1,300, unscaled |
| heatmaps-12 | `store.test.ts`, `http.test.ts` | `readPoints` with a kind and without |
| heatmaps-13 | `store.test.ts`, `ingest.test.ts`, `capture.test.ts` | `insertPoints` twice answers 0 the second time; `ingestDirect` twice; the same `$$heatmap` event sent twice through capture |
| heatmaps-14 | `capture.test.ts` | `$rageclick` and `$dead_click` stored as ordinary events. This already holds through wave 2's capture path, so the red gate lists it as passing. |
| heatmaps-15 | `capture.test.ts` | a `$dead_click` with its own timestamp is stored at that time. Passes already, as above. |
| heatmaps-19 | `core.test.ts`, `http.test.ts` | `pointRules`: a person-property rule and a non-`$host` event-property rule are not applicable, a `$host` rule applies; the answer's `meta.excluded.notApplicable` |
| intake-19 | `capture.test.ts` | a batch with `$identify`, `$create_alias`, `$groupidentify`, `$snapshot`, `$exception` and a `$$heatmap`: five ordinary event rows, no `$$heatmap` row. The ordinary half passes already. |
| query-07 | `store.test.ts`, `http.test.ts` | for points: bot points left out unless `includeBots`, and `meta.excluded.bots` says so |
| query-08 | `core.test.ts`, `store.test.ts`, `http.test.ts` | for points: a `$host` rule leaves that host's points out, and `meta.excluded.internalRules` names it |
| query-10 | `range.test.ts` | `resolveRange` at a fixed now in Europe/Oslo: today, yesterday, last 7 days, last 24 hours, and a daylight-saving day of 23 hours |
| query-11 | `range.test.ts`, `http.test.ts` | `between` as given; a start not before its end and a negative start are errors; through the route, 400 and `wasContacted` false |
| query-12 | `core.test.ts`, `http.test.ts` | `heatmapMeta`: ISO UTC range, time zone, exclusions, `rowsRead`; the route's meta |
| query-14 | `http.test.ts` | no `timeZone`: the project's; an unknown IANA name: 400 naming `timeZone`, and `wasContacted` false |
| query-36 | `http.test.ts` | a date without a time in `between`: 400 |
| query-37 | `range.test.ts` | the same `now` gives the same range twice |
| query-40 | `range.test.ts`, `http.test.ts` | a range before the heatmap retention is clipped, `requested` holds the asked range; the route's `meta.requested` |

## Deferred

| Behaviour | Why |
|---|---|
| recordings-06 | The orphan sweep is the daily alarm's, in wave 4 (`sweep.ts`). |
| recordings-17, sweep half | The same: the orphan left by a row failure is swept in wave 4. The 503 and the counted bytes are in this wave. |
| heatmaps-03, heatmaps-16, heatmaps-17, heatmaps-18 | Scroll depth is the query slice's `scroll_depth` kind (`packages/shared/src/query.ts`), answered by the query route in wave 4. It reads the `events` table, which wave 2 already fills. |
| heatmaps-20 | It runs the real posthog-js and reads scroll depth: the compatibility suite and wave 4. |
| heatmaps-04, drawing half | Drawing points over a snapshot is the dashboard's heatmaps screen, wave 5. The points' coordinates and `fixed` flag are in this wave. |
| config-29 | It loads the real posthog-js in a browser. The compatibility suite (`docs/engineering.md`, "Real SDKs") is not built yet. config-05 and config-25 prove the server's half. |
| config-03, config-05, config-09, the SDK halves | "No SDK logs an error", "the real SDK loads it" and "`$autocapture` events carry `$elements_chain`" are what the real SDKs do, for the compatibility suite. |
| events-12, sweep clause | The sweep is wave 4. The recordings clause is in this wave. |
| cookieless-04 and events-09, alarm halves | Still wave 4's alarm, as wave 2's map says. |

These draft functions of `build/skeleton` serve wave 4 only, so they are not in this wave's files: in `apps/worker/src/features/recordings/store.ts`, `reassignPerson`, `expiredRecordings`, `recordingsOfPerson`, `deleteChunkRows`, `knownKeys`, `deleteObjects`, `orphanKeys` and `deletePrefix`; in `apps/worker/src/features/heatmaps/store.ts`, `prunePoints` and `erasePoints`. Wave 4's outline brings them back.

## Fill split

Each fill worker owns these files and passes these tests. The gate is `pnpm wave:gate fill <own files> --tests <test files>`.

| Fill | Owns | Passes | Needs first |
|---|---|---|---|
| f-config | `apps/worker/src/features/config/core.ts`, `apps/worker/src/features/config/http.ts` | `apps/worker/src/features/config/core.test.ts`, `apps/worker/src/features/config/http.test.ts` | nothing |
| f-recordings-core | `apps/worker/src/features/recordings/core.ts` | `apps/worker/src/features/recordings/core.test.ts` | nothing |
| f-recordings-store | `apps/worker/src/features/recordings/store.ts` | `apps/worker/src/features/recordings/store.test.ts` | nothing |
| f-heatmaps-core | `apps/worker/src/features/heatmaps/core.ts`, and range.ts, since folded into it, | `apps/worker/src/features/heatmaps/core.test.ts`, and range.test.ts, since folded into it, | nothing |
| f-heatmaps-store | `apps/worker/src/features/heatmaps/store.ts` | `apps/worker/src/features/heatmaps/store.test.ts` | nothing |
| f-ingest | `apps/worker/src/platform/ingest.ts` (`ingestSnapshots`), the bodies of the wave 3 calls in `apps/worker/src/platform/project-store.ts`, and `takeWholeFromCap` and `returnToCap` in `apps/worker/src/features/events/store.ts` | `apps/worker/src/features/recordings/ingest.test.ts`, `apps/worker/src/features/heatmaps/ingest.test.ts`, `apps/worker/src/features/heatmaps/capture.test.ts` | f-recordings-core (for `objectKey`), f-recordings-store, f-heatmaps-core, f-heatmaps-store |
| f-recordings-http | `apps/worker/src/features/recordings/http.ts` | `apps/worker/src/features/recordings/http.test.ts` | f-recordings-core, f-recordings-store, f-ingest |
| f-heatmaps-http | `apps/worker/src/features/heatmaps/http.ts` | `apps/worker/src/features/heatmaps/http.test.ts` | f-heatmaps-core, f-heatmaps-store, f-ingest |

The first five run side by side. `apps/worker/src/features/heatmaps/capture.test.ts` needs no fill of `apps/worker/src/features/intake/http.ts`: the capture path already hands `$$heatmap` events to `pointsFromEvent` and their points to `ingestBatch`, which calls `insertPoints`.

The close node then:
- removes unbuilt.ts (now gone), and with it `app.onError(surfaceUnbuilt)` in `apps/worker/src/index.ts`, once no marker is left;
- runs `pnpm check`;
- updates the "Nothing yet" row of `docs/engineering.md` for a project reading another's data, which recordings-04 now guards for recordings;
- measures the test commands again for `CLAUDE.md`.

## Questions for the audit

1. **The heatmap route needs the range rules of the query slice.** A `HeatmapSpec` names a `range`, a time zone and `includeBots`, and its answer has `AnswerMeta`. Those rules (query-07, query-08, query-10 to query-14, query-36, query-37, query-40) belong to the query slice of wave 4, which no wave 3 file may import. Without them the route could not be built in this wave, and its marker would block the close. So and range.ts, since folded into it, holds `resolveRange` now, t-heatmaps proves it under the query IDs, and wave 4's query slice imports it through `apps/worker/src/features/heatmaps/index.ts`, or moves it to the platform folder with its tests. Either way it keeps one home.
2. **Points take nothing from a daily cap.** D-20 bounds the bill with the event and recording-bytes caps. A `$$heatmap` event makes no event row, so the contract counts it nowhere, and points can grow without a cap until the retention sweep. Counting each `$$heatmap` event against the events cap is the other choice. It would make `counters` disagree with `events` rows, which events-01 reads.
3. **`recordings.person_id` is never written.** The list reads a recording's person through `person_distinct_ids` when it is read, so an `$identify` after the recording began counts at once (recordings-29), with no change to `ingestBatch`. Keeping the column current would need every merge and link of a batch to update recordings too, inside wave 2's built transaction. `docs/data-model.md` now says so. A later schema step may drop the column.
4. **Active time.** recordings-05 names "active time" without a rule. The contract sums the gaps of at most 5 s (`ACTIVE_GAP_MS`) between input events inside each chunk. A gap that spans two chunks is not counted.
5. **Every `value` in a mutation's attribute changes is scrubbed.** An attribute change names a node id, not its tag, so the contract cannot tell an input from another element without the session's earlier chunks. It scrubs them all. Over-scrubbing costs only the rare `value` of a `progress` or `option`.
6. **An undecodable chunk is left out, not refused.** D-20 drops one bad event and keeps the rest. A `$snapshot` whose `cv` fields do not decode is left out of a request that otherwise stores, with 200.
7. **The pinned scripts are committed.** `apps/worker/assets/posthog/` holds the six scripts of posthog-js 1.438.12 byte for byte (about 505 KB), under the package's licence `(Apache-2.0 AND MIT)`, with its notice in `THIRD_PARTY_NOTICES.md`. `scripts/posthog-scripts.mjs <version>` refreshes them from npm. The other way, a devDependency copied at build time, would make every test run and build depend on a copy step. Biome and oxlint skip the folder.
8. **The heatmap's snapshot ignores the answer's range.** heatmaps-02 asks for the newest full snapshot of the path in the band. The contract takes it whatever its age, since an old page is better than a blank one.
9. **A failed R2 write gives its bytes back.** No behaviour says so. Since D-20 counts the bytes written to R2, the contract returns bytes that were never written.
10. **A `/flags` body that is JSON but not an object is 400.** config-07 names only a body that is not JSON.
11. **An empty `$session_id` is "bad session", 400, while an absent one is dropped.** recordings-08 names the empty session id among the 400 cases, and recordings-21 an event with no session id among the dropped ones.
12. **One RPC carries a whole `/s/` request's gzipped chunks.** A request decodes to at most 25 MiB, and gzip only shrinks rrweb's JSON, so the call stays under the RPC message limit of 32 MiB in practice. Incompressible snapshot data near 25 MiB could pass it, and the request would answer 503.
13. **`$$heatmap` events now go through `prepareEvent`.** So a heatmap event older than the events retention is dropped, as are cookieless heatmap events without `$cookieless_mode`. The heatmap retention itself is the sweep's, in wave 4.

## Audit answers (2026-10-21)

1. Accepted for this wave. Wave 4's outline moves `resolveRange` and its tests into `packages/shared`, so query and heatmaps import one home.
2. Changed. Each `$$heatmap` event takes one from the events cap after the batch's events, so points cannot grow the bill past the cap (heatmaps-21, new). `counters` then counts every event sent, heatmap ones included, which `docs/data-model.md` now says. The contract is in `ingest.ts`, step 7, and `apps/worker/src/features/heatmaps/ingest.test.ts` proves it.
3. Accepted. The dead `recordings.person_id` column goes in a later schema step.
4. to 11. and 13. Accepted.
12. Accepted, with the limit noted: an `/s/` request near 25 MiB of incompressible snapshot data could pass the 32 MiB RPC limit and answer 503. posthog-js sends chunks far smaller.
