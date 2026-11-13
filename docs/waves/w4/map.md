# Wave 4 map

Wave 4 is the last Worker wave: the query slice and the privacy slice, with the daily sweep and the purge in `apps/worker/src/platform/sweep.ts` and the ProjectStore's alarm. Query answers the dashboard (`POST /api/projects/:id/query`) and a project's own backend (`POST /api/external/query`, with its secret key). Privacy deletes a person, pages a table out for the export command, and starts a deleted project's purge. This map tells each test node which behaviours it proves, in which file, through which signature or path. The signatures and their comments are frozen once the test nodes start (D-21).

## How the tests reach the code

Every test goes through one of these doors. Each fails today on an `unbuilt: <name>` error, which the red gate looks for.

| Door | Use it for | Fails today on |
|---|---|---|
| A pure function's input and output | `apps/worker/src/features/query/range.ts`, `validate.ts`, `cursor.ts`, `budget.ts`, `compile.ts`, the kinds' answer functions, `apps/worker/src/features/privacy/core.ts` | That function's marker |
| A fragment or a compiled query run in a real store: `inStore(id, (sql) => sql.exec(...))` for a `filters.ts` fragment, `runStatements(id, compiled)` for a kind's statements | What the SQL selects and counts: filters, exclusions, dimensions, buckets, funnels, cohorts | The compiler's marker, else `unbuilt: ProjectStore.runQuery` |
| A slice's or the platform's store function inside the object: `inStore(id, (sql, storage) => ...)` | `runCompiled`, `erasePerson`, `exportPage`, `sweep`, `purge`, `runAlarm`, with a bucket or registry the test chooses | That function's marker |
| An RPC call: `storeOf(id).runQuery(...)`, `.erasePerson(...)`, `.exportPage(...)`, `.schedulePurge(...)`; the alarm with `runDurableObjectAlarm(storeOf(id))` from `cloudflare:test` | What the Worker's routes and Cloudflare see | `unbuilt: ProjectStore.<call>` |
| A request through SELF with `dashboardHeaders(await dashboardJwt())`, or `fetchApp(appAt(() => now, mountQuery), request)` with a fixed clock, or `fetchApp(worker, request, bindings)` with a failing binding | Status, headers, body, what was read and what was left | The route's marker, such as `unbuilt: query.handleDashboardQuery` |

