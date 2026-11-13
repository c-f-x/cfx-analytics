# Wave 2 map

Wave 2 is the slices intake, cookieless, identity and events, which share one ProjectStore transaction (`apps/worker/src/platform/ingest.ts`). This map tells each test node which behaviours it proves, in which file, through which signature or path. The signatures and their comments are frozen once the test nodes start (D-21).

## How the tests reach the code

Every test goes through one of four doors. Each fails today on an `unbuilt: <name>` error, which the red gate looks for.

| Door | Use it for | Fails today on |
|---|---|---|
| A pure function's input and output | Rules in `core.ts`, `clip.ts`, `decode.ts`, `normalize.ts`, `time.ts`, `uuid.ts` | That function's marker |
| A slice's store function inside the object: `inStore(projectId, (sql) => ...)` | One table's behaviour, such as `saltForDay` or `takeFromCap` | That function's marker |
| A whole batch inside the object: `ingestDirect(request, fixedSources(...))`, or the RPC call `ingestRpc(request)` | What one transaction does across slices: caps, cookieless ids and sessions, people and merges. `ingestDirect` lets the test pass salts, session ids and the database size. Use `ingestRpc` for concurrency, since calls to one object run one at a time. | `unbuilt: ingest.ingestBatch` or `unbuilt: ProjectStore.ingest` |
| A capture request: `capture(await jsRequest(...))` through SELF, `fetchApp(worker, request, bindings)` with changed bindings, or `fetchApp(captureApp(now), request)` with a clock the test moves | What an SDK sees: status, body, CORS, and what was stored | `unbuilt: intake.handleCapture` |

The helpers are in `apps/worker/test/helpers/`:
- `capture.ts` builds requests as posthog-js (gzip, base64 form, JSON), posthog-node, posthog-ios and the hand-built client send them, sends them, hands batches straight to a store, and reads every table back. `wasContacted(projectId)` says whether the Worker ever reached a project's store; ask it before reading the store, because reading contacts it.
- `registry.ts` seeds projects: `seedProject({ settings: { daily_event_cap: 5 } })` gives `{ id, token, settings }`.
- `access.ts` is for dashboard paths; wave 2 does not need it.

Rules for every test:
- Give each test its own project from `seedProject()`, or its own `newProjectId()` for store-only tests, so no two tests share rows.
- A capture test that checks the cap, retention or a day boundary either sets the project's settings, or uses `captureApp(now)` to fix the clock. SELF runs on the real clock.
- A store-level test passes time in: `ingestRequest(id, events, { receivedAt })` and `incomingEvent({ ts })`. `T0` is 2026-10-21 10:00 UTC.
- A failing binding is the real one swapped: `{ ...env, REGISTRY: env.UNMIGRATED_REGISTRY }` fails every registry query. Use a fresh token, because a cached token skips the registry.
- A test file name is its source's name. A behaviour proven through a wider path still belongs to the slice of its ID, so cookieless, identity and events each have two more files, named for the path: `ingest.test.ts` for tests through `ingestDirect` or `ingestRpc`, and `capture.test.ts` for tests through a capture request. `store.test.ts` holds only tests of the slice's own store functions through `inStore`. The fill gate runs whole files, so this split lets each fill pass its own files before the others land.

## t-intake

Files: `apps/worker/src/features/intake/*.test.ts`.