The helpers are in `apps/worker/test/helpers/`:
- `seed.ts` is new. `seedEvents(id, [{ ts, event, distinctId, personId, sessionId, bot, page, properties }])` writes event rows straight into a store, in order, and answers their ids. `seedPerson(id, distinctIds, properties)` writes an identified person and answers its id. `seedFixture(id, shape)` generates a fixture inside the object, each row a pure function of its index; its comment describes every column. `S1_FIXTURE` is spike S1's size: 2,000,000 events, 20,000 people, 395 days up to T0. It took 29 s on the owner's Mac, so a file seeds it once, in `beforeAll` with a timeout of 120 s. A smaller shape, such as `{ events: 10_001, persons: 50, days: 30, end: T0 }`, seeds in a moment.
- `query.ts` is new. `queryContext(overrides)` is a QueryContext at T0 in Europe/Oslo keeping 395 days with no rules. `resolved(range, timeZone, now, retentionStart)` resolves a range by the shared rules. `EVERY_EVENT` is a scope that selects every event. `runStatements(id, compiled)` runs compiled statements through the ProjectStore's `runQuery` and answers the rows.
- From earlier waves: `capture.ts` (`capture`, `jsRequest`, `ingestDirect`, `inStore`, `storeOf`, `storeRows`, `storedEvents`, `storedPersons`, `storeText`, `wasContacted`, `appAt`, `fetchApp`, `T0`, `DAY_MS`), `replay.ts` (`snapshotChunk` with its `meta` times, `snapshotsDirect`, `storedRecordings`, `storedChunks`, `storedPoints`, `r2Keys`), `registry.ts` (`seedProject({ id, deletedAt, settings })`, `newProjectId`, `newSecretKey`, `sha256Hex`), `access.ts` (`dashboardJwt`, `dashboardHeaders`, which carry the dashboard's Origin), `bindings.ts` (`poisoned`, `withoutStores`).

Rules for every test, besides those of waves 2 and 3:
- A store test that runs the alarm (`runAlarm`, `runDurableObjectAlarm`) seeds the project's registry row first with `seedProject({ id, settings })`: the alarm reads the settings from the registry and purges a store whose project has no row.
- Time is an argument everywhere in this wave except `ProjectStore.alarm()`, which reads `Date.now()`. Age rows relative to the `now` the test passes. To make an orphan R2 object old enough, pass a `now` more than an hour after it was written.
- A failing R2 delete is the real bucket wrapped in the test file: a Proxy over `env.RECORDINGS` whose `delete` throws for the keys the test names. `sweep`, `purge` and `erasePerson` take the bucket as an argument, so the test passes the wrapper to them inside `inStore`. A failing registry is `env.UNMIGRATED_REGISTRY`.
- A step of the sweep fails when its table is gone: drop it with `inStore` first, as wave 3 dropped `recordings` for recordings-17.
- A log line is caught by building the logger with `createLogger(sink)` from `apps/worker/src/platform/log.ts` and passing it to `runAlarm`, or to a Hono app the test builds with its own `deps`.
- A secret key that resolves is a row the test writes: `INSERT INTO secret_keys (hash, project_id, label, created_at)` with `sha256Hex(key)`.
- `resolveRange` moved to `packages/shared/src/range.ts`, with its tests. query-10, query-11, query-37 and query-40 are proven there for the range itself; this wave proves them again only through `prepareQuery` and the routes.

## t-query-a

Files: `apps/worker/src/features/query/{range,filters,validate,cursor,budget,compile,store,http}.test.ts`. `types.ts` holds types only, so it has no test file.

| ID | Test file | Under test |
|---|---|---|
| query-01 | `http.test.ts` | `/api/external/query` with project B's key: counts only B's events, though project A has events too; the same spec with a `project` key: 400; B's key as Bearer on `/api/projects/<A>/query` and `/api/projects/<B>/query`: 401 |
| query-02 | `filters.test.ts`, `compile.test.ts` | `filterSql` and `dimensionSql` of property names holding `'`, `"`, `.`, `[0]` and `); DROP TABLE events; --`: the name is in `params`, never in `sql`; run with `inStore` over seeded events, only the events holding that exact key match. `prepareQuery` of one spec of every kind: no property name, event name, value or ISO time in any statement's text, and the `?` count of each statement equals its params' length |
| query-05 | `range.test.ts` | `bucketsOf` day buckets over 28 to 30 March and 24 to 26 October 2026 in Europe/Oslo: the 29 March bucket is 23 hours, the 25 October bucket 25 |
| query-06 | `http.test.ts` | The hand-built client's visits: the external path, a trend of `$pageview` events by day for `last_days` 1 and 90: one value per day, counts as seeded |
| query-07 | `filters.test.ts`, `compile.test.ts`, `http.test.ts` | `exclusionsSql` with and without `includeBots`; `answerQuery`'s `meta.excluded.bots`; through the route, bot events left out unless `includeBots` |
| query-08 | `filters.test.ts`, `compile.test.ts`, `http.test.ts` | `exclusionsSql` with an event-property rule and a person-property rule: matching events left out, an event without the property or without a person kept, `applied` the rules' indexes, empty with `includeInternal`; `meta.excluded.internalRules`; through the route, with the rules set in the project's `internal_rules` |
| query-09 | `budget.test.ts` | `seedFixture(id, S1_FIXTURE)` once; each kind's spec through `prepareQuery` and `runStatements` over the whole 13 months: `rowsRead` at most `QUERY.rowsReadBudget` |
| query-11 | `http.test.ts` | `between` with `from` equal to `to`, after `to`, and before 1970: 400 and `wasContacted` false |
| query-12 | `compile.test.ts`, `store.test.ts` | `answerQuery`'s meta: ISO UTC `from` and `to`, time zone, exclusions, `rowsRead` as the store gave it; `runCompiled` of two statements: `rowsRead` is the sum of each run alone |
| query-13 | `budget.test.ts` | the budget test's cases cover every entry of `QUERY_KINDS`, and every answer's `meta.rowsRead` is a number |
| query-14 | `compile.test.ts`, `http.test.ts` | `prepareQuery` with no `timeZone` uses `projectTimeZone`, and a named one wins; through the route, `"Mars/Olympus"`: 400 with an issue at `/timeZone`, `wasContacted` false |
| query-15 | `range.test.ts` | `bucketsOf`: an instant at 23:30 UTC lies in the next local day's bucket in Europe/Oslo and in the same day's bucket in America/New_York |
| query-17 | `http.test.ts` | a seeded project with no events: one spec of every kind answers 200 with its empty result and the full range, time zone and exclusions |
| query-18 | `validate.test.ts`, `http.test.ts` | `parseSpec` with an unknown key, a wrong type and a missing field: the first issue's path; through the route, 400 with the code and issues, `wasContacted` false |
| query-19 | `http.test.ts` | GET: 405; a body that is not JSON: 400; an empty body: 400; `text/plain`: 415; `wasContacted` false each time |
| query-25 | `validate.test.ts`, `http.test.ts` | 1 and 11 steps, a missing, zero, negative and fractional `windowMs`: issues; 2 and 10 steps pass; through the route, 400 before the store is contacted |
| query-26 | `validate.test.ts` | two steps with the same event and different ids pass; a repeated id and an id with a space: issues at the step |
| query-27 | `validate.test.ts` | a step whose `event` is a list, and a step condition on a person property: an issue at that step |
| query-31 | `budget.test.ts`, `compile.test.ts` | `checkBudget` at 100 and 101 parameters, and at `QUERY.sqlBytes` and one byte more; `prepareQuery` of a spec whose filters bind more than 100 parameters: an issue with code `too_many_parameters` |
| query-33 | `range.test.ts` | hour buckets: an instant 1 ms before a boundary is in the earlier bucket, one at the boundary in the later; a three-hour range has three buckets and its end belongs to none |
| query-34 | `range.test.ts` | week buckets start on Monday 00:00 local, the first cut to the range |
| query-35 | `range.test.ts` | month buckets are calendar months: February 2026 is 28 days, March 31 |
| query-36 | `http.test.ts` | `between` with a date and no time: 400; a `from` with an offset: the answer's `meta.range.from` is its UTC instant |
| query-37 | `compile.test.ts` | `prepareQuery` twice with one context gives equal ranges and statements |
| query-38 | `range.test.ts` | `previousPeriod` of yesterday, of today until 10:00, and of the last 7 days |
| query-39 | `range.test.ts`, `compile.test.ts` | `bucketsOf` with exactly 512 hour buckets passes, 513 is "too many buckets"; `prepareQuery` with `compare` whose two periods have different bucket counts: an issue at `/compare`; with 513 buckets: code `too_many_buckets` |
| query-40 | `compile.test.ts`, `http.test.ts` | `prepareQuery` with a range before `retentionStart`: the range is clipped and `answerQuery`'s `meta.requested` holds the asked range; the same through the route |
| query-47 | `validate.test.ts` | `{ builtin: "city" }`: an issue; `{ property: { of: "event", name: "anything" } }` passes |
| query-48 | `cursor.test.ts` | `encodeCursor` then `decodeCursor` gives the key back; `fingerprint` is the same for keys in another order and with or without `cursor`, and differs for another limit |
| query-49 | `cursor.test.ts`, `http.test.ts` | text that is not base64url, base64url that is not JSON, a cursor of another fingerprint: "invalid cursor"; through the route, 400 `invalid_cursor` |
| query-50 | `validate.test.ts`, `filters.test.ts` | a `contains` term of 51 UTF-8 bytes in fewer characters: an issue; 50 bytes pass; `likePattern` escapes `%`, `_` and `\`; `contains` of `"50%"` matches `"50% off"` and not `"500 off"` |
| query-52 | `filters.test.ts` | `eq` 2 matches the number 2 and not the string "2" |
| query-53 | `filters.test.ts` | `neq` and `notIn` match no event whose property is missing |
| query-54 | `filters.test.ts` | each of `exists`, `notExists`, `isNull`, `isEmpty`, `notNull` over missing, JSON null, `""`, `[]`, `{}` and a value |
| query-55 | `filters.test.ts` | `contains`, `startsWith` and `endsWith` never match a number |
| query-56 | `filters.test.ts`, `validate.test.ts` | `between` includes both ends; a reversed pair: an issue |
| query-57 | `filters.test.ts` | a property name is case-sensitive; `dimensionSql` lower-cases `referring_domain` and trims `utm_campaign` |
| query-58 | `filters.test.ts` | `eq false` does not match a stored 0, `eq 0` does not match false |
| query-59 | `validate.test.ts`, `http.test.ts` | a filter nested 9 deep: an issue, 8 deep passes; `in` with 101 values: an issue; a body over 100 KB: 413 before parsing, `wasContacted` false |
| query-60 | `filters.test.ts`, `http.test.ts` | with no filter and nothing included, every event in the range but bots and internal traffic is counted |
| query-61 | `http.test.ts` | a body over `QUERY.bodyBytes` with Content-Length, and the same as a stream without it: 413 |
| query-73 | `http.test.ts` | a dashboard and an external answer carry `Cache-Control: private, no-store` |
| query-126 | `http.test.ts` | every kind's spec, asked on `/api/projects/<id>/query` and on `/api/external/query` with the project's key, answers equal bodies |
| platform-07 | `http.test.ts` | a secret key as Bearer on the dashboard query path: 401, nothing read |
| platform-09 | `http.test.ts` | `/api/external/query` with an Access JWT, a public token, Basic auth and a revoked key: four 401s with identical bodies |
| platform-11 | `http.test.ts` | a preflight on both query paths: no allow-origin header, whatever the origin |
| platform-34 | `validate.test.ts`, `http.test.ts` | an unknown kind: code `unknown_kind`, its message lists the kinds; a 4xx body is JSON with one sentence naming the bad input |
| platform-35 | `store.test.ts` | `runCompiled` of a statement SQLite refuses: an error value naming the statement, no throw |
| platform-42 | `http.test.ts` | the registry failing (`UNMIGRATED_REGISTRY` through `fetchApp`): 503 `unavailable` with one fixed sentence |

## t-query-b

Files: `apps/worker/src/features/query/{trend,top,funnel,retention,scroll,events-list,properties}.test.ts`. Each test compiles with the kind's compiler, runs with `runStatements` over rows from `seedEvents` and `seedPerson`, and reads the kind's answer function. Buckets come from `bucketsOf` and ranges from `resolved`; scopes are `EVERY_EVENT` unless the test is about exclusions.

| ID | Test file | Under test |
|---|---|---|
| query-02 | `trend.test.ts` | a breakdown by the property `it's "x"`: the name is a parameter, and only events holding that key give its values |
| query-03 | `funnel.test.ts` | A then B by one person, B then A by another: only the first converts |
| query-04 | `funnel.test.ts` | window one hour: B two hours after A does not convert; B exactly one hour after does |
| query-15 | `trend.test.ts` | a day trend with one event at 23:30 UTC: the next day's bucket in Europe/Oslo, the same day's in America/New_York |
| query-16 | `trend.test.ts` | every bucket present in order, 0 where nothing happened |
| query-20 | `trend.test.ts`, `retention.test.ts` | the compiled SQL compares bucket numbers as `CAST(? AS INTEGER)` |
| query-21 | `funnel.test.ts` | two steps on one event name: one event gives [1, 0], two give [1, 1] |
| query-22 | `funnel.test.ts` | an unused earlier event does not block a later one |
| query-23 | `funnel.test.ts` | two matching events at the same ts: the earlier stored wins |
| query-24 | `funnel.test.ts` | the window runs from the entry, so a third step within the window of step 2 but not of the entry does not count |
| query-28 | `funnel.test.ts` | counts, rates, drop-offs, the overall rate, the largest drop-off, and the earlier step on a tie |
| query-29 | `funnel.test.ts` | no one at step 1: counts 0, every rate and `largestDropOff` null |
| query-30 | `funnel.test.ts` | an event with no person counts at no step |
| query-32 | `funnel.test.ts` | `compileFunnel` gives one statement |
| query-41 | `trend.test.ts` | visitors: one person in two buckets counts in each, and once in the total |
| query-42 | `trend.test.ts` | `measure: "sessions"`: a session with events in two buckets counts once, in the first |
| query-43 | `trend.test.ts` | `relativeChange(0, 0)` is 0, `(0, 1)` null, `(2, 3)` 0.5; a compared series' `change` |
| query-44 | `trend.test.ts` | compare with a breakdown: a key only in the previous period is kept, and the order is by absolute change |
| query-45 | `trend.test.ts` | `breakdownLimit` 2 with four keys: two series and an "Other" series whose values are the rest's sums |
| query-46 | `trend.test.ts`, `top.test.ts` | null, missing and blank values share the key null; `$direct` is `DIRECT`; a campaign value is trimmed; `"Unknown"` is its own key |
| query-47 | `top.test.ts` | a property dimension of any name |
| query-48 | `top.test.ts`, `events-list.test.ts` | no `OFFSET` in the SQL; equal counts in key order; equal ts in id order |
| query-49 | `top.test.ts`, `events-list.test.ts` | a cursor of another spec: "invalid cursor" |
| query-51 | `properties.test.ts` | names, JSON types and counts, a name holding two types listed with both |
| query-62 | `retention.test.ts` | a cohort starts at a person's first counted event ever; every period from 0 present, zeros and a rate of 0 included; rate is people over size |
| query-63 | `retention.test.ts` | named start and return events, bots and internal traffic left out of both; the trailing bucket with no return period is left out |
| query-64 | `top.test.ts` | top pages grouped by page key, by count |
| query-65 | `top.test.ts` | equal counts of referrers in a stable order |
| query-66 | `top.test.ts` | countries as two-letter codes |
| query-67 | `top.test.ts` | devices Mobile, Tablet and Desktop |
| query-68 | `top.test.ts` | browser versions of Chrome only, by major number |
| query-69 | `top.test.ts` | campaigns by `utm_campaign`, a missing value its own row |
| query-70 | `top.test.ts`, `events-list.test.ts` | page 1 then page 2 by `nextCursor`: every row once, none skipped; the last page has no `nextCursor` |
| query-71 | `top.test.ts` | an event with no page key is the null row, never an empty-path row |
| query-72 | `top.test.ts`, `trend.test.ts` | visitors: a person with two ids and a cookieless hash each count once |
| events-15 | `events-list.test.ts` | `answerEvents` gives back properties with every type as stored |
| heatmaps-03 | `scroll.test.ts` | the share of views reaching each tenth; exactly 0.1 reaches the first |
| heatmaps-16 | `scroll.test.ts` | a `$pageview`'s `$prev_pageview_*` count for the previous path, not the new one |
| heatmaps-17 | `scroll.test.ts` | a `$prev_pageview_id` seen twice counts once; no id, or `$prev_pageview_disable_scroll_properties`, adds no view |
| heatmaps-18 | `scroll.test.ts` | bots and internal events left out, through a scope from `exclusionsSql` |

## t-privacy

Files: every test under `apps/worker/src/features/privacy/` (`core.test.ts`, `ingest.test.ts`, `http.test.ts`), and `apps/worker/src/platform/sweep.test.ts`. `ingest.test.ts` holds the tests through `erasePerson`, `exportPage` and `ingestDirect`, as earlier waves named theirs.

| ID | Test file | Under test |
|---|---|---|
| privacy-01 | `sweep.test.ts` | 105 events past the events cutoff and 2 inside: `sweep` with `batchRows` 1,000 deletes 105 and reports 105; with `batchRows` 40, three passes report 40, 40 and 25 |
| privacy-02 | `ingest.test.ts`, `http.test.ts` | `erasePerson` of a person with two ids: events, ids and person gone in one call, counts per table; the route answers the counts |
| privacy-03 | `sweep.test.ts` | `purge` of a project with R2 objects, rows and its registry row: the prefix empty, `storeText` empty, the D1 rows gone, `{ finished: true }`; the alarm of a project marked deleted 2 minutes ago does the same through `runDurableObjectAlarm` |
| privacy-04 | `sweep.test.ts` | a person whose events all expired is deleted; a person with a recording stays; a person with neither is deleted |
| privacy-05 | `ingest.test.ts` | `erasePerson` of a person with recordings and points: the rows and the R2 objects gone |
| privacy-06 | `sweep.test.ts` | two events 1 ms either side of the cutoff by their own ts, one received recently: the older goes |
| privacy-07 | `sweep.test.ts` | the project's `events_retention_days` lowered in the registry: the next `runAlarm` deletes the newly expired |
| privacy-08 | `sweep.test.ts` | after a sweep, no `person_distinct_ids` row and no `events.person_id` names a missing person |
| privacy-09 | `ingest.test.ts` | the salt stored is the bytes `makeSalt` gave (`fixedSources`). Passes already. |
| privacy-10 | `ingest.test.ts` | a new day's salt deletes expired ones in its batch, at most three exist. Passes already. |
| privacy-11 | `sweep.test.ts` | the expired salt's `cookieless_sessions` rows go with it |
| privacy-12 | `sweep.test.ts` | a recording's age is its `end_ts`: one ending before the recordings cutoff goes, objects and rows, one ending after stays |
| privacy-13 | `sweep.test.ts` | three chunks, one key's delete failing: that chunk's row and its recording stay, the other two chunks go, the outcome names the step failed; the next sweep with the real bucket finishes |
| privacy-14 | `sweep.test.ts` | points 89 and 91 days old with 90 days' retention: the older goes |
| privacy-15 | `core.test.ts` | `RECORDINGS_LIFECYCLE` deletes at 400 days, above the 365 that `projectSettings` allows. Passes already. |
| privacy-16 | `ingest.test.ts` | events of the id whose `person_id` is null are deleted too |
| privacy-17 | `ingest.test.ts`, `http.test.ts`, `core.test.ts` | an unknown id and a repeat: every count 0; the route answers 200; `eraseAnswer` |
| privacy-18 | `http.test.ts` | the id only in the query string: 400; a logger built with `createLogger(sink)` sees no line holding the id |
| privacy-19 | `ingest.test.ts`, `core.test.ts` | `erasePerson` with a failing delete: the error names the key, no row deleted; again with the real bucket, it finishes; `eraseAnswer` of "r2 failed" is 502 `delete_failed` |
| privacy-20 | `sweep.test.ts`, `http.test.ts` | `runAlarm` 30 s after the mark deletes nothing and sets the alarm to mark + 60 s; at mark + 60 s it purges; the purge route answers 202 with that time, 409 for a project not marked, 404 for an unknown one |
| privacy-21 | `sweep.test.ts` | `purge` with `maxKeys` below the object count: `{ finished: false }` and no row touched, then finished; `purge` with `UNMIGRATED_REGISTRY` stops after the wipe, then with `REGISTRY` finishes; nothing deleted twice |
| privacy-22 | `http.test.ts` | the export route for each of `EXPORT_TABLES`: 200; for `salts` and `cookieless_sessions`: 404. The files half is the export command's (Deferred). |
| privacy-25 | `ingest.test.ts`, `http.test.ts` | 10,001 events from `seedFixture`: `exportPage` gives 10,000 lines and a `next`, then 1 line and `next` null; the route the same |
| privacy-26 | `http.test.ts`, `sweep.test.ts` | events captured with CF-Connecting-IP, X-Forwarded-For and `$ip`: no export line holds an address; the sweep's log line holds none |
| privacy-27 | `sweep.test.ts` | more expired rows than `batchRows`: `leftRows`, the alarm set to now + `NEXT_PASS_MS`, and over the passes each row deleted once |
| platform-27 | `sweep.test.ts`, `ingest.test.ts` | after `runAlarm` that finished, the alarm is now + `DAY_MS`; after one that left rows, now + `NEXT_PASS_MS`; an `erasePerson` RPC to a store with no alarm sets one |
| platform-28 | `sweep.test.ts` | a store with nothing left: `runAlarm` drops the alarm; the next `ingestRpc` sets one |
| platform-29 | `sweep.test.ts`, `core.test.ts` | one `sweep` log line with a count per step in `SWEEP_ORDER` and no row content; `sweepSummary` |
| platform-30 | `sweep.test.ts` | `heatmap_points` dropped: the other steps still delete, the line names the failed step and its message, `runAlarm` answers "sweep failed", and `runDurableObjectAlarm` rejects |
| platform-31 | `sweep.test.ts` | `runAlarm` twice at the same now: the second deletes nothing and answers ok |
| platform-33 | `core.test.ts` | `deletePlan`: the five steps in order, each with its undo text, naming the project. The printing command is wave 6's (Deferred). |
| projects-21 | `sweep.test.ts` | the row stays marked until the purge removes it |
| recordings-06 | `sweep.test.ts` | an object under the project's prefix with no row is deleted when older than an hour and kept when younger; 2,501 orphans take two passes, the first `leftRows`; another project's objects stay |
| recordings-17 | `sweep.test.ts` | the orphan wave 3 left with `recordings` dropped is deleted by the sweep after the hour; the recordings step fails, the orphan step still runs |
| cookieless-04 | `sweep.test.ts` | `runAlarm` at (D+1) 12:00 UTC deletes D's salt, at 11:59:59.999 it does not |
| events-09 | `sweep.test.ts` | `runAlarm` keeps today's and yesterday's counter rows and deletes older ones (`counterKeepFrom`) |
| events-12 | `sweep.test.ts` | a store whose batch `ingestDirect` refused as full (`STORE_GUARD_BYTES`) is still swept |

## Deferred

| Behaviour | Why |
|---|---|
| privacy-22, files half; privacy-23; privacy-24 | They are about the files the export command writes: one per table, a second export beside the first, no partial file left. The command is wave 6's operations work (`docs/build-plan.md`, section 5). This wave builds the pages it reads (privacy-25). |
| platform-33, printing half | The delete command that prints `deletePlan` in dry-run mode is wave 6's, with the other operations. The plan is in this wave. |
| platform-36 | workerd runs every test in UTC, so a Worker test cannot vary the process time zone. The range code reads no process zone: `resolveRange`, `wallClockAt` and `localMidnight` live in `packages/shared`, whose tests run in Node. See question 9. |
| heatmaps-20 | It runs the real posthog-js in a browser: the compatibility suite (`docs/engineering.md`, "Real SDKs"), not a Worker wave. heatmaps-03 and heatmaps-16 to heatmaps-18 prove the server's half. |
| config-29; the SDK halves of config-03, config-05 and config-09 | Unchanged from wave 3: the compatibility suite's. |

Nothing else that waves 2 and 3 deferred to this wave is left out: recordings-06, the sweep half of recordings-17, the scroll depth lines, and the alarm halves of cookieless-04, events-09 and events-12 are mapped above.

## Fill split

Each fill worker owns these files and passes these tests. The gate is `pnpm wave:gate fill <own files> --tests <test files>`. Three fills write bodies in `apps/worker/src/platform/project-store.ts`, so they run one after another.

| Fill | Owns | Passes | Needs first |
|---|---|---|---|
| f-query-core | `apps/worker/src/features/query/range.ts`, `filters.ts`, `validate.ts`, `cursor.ts`, `budget.ts` | `query/{range,filters,validate,cursor}.test.ts` | nothing |
| f-query-store | `apps/worker/src/features/query/store.ts`, and the body of `ProjectStore.runQuery` | `apps/worker/src/features/query/store.test.ts` | nothing |
| f-privacy-tables | the wave 4 functions of `apps/worker/src/features/events/store.ts`, `apps/worker/src/features/identity/store.ts`, `apps/worker/src/features/heatmaps/store.ts` and `apps/worker/src/features/recordings/store.ts`; `apps/worker/src/features/privacy/core.ts`; `erasePerson` and `exportPage` in `apps/worker/src/platform/ingest.ts`; the bodies of `ProjectStore.erasePerson` and `ProjectStore.exportPage` | `apps/worker/src/features/privacy/core.test.ts`, `apps/worker/src/features/privacy/ingest.test.ts` | f-query-store |
| f-query-kinds-a | `apps/worker/src/features/query/trend.ts`, `top.ts`, `events-list.ts`, `properties.ts` | their four tests | f-query-core, f-query-store |
| f-query-kinds-b | `apps/worker/src/features/query/funnel.ts`, `retention.ts`, `scroll.ts` | their three tests | f-query-core, f-query-store |
| f-sweep | `apps/worker/src/platform/sweep.ts`, and the bodies of `ProjectStore.schedulePurge` and `ProjectStore.alarm` | `apps/worker/src/platform/sweep.test.ts` | f-privacy-tables |
| f-query-http | `apps/worker/src/features/query/compile.ts`, `apps/worker/src/features/query/http.ts` | `query/{compile,http,budget}.test.ts` | f-query-core, f-query-kinds-a, f-query-kinds-b |
| f-privacy-http | `apps/worker/src/features/privacy/http.ts` | `apps/worker/src/features/privacy/http.test.ts` | f-sweep |

f-query-core and f-query-store run side by side, then the kinds and f-privacy-tables. `budget.test.ts` runs every kind at real size, so it passes only with f-query-http.

The close node then:
- removes unbuilt.ts (now gone), and with it `app.onError(surfaceUnbuilt)` in `apps/worker/src/index.ts`, once no marker is left;
- adds to `scripts/guard-proof.test.mjs` the checks this wave brings: the external path's secret key check (query-01, platform-09), and the Access check on the query and privacy routes (platform-07);
- updates the row of `docs/engineering.md` for a project reading another's data, which query-01 now guards for the query routes;
- runs `pnpm check`, and measures the test commands again for `CLAUDE.md`, the real-size budget test included.

## Questions for the audit

1. **A project is deleted in two requests.** `DELETE /api/projects/:id` (wave 1) marks it, and `POST /api/projects/:id/purge` (privacy) brings the store's alarm forward to the mark plus 60 s. The purge could start from the delete itself, but `handleDelete` is built and its tests (projects-21) would meet a marker in this wave. Either way, every alarm reads the project's registry row, so a store whose project is marked deleted purges at its next alarm even if nobody asks. I recommend folding the purge request into `handleDelete` once wave 4 lands, so the dashboard sends one request.
2. **The purge keeps `store_meta` until the D1 rows are gone.** privacy-03's order is R2, then the store, then D1. If the store were cleared with `deleteAll()` before D1, a failure at the D1 step would leave registry rows and a store that no longer knows its project. So the wipe deletes every row but `store_meta`, D1 goes next, and `deleteAll()` comes last. A rerun finds an empty prefix, no rows, and D1 rows to remove.
3. **privacy-19's "nothing is deleted" means no row.** R2 objects whose delete succeeded before another failed are gone. Their chunk rows stay, so playback of that recording answers 502 `chunk_missing` until the repeat finishes the deletion.
4. **The orphan sweep lists the project's prefix, not each session's.** recordings-06 names "the session's prefix with its final slash". An orphan whose session has no row at all, as when the first chunk's row write fails (recordings-17), belongs to no known session. So the contract lists `<project>/`, with its final slash, and asks `recording_chunks` about each key.
5. **A failed R2 delete fails the sweep's step.** privacy-13 keeps the rows of a failed delete and says the next sweep finishes. The contract counts the step as failed, so the alarm throws and Cloudflare's retry runs it again, as platform-30 asks for any failed step.
6. **Trends gained a `sessions` measure.** query-42 counts sessions, and `trendSpec` had only events and visitors. A session counts once, in the bucket of its first event in the period. This is a change to `packages/shared`.
7. **Trend series gained `change`.** query-43 and query-44 need a relative change per key, and `TrendSeries` had none.
8. **The real-size budget test costs about 30 s per run.** query-09 needs 2,000,000 events, and seeding them took 29 s on the owner's Mac. It runs in one file, in parallel with the others, but `pnpm test`'s measured time in `CLAUDE.md` will grow. Moving it to its own command that CI runs would keep the everyday suite fast.
9. **platform-36 cannot be tested in workerd.** The process time zone there is always UTC. A Node test in `packages/shared` could set `process.env.TZ` to UTC, America/New_York and Asia/Tokyo around `resolveRange`, but no test node owns that file. `bucketsOf` runs in the Worker and reads no process zone, since it builds on `wallClockAt` and `localMidnight`.
10. **`rowsRead` is never null in practice.** query-12 asks for null "when a statement did not report", but a Durable Object's SQL cursor always reports. The type keeps null.
11. **A retention cohort is the range's buckets only.** D-20 starts a cohort at a person's first counted event ever. A person whose first event falls before the range is in no cohort of this answer.
12. **A funnel's steps all fall within the range.** No line says whether a step after the range's end counts. The contract reads only events in the range, so an entry near the end converts less often.
13. **The purge and erase routes need the dashboard's Origin.** They change state, so `requireSameOrigin` applies (projects-26). The wave 6 delete and export commands must send it. The export route only reads, so it does not.
14. **A deleted project's export is 404,** as on every other dashboard route. Exporting before the purge means exporting before the delete.
15. **`prunePersons` reads `events` and `recordings` inside identity's SQL.** A person goes when no event and no recording refers to them, and splitting that into three slices' queries would mean passing every candidate id between them. It only reads.
16. **The export key is SQLite's rowid.** Every table has one, `person_distinct_ids` and `recordings` included, whose keys are text. Paging by rowid lets one shape serve all six tables.
17. **A store whose schema cannot serve neither sweeps nor purges.** Its alarm logs and moves a day on, since the newer code that wrote its schema will sweep it.

## Audit answers

Claude's audit of the tests, on 2026-10-21, before the fills.

- **Q1.** Accepted for now. Once wave 4 lands, the purge request folds into `handleDelete`, test first, so the dashboard sends one request.
- **Q8.** Done. The query-09 and query-13 size tests moved to `budget.size.test.ts`. `pnpm test` leaves them out, and `pnpm test:size` runs them as a step of `pnpm check`, so CI still runs them.
- **Q9.** Done. platform-36 is a Node test in `packages/shared/src/range.test.ts` that sets the process zone to UTC, America/New_York and Asia/Tokyo around `resolveRange`, and checks that the zone took effect.
- **Q2 to Q7 and Q10 to Q17.** Accepted as written.
- **Retention.** An empty cohort's rate is null, not 0, since D-20 makes a ratio with a zero denominator null. `RetentionResult` and query-62 say so.

Faults the audit fixed in the tests, each worked out by hand:

- `range.test.ts`: query-34's empty week, and query-38's two `to` times, which mixed UTC and Oslo time.
- `filters.test.ts`: query-08 keeps the second internal event, which no rule matches.
- `top.test.ts`: query-67's title now says what the test checks.
- `retention.test.ts`: the empty cohort's rate, above.
- `sweep.test.ts` and `apps/worker/src/features/privacy/http.test.ts`: a test's "now" is often behind the wall clock, and workerd fires an alarm set in the past at once, so the real `ProjectStore.alarm` would have run beside the test. `runAlarmAt` now reads and deletes the alarm in the same object call that set it, and answers its value. The privacy-20 route test marks its project at the wall clock.
- `types.test.ts` tested `runCompiled`, which `store.test.ts` owns, and no fill ran it. Its test moved into `store.test.ts`.
- `refusingDeletes`, `asRecord` and ten copies of `isRecord` each have one home now: `apps/worker/test/helpers/replay.ts`, `apps/worker/test/helpers/json.ts` and the shared `isJsonObject`.

Added by the audit:

- **query-126.** The dashboard path and the external path answer every kind's spec with equal bodies (from the harvest check of flarelytics).
- **The alarm handler.** The compatibility suite found that workerd refuses `setAlarm` on a class with no `alarm()`, which the test pool does not enforce. privacy-03's alarm test and platform-30 run the real `ProjectStore.alarm` through `runDurableObjectAlarm`, so a missing handler fails them.
- **`cutoffsOf`** names intake's `retentionStart`, so the sweep, intake and the query clip share one rule.