| ID | Test file | Under test |
|---|---|---|
| intake-01 | `http.test.ts`, `core.test.ts` | posthog-js gzip batch to `/e/`; `captureAnswer` |
| intake-02 | `http.test.ts` | unknown and missing token: 401, `wasContacted` false |
| intake-03 | `http.test.ts` | the same batch twice through `/e/` |
| intake-04 | `clip.test.ts`, `core.test.ts`, `http.test.ts` | `clipText`, `clipProperties`; `prepareEvent` clips the name; stored `propertiesText` parses with the other values intact |
| intake-05 | `decode.test.ts`, `http.test.ts` | `decodeBody` over `BODY_LIMITS.eventBytes`; 413 and nothing stored. The recording half is deferred. |
| intake-06 | `http.test.ts` | a posthog-node or the hand-built client event with `$process_person_profile: false` and a fresh id: stored, `personId` null, no person row |
| intake-07 | `http.test.ts` | events sent with CF-Connecting-IP, X-Forwarded-For and a `$ip` property; `storeText` holds none of the addresses |
| intake-09 | `http.test.ts` | a project one below its cap, two batches through SELF at once: one more stored, the other answer has `quota_limited` |
| intake-10 | `decode.test.ts`, `http.test.ts` | gzip as `text/plain` with no Content-Encoding, and with `Content-Encoding: gzip` (`nodeRequest`, `iosRequest`) |
| intake-11 | `decode.test.ts`, `http.test.ts` | the base64 form body, standard and URL-safe (`jsRequest(body, "base64-url-safe")`), plain and gzipped inside |
| intake-12 | `http.test.ts` | `preflightRequest` on every path in `CAPTURE_PATHS`; the CORS headers on 200, 401 and 413; no Origin and a non-URL Origin. The other SDK paths are deferred. |
| intake-13 | `normalize.test.ts` | `distinct_id` and `$set` at the top level and inside `properties` read the same |
| intake-14 | `time.test.ts` | `eventTime` with a sent_at two hours behind |
| intake-15 | `http.test.ts` | the same batch on all eight `CAPTURE_PATHS`: 200 `{"status": 1}`, no redirect, stored |
| intake-16 | `normalize.test.ts`, `http.test.ts` | `handBuiltRequest(handBuiltEvent(...))` to `/i/v0/e/`: one event, no person, project from `api_key`; the cookieless page form (`cookielessProperties()`, distinct id `COOKIELESS_SENTINEL`) is stored under a `cookieless_` id |
| intake-17 | `http.test.ts` | GET on each capture path: 405, nothing stored |
| intake-18 | `core.test.ts`, `http.test.ts` | `retentionStart`; `prepareEvent` drops an event older than retention; `nodeBatch(..., { historicalMigration: true })` with last year's timestamps |
| intake-20 | `normalize.test.ts` | an unknown top-level key is ignored |
| intake-21 | `normalize.test.ts`, `http.test.ts` | the token in `api_key` only, in every `properties.token` only, and in both |
| intake-22 | `http.test.ts` | wrapper token A, one event with `properties.token` B: that event is in neither store |
| intake-23 | `http.test.ts` | `jsRequest(body, "json")` after `preflightRequest` |
| intake-24 | `decode.test.ts`, `normalize.test.ts`, `http.test.ts` | each unreadable body: 400, nothing stored; with a registry binding that throws when touched (the health test's pattern) and `wasContacted` false |
| intake-25 | `decode.test.ts`, `http.test.ts` | `sentLimit`; a JSON request whose Content-Length is over the cap; gzip and base64 bodies that decode over 20 MiB |
| intake-26 | `decode.test.ts` | `decodeBody` at exactly the limit and one byte over, for `BODY_LIMITS.eventBytes` and `BODY_LIMITS.recordingBytes` |
| intake-28 | `http.test.ts` | the registry failing (`UNMIGRATED_REGISTRY`): 503, store not contacted; the store failing (its recorded step set past the code's, as `apps/worker/src/platform/project-store.test.ts` does): 503, nothing stored; each retried once the failure is gone stores the whole batch |
| intake-29 | `normalize.test.ts`, `http.test.ts` | one batch with each faulty event beside good ones |
| intake-30 | `core.test.ts`, `http.test.ts` | `quotaKey`; a batch of only `$exception` at the cap answers `exceptionEvent` |
| intake-31 | `uuid.test.ts`, `core.test.ts`, `http.test.ts` | `isUuid`, `uuidV7`; `prepareEvent` replaces a missing or malformed uuid; two identical events with no uuid are both stored |
| intake-32 | `http.test.ts` | an event name holding SQL, read back exactly |
| intake-33 | `time.test.ts` | timestamp with no sent_at; none or unparseable |
| intake-34 | `normalize.test.ts`, `time.test.ts` | `sent_at` in the query (`normalizeBody`'s `sentAtQuery`), as ISO and as epoch ms; an unparseable one counts as absent |
| intake-35 | `time.test.ts` | `ignoreSentAt` |
| intake-36 | `time.test.ts` | a result more than 23 hours after receipt |
| intake-37 | `http.test.ts` | through `captureApp(now)`: `receivedAt` is `now`, whatever the request carries |

## t-cookieless

Files: `apps/worker/src/features/cookieless/*.test.ts`.

| ID | Test file | Under test |
|---|---|---|
| cookieless-01 | `core.test.ts`, `ingest.test.ts` | `siphash24` against the reference vector; `cookielessId`'s form and inputs; through `ingestDirect`, the stored id is `cookieless_` and 16 hex, and `storeText` holds neither the sentinel nor the IP |
| cookieless-02 | `core.test.ts`, `ingest.test.ts` | `cookielessId` changes with each input; two visits on one day share an id, on the next day they do not |
| cookieless-03 | `capture.test.ts` | a cookieless `$identify` and `$create_alias` are dropped; the batch's other events are stored |
| cookieless-04 | `core.test.ts`, `store.test.ts` | `saltExpiry`; `saltForDay` making a new salt at (D+1) 12:00 UTC deletes D's, at 11:59:59.999 it does not; `pruneSalts` at the same two moments |
| cookieless-06 | `core.test.ts`, `ingest.test.ts` | `nextSession` at 20 min, 40 min, exactly 30 min and 30 min + 1 ms; through `ingestDirect`, a batch whose events are out of time order gets the same sessions |
| cookieless-07 | `ingest.test.ts` | a cookieless event's `personId` is null and no person row exists |
| cookieless-08 | `capture.test.ts` | the hash reads `$raw_user_agent` when present and the User-Agent header otherwise: equal inputs give equal ids |
| cookieless-09 | `core.test.ts`, `ingest.test.ts` | `saltDay` and `hashDay` with a valid, an invalid and no `$timezone`; two events on different days get different ids |
| cookieless-10 | `core.test.ts`, `ingest.test.ts` | `hashDay` for a day whose salt has expired; such a late event is stored, hashed with today's salt |
| cookieless-11 | `ingest.test.ts` | two `ingestRpc` batches at once, both the first of a day: one salt row |
| cookieless-12 | `ingest.test.ts` | an ordinary event with no `sessionId` stays without one |
| cookieless-13 | `ingest.test.ts` | an ordinary event's distinct id and session are stored as received |
| cookieless-14 | `capture.test.ts` | the sentinel without `$cookieless_mode: true`: dropped, 200, the other events stored |
| cookieless-16 | `capture.test.ts`, `ingest.test.ts` | X-Forwarded-For and X-Real-IP change nothing, CF-Connecting-IP does; no CF-Connecting-IP (`ip: null`) drops the event; `ingestDirect` with `clientIp: null` |
| cookieless-17 | `store.test.ts`, `ingest.test.ts`, `capture.test.ts` | `saltForDay` with a `makeSalt` that gives 15 bytes answers a SaltError; `ingestDirect` then answers it and stores nothing; through a capture path the answer is 503 when the salt cannot be read, for example after the test drops the `cookieless_sessions` and `salts` tables in the store |
| cookieless-18 | `core.test.ts`, `store.test.ts` | `nextSession` with an event before `lastTs`; `sessionFor` never moves `last_ts` back |

## t-identity

Files: `apps/worker/src/features/identity/*.test.ts`.

| ID | Test file | Under test |
|---|---|---|
| identity-01 | `core.test.ts`, `ingest.test.ts`, `capture.test.ts` | `linkPlan`, `mergeStates`; anonymous events then `$identify` through `ingestDirect`, including events with `processPerson: false`; through capture, node's `$identify` with `$set`, and iOS's identify with `reuseAnonymousId` (no `$anon_distinct_id`) |
| identity-02 | `ingest.test.ts` | two projects' stores, both with distinct id "1"; an alias in one links nothing in the other |
| identity-03 | `ingest.test.ts` | `$identify` stored before the anonymous events it joins |
| identity-04 | `store.test.ts`, `capture.test.ts` | `resolvePerson` with `processPerson: false` and a `$set`: null, no person row; through capture, a posthog-js event with top-level `$set` and `$process_person_profile: false` |
| identity-05 | `core.test.ts`, `store.test.ts` | `applyPersonOps`; `resolvePerson` with two `$set` events in either order |
| identity-06 | `store.test.ts`, `capture.test.ts` | `resolvePerson` makes a person; through capture, an event with no `$process_person_profile` |
| identity-07 | `core.test.ts`, `store.test.ts` | `applyPersonOps`; `resolvePerson` with `$set_once` in either order |
| identity-08 | `core.test.ts`, `capture.test.ts` | `applyPersonOps` removes keys; through capture, `$unset` at the top level and in `properties` |
| identity-09 | `capture.test.ts` | `$set` at the top level and in `properties`: the top level wins |
| identity-10 | `core.test.ts`, `capture.test.ts` | node's `$identify` with `properties.$set` and `properties.$set_once` |
| identity-11 | `ingest.test.ts` | `$identify` of an id that already has events: they stay on its person |
| identity-12 | `core.test.ts`, `store.test.ts` | `linkPlan` with equal ids; `resolvePerson` with alias b to a, and the chain a to b to c |
| identity-13 | `ingest.test.ts` | an alias stored before the events of either id |
| identity-14 | `core.test.ts`, `store.test.ts`, `ingest.test.ts` | `linkPlan` of two identified people; `resolvePerson` keeps them apart; the event is still stored |
| identity-15 | `ingest.test.ts` | a new anonymous id after an identify stays apart until a new `$identify` |
| identity-16 | `capture.test.ts` | `$groupidentify` is stored as an ordinary event; the store has no group table |
| identity-17 | `capture.test.ts` | `$groups` stays an event property |
| identity-18 | `ingest.test.ts` | the same `$identify` (same uuid) twice: the person is unchanged and one row is stored |
| identity-19 | `store.test.ts`, `ingest.test.ts` | `resolvePerson`: two anonymous ids, then `$identify` of one: the other is not linked; through `ingestDirect` from one IP and user agent, cookieless ids never appear in `person_distinct_ids` |

## t-events

Files: `apps/worker/src/features/events/*.test.ts`.

| ID | Test file | Under test |
|---|---|---|
| events-01 | `store.test.ts`, `ingest.test.ts` | `takeFromCap` through `inStore`; `ingestDirect` with a cap of 5: 3 stored, `counterValue` 3 |
| events-02 | `core.test.ts`, `ingest.test.ts`, `capture.test.ts` | `grant`; cap 5 with 4 taken: the first event in batch order is stored, the counter reads 5; through capture the answer is 200 with `quota_limited` |
| events-03 | `capture.test.ts` | at the cap: exactly `{"status": 1, "quota_limited": ["events"]}`, and `exceptionEvent` for a batch of `$exception` |
| events-04 | `ingest.test.ts` | cap 8 with 5 taken, ten `ingestRpc` batches at once: exactly 3 stored, 7 answers `quotaLimited` |
| events-05 | `ingest.test.ts` | a stored batch sent again: the counter still reads 3 |
| events-06 | `store.test.ts` | `insertEvents` with a stored uuid among new ones answers only the new rows |
| events-07 | `core.test.ts`, `ingest.test.ts` | `capDay` in Europe/Oslo around local midnight; a batch after local midnight counts on the new day |
| events-08 | `capture.test.ts` | `captureApp(now)`: a request caches the cap, the registry's cap changes, a request 59 s later still gets the old cap, one at 61 s the new |
| events-09 | `core.test.ts`, `store.test.ts` | `counterKeepFrom`; with yesterday's counter row, today starts at zero; `pruneCounters` keeps yesterday's row |
| events-10 | `store.test.ts` | one uuid twice in a batch: one row, the first copy's properties; a later batch with the same uuid changes nothing; a plain INSERT without `OR IGNORE` fails on the unique index |
| events-11 | `apps/worker/src/features/projects/core.test.ts` | Already proven by wave 1. No new test. |
| events-12 | `core.test.ts`, `ingest.test.ts` | `storeIsFull`; `ingestDirect` with `fixedSources({ databaseSize: STORE_GUARD_BYTES })`: nothing stored, `quotaLimited`. The sweep and recordings clauses are deferred. |
| events-13 | `store.test.ts`, `ingest.test.ts` | `insertEvents` with a row that breaks a NOT NULL or CHECK constraint answers `row refused`; inside `ingestDirect` the whole batch, counter included, is rolled back |
| events-14 | `ingest.test.ts` | an event 2 s older than the last one, stored later, keeps its own time; the person's latest event time does not move back |
| events-15 | `store.test.ts` | properties with `null`, `{}`, a large integer, and names with `/` and `~`, read back with `storedEvents` |

## Deferred

| Behaviour | Why |
|---|---|
| intake-08 | Remote config is the config slice, wave 3. |
| intake-19 | `$$heatmap` events become points in the heatmaps slice, wave 3. Until then `handleCapture` leaves them out of the batch. Its other clause (`$identify`, `$create_alias`, `$groupidentify`, `$snapshot`, `$exception` stored as ordinary events) moves with it, so the line is proven in one place. |
| intake-27 | Remote config and `/flags` are the config slice, wave 3. |
| intake-05, recording half | `/s/` is the recordings slice, wave 3. The event half is in this wave. |
| intake-12, other paths | `/s/`, `/flags`, `/array/<token>/config` and the script paths come with wave 3. The capture paths are in this wave. |
| cookieless-15 | `/s/` is the recordings slice, wave 3. |
| cookieless-04, alarm half | The daily alarm calls `pruneSalts` from wave 4 (`sweep.ts`). `pruneSalts` itself is tested now. |
| events-09, alarm half | The same for `pruneCounters`. |
| events-12, sweep and recordings clauses | The sweep is wave 4 and recordings wave 3. The intake clause is in this wave. |

## Fill split

Each fill worker owns these files and passes these tests. The gate is `pnpm wave:gate fill <own files> --tests <test files>`.

| Fill | Owns | Passes | Needs first |
|---|---|---|---|
| f-intake | `apps/worker/src/features/intake/clip.ts`, `core.ts`, `decode.ts`, `normalize.ts`, `time.ts`, `uuid.ts` | `intake/{clip,core,decode,normalize,time,uuid}.test.ts` | nothing |
| f-cookieless | `apps/worker/src/features/cookieless/core.ts`, `store.ts` | `apps/worker/src/features/cookieless/core.test.ts`, `store.test.ts` | nothing |
| f-identity | `apps/worker/src/features/identity/core.ts`, `store.ts` | `apps/worker/src/features/identity/core.test.ts`, `store.test.ts` | nothing |
| f-events | `apps/worker/src/features/events/core.ts`, `store.ts` | `apps/worker/src/features/events/core.test.ts`, `store.test.ts` | nothing |
| f-ingest | `apps/worker/src/platform/ingest.ts`, and the body of `ProjectStore.ingest` in `apps/worker/src/platform/project-store.ts` | every `ingest.test.ts` of cookieless, identity and events | f-intake (for `uuidV7`), f-cookieless, f-identity, f-events |
| f-capture | `apps/worker/src/features/intake/http.ts` | `apps/worker/src/features/intake/http.test.ts` and every `capture.test.ts` | f-intake, f-ingest |

The first four run side by side. An `ingest.test.ts` fails until f-ingest lands, and a `capture.test.ts` or `apps/worker/src/features/intake/http.test.ts` until f-capture lands, so each fill's gate names only the files its own code can pass.

The close node then:
- removes unbuilt.ts (now gone), and with it `app.onError(surfaceUnbuilt)` in `apps/worker/src/index.ts`, once no marker is left;
- runs `pnpm check`;
- updates the two "Nothing yet" rows of `docs/engineering.md` for intake-07 and intake-09, which these tests now guard.

## Questions for the audit

1. **identity-01 and identity-03 against `person_id` being null for `$process_person_profile: false`.** posthog-js sends anonymous events with `$process_person_profile: false` by default (`person_profiles: 'identified_only'`). The two lines ask that those earlier events count for the person once `$identify` arrives, before or after them. So `resolvePerson` attributes such an event to the person its id already belongs to, and each newly linked id claims its events with no person (`claimEvents`). It never makes or changes a person for them, so intake-06 and identity-04 still hold. `docs/data-model.md` now says so. The comment in the applied step `0001-project-store.sql` still says the old rule and cannot change.
2. **events-15 and numbers beyond 2^53.** `decodeBody` parses with `JSON.parse`, which rounds such numbers before the store sees them. events-17's rejection says large numbers are "stored as their JSON text". Keeping the digits would need a lossless JSON reader at intake. The contract keeps `JSON.parse`, so events-15 holds for values as JavaScript reads them.
3. **events-14's "last-seen time".** `persons` has no last-seen column. The person's latest event time is the greatest `ts` of its events, which cannot move back. The test reads it that way.
4. **A cookieless event with no `$host`.** The spec is silent. The contract hashes it with the empty host.
5. **Capture refusal bodies.** No behaviour fixes them. The contract answers JSON `{"error": "<one sentence>"}`.
6. **D-22's return type.** `ProjectStore.ingest` answers `Result<IngestAnswer, SchemaError | IngestError>`, not only `SchemaError`. cookieless-17 and events-13 fail a whole batch with 503, and a thrown error cannot be tested green in the pool (workers-sdk#7707), so both became values.
7. **The store's 100 bound parameters per statement.** `storedUuids` and `insertEvents` are written to it. A batch of up to 100 events is the SDKs' usual size, but node's queue flushes 100 and the browser's can be larger.
8. **intake-25's early refusal for gzip.** `sentLimit` lets a gzip or `text/plain` body through slightly above 20 MiB as sent, because gzip can grow incompressible data, so a body that decodes within the limit is never refused early.

## Audit answers (2026-10-21)

1. Accepted. Anonymous events join the person their id is linked to, as PostHog's identified-only mode does, and no person is made or changed for them.
2. Accepted. Numbers are kept as JavaScript reads them; a lossless reader is not worth its cost.
3. Accepted.
4. Accepted.
5. Changed. A capture refusal answers apiError's `{code, message}`, so every path has one error shape (`apps/worker/src/features/intake/http.ts`). No test pinned the old body.
6. Accepted, and D-22 now says so: a batch the store refuses is a value too.
7. Added: `apps/worker/src/features/events/ingest.test.ts` stores a batch of 250 events and its resend, so `storedUuids` and `insertEvents` must split their statements at 100 bound parameters.
8. Accepted.
