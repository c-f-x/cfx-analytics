# Decisions

One entry per decision. A decision is never changed in place; a later entry supersedes it.

## D-1 · Build our own from harvested parts, not a fork · accepted (2026-10-19)

**Context.** We want PostHog's core uses on Cloudflare for all of the owner's projects. No existing project fitted as a base to own.

**Decision.** Write cfanalytics ourselves. Take parts and test ideas from five MIT projects at pinned commits (`docs/donors.md`). Nothing is taken from a project without a licence.

**Consequences.** We own all of the code. Copied MIT code keeps its copyright notice in `THIRD_PARTY_NOTICES.md`, added in the same change as the code. No upstream merges.

## D-2 · Accept PostHog's intake protocol; our own query API · accepted (2026-10-19)

**Context.** PostHog's SDKs are MIT and mature: posthog-js, posthog-node, and posthog-ios, which also runs on macOS. The hand-built client already builds PostHog-shaped events by hand (`core/analytics/capture.ts` in the hand-built client).

**Decision.** The intake accepts what these SDKs send, unchanged, on PostHog's paths (`/i/v0/e/`, `/e/`, `/capture/`, `/batch/`), including PostHog's cookieless mode. Reading data uses our own small query API, not HogQL.

**Consequences.** We write no SDKs. Moving a project over is a change of host. The hand-built client's one HogQL call (`visitsQuery`, page views a day) moves to our query API. What "compatible" means is fixed by tests that run the real SDKs against our Worker. Hogflare's tests can't be used for that, because it has no licence.

## D-3 · One SQLite Durable Object per project, in the EU · accepted, pending spike S1 (2026-10-19)

**Context.** Analytics Engine keeps data three months, samples, cannot delete a row and has no joins. Basin cannot use EU-jurisdiction buckets, its SQL cannot delete a row, and data arrives one to five minutes late. D1 would put every tenant in one database, guarded only by a WHERE clause.

**Decision.** Each project's events, people and settings live in its own SQLite-backed Durable Object, created in the `eu` jurisdiction. It is the system of record.

**Consequences.** Isolation is physical: no query can reach another project. Ordered funnels and retention use SQLite window functions. A deletion request is a transaction we control. One object can hold 10 GB, about ten million events at 1 KB, which the retention rule keeps us under. Spike S1 in `docs/build-plan.md` can overturn this decision.

## D-4 · A small D1 registry for projects and keys · accepted (2026-10-19)

**Decision.** One D1 database holds the list of projects, their public tokens and hashed secret keys, and nothing about events. The intake looks a token up there before it reaches a project's object. Answers are cached in the Cache API for 60 seconds, never in module state.

**Consequences.** An unknown token is refused at the edge and creates no object. Turning a key off takes effect within a minute.

## D-5 · Dashboard behind Cloudflare Access; machine reads with per-project keys · accepted (2026-10-19), its Access half superseded by D-27

**Decision.** The dashboard and its API sit behind Cloudflare Access with the owner's account. Projects that read their own numbers, such as a product's own admin panel, use a per-project secret key as a Bearer token. Only its hash is stored.

**Consequences.** cfanalytics has no passwords and no sign-in code. A secret key reads one project and nothing else.

## D-6 · Same stack and habits as cfmail · accepted (2026-10-19)

**Decision.** TypeScript, pnpm, Hono, React with Vite, Tailwind and shadcn/ui, TanStack Router and Query, Vitest with the Workers pool, Biome and oxlint. No ORM: each query is one typed function with bound parameters. CI runs on the owner's Mac, as for cfmail (its decision D-6).

**Consequences.** Anyone who has worked on cfmail knows the tools. Fewer dependencies than cfmail, because there is no Drizzle and no Better Auth.

## D-7 · Vertical slices with a pure core · accepted (2026-10-19)

**Decision.** Code is grouped by feature under `apps/worker/src/features/<slice>/`, never by layer. Each slice keeps pure logic, its SQL, and its HTTP routes in separate files, and its tests sit beside them. A check script fails the build when a slice imports another slice's internals or when pure files import I/O. `docs/architecture.md` has the slice list and the rules.

## D-8 · What version 1 does, and what it does not · accepted (2026-10-19)

**In.** Event intake (single, batch, gzip and base64 bodies), including posthog-js autocapture and page-leave events. The remote-config answer posthog-js asks for on load, telling it that recording and heatmaps are off. People: identify, alias, `$set`, `$set_once`, and anonymous events with `$process_person_profile: false`. Cookieless counting by a daily-salted server hash. Projects and keys. Query API and dashboard: trends with breakdowns, unique users, top pages, referrers and countries, ordered funnels with a time window, and retention cohorts. Per-project data retention, deletion by person, and export.

**Out of version 1.** Session replay, heatmaps, feature flags, error tracking, surveys, experiments, HogQL. The hand-built client needs none of them. The posthog-js site has replay and heatmaps switched on, so they are the first candidates for version 2: replay chunks in R2 with rrweb-player (MIT), heatmaps from the events posthog-js already sends.

**Open for the owner.** Whether the posthog-js site moves in version 1 without replay and heatmaps, or waits for version 2.

## D-9 · Data has a lifetime · accepted (2026-10-19)

**Decision.**
- Each project keeps raw events for 13 months by default. The project's own object deletes older rows on a daily alarm.
- A person with no remaining events is deleted.
- The cookieless salt for a day is deleted once the day is over in every time zone.
- Deleting a project deletes its object's storage.
- Backups are the Durable Objects' 30-day point-in-time recovery plus a manual export script, as in cfmail.

**Consequences.** Every table states its lifetime in `docs/architecture.md`. A test checks each rule.

## D-10 · One shared deployment for all projects · accepted (2026-10-19)

**Decision.** One Worker serves every project, as cfmail does (its D-8). A project may get its own intake host name on its own domain, such as `e.<domain>`, which helps against ad blockers. The project comes from the token, not the host.

**Open for the owner.** The dashboard's home domain.

## D-11 · One continuous build, with recordings and heatmaps · accepted (2026-10-19)

Supersedes D-8.

**Context.** D-8 split the work into a version 1 and a version 2. The owner's direction: there are no versions or stages. The architecture is planned in full and built continuously.

**Decision.** The scope is everything a consuming project used on 2026-10-19:
- event intake, including posthog-js autocapture and page-leave events
- the remote-config answer, built from each project's settings
- people and cookieless counting
- projects and keys
- trends, breakdowns, top lists, ordered funnels, retention and scroll depth
- session recording, with storage and a player
- click, rage-click and scroll heatmaps
- retention sweeps, deletion by person, and export

Feature flags, error tracking, surveys, experiments and HogQL are not built, because no consuming project uses them. A project that needs one brings a new decision.

**Consequences.** The posthog-js site moves with recording and heatmaps intact. The order of work in `docs/build-plan.md` is a sequence of dependencies, not a set of releases.

## D-12 · Tests run on the real runtimes, with no stand-ins · accepted (2026-10-19)

**Context.** One donor's tests ran against a SQLite stand-in for D1. A stand-in can drift from the thing it replaces.

**Decision.** Code that touches SQL, R2 or a ProjectStore is tested in the Workers test pool against real local Durable Objects, D1 and R2. Pure files are tested in plain Node. The SDK tests use the real SDKs.

**Consequences.** No contract test is needed for a stand-in, because there is none. The Workers pool is slower than an in-memory database, so the suite's time is measured and kept in `CLAUDE.md`.

## D-13 · Recordings live in R2, indexed in the ProjectStore · accepted (2026-10-19)

**Context.** Recording chunks run from tens of kilobytes to several megabytes. A ProjectStore row may hold at most 2 MB, and one object holds at most 10 GB.

**Decision.** Chunk bodies go to an R2 bucket in the `eu` jurisdiction. The ProjectStore keeps one row per chunk and one per recording, and it is the only writer of both, so the daily byte cap has one owner. Input values are replaced with asterisks at intake, whatever the client masked.

**Consequences.** A crash between the R2 write and the row write leaves an orphan object. The retention sweep removes it. Heatmaps draw on full snapshots taken from these recordings, so a page needs at least one recording to show behind its heatmap.

## D-14 · Intake hosts and the dashboard host are separate · accepted (2026-10-19)

**Decision.** SDKs and project backends reach intake host names with no Access in front. The dashboard has its own host name, guarded by Cloudflare Access. The Worker also verifies the Access JWT on every dashboard path, so a missing Access rule exposes nothing.

## D-15 · We serve the SDK's lazy scripts from one pinned posthog-js version · accepted (2026-10-19)

**Context.** posthog-js loads session recording, dead clicks and web vitals as separate scripts from `api_host/static/`. It asks for its own version's path first and falls back to an unversioned one (`docs/spec/posthog-protocol.md`, section 11).

**Decision.** cfanalytics pins one posthog-js version and serves that version's lazy scripts at its versioned path and at the unversioned path. Other versioned paths answer 404, so the SDK falls back to the unversioned script.

**Consequences.** A consuming project pins the same posthog-js version as cfanalytics, and the two are upgraded together. A project on another version still loads our scripts through the fallback, and the compatibility tests are what show whether that pairing works.

## D-16 · One central dashboard; projects read their own numbers through the API · accepted (2026-10-19)

**Context.** The owner asked whether each project should get its own admin dashboard, whether a shared dashboard package should be set up in each project, or whether one central site should serve everything.

**Decision.** There is one central dashboard for every project, at `analytics.<the owner's company domain>`, behind Cloudflare Access. A project that wants a few numbers in its own admin panel reads them from `/api/external/query` with its secret key, as a product's own admin panel already does. There is no shared dashboard package.

**Why.**
- The projects use different stacks: the posthog-js site is Next.js, and the hand-built client has its own web app.
- A shared package would need its own copy of sign-in, the replay player and the heatmap renderer inside every project, and every upgrade would touch every project.
- One site keeps those parts in one place.
- The owner's company domain sits above any one project. Its zone is on Cloudflare.

**Consequences.** Supersedes the open question in D-10. The intake host names stay per project (`e.<project domain>`). Creating the DNS record and the Access application waits for the owner's go at the first deploy.

## D-17 · Build from a skeleton, filled in by DeepSeek workers in waves · accepted (2026-10-20)

**Context.** The owner wants to try another way to build. A strong model plans the whole structure and sketches every file. A cheap model fills the files in. The strong model audits each group of files before the next group starts.

**Decision.**
- Claude writes the skeleton: the shared types and schemas, the platform folder, the schema steps, the composition root's wiring, and every test. Every other function gets its signature, a comment saying what it must do, and a body that calls `unbuilt(...)`.
- DeepSeek V4.1 Flash (`deepseek-flash`, served as DeepSeek-V4.1-Flash-1017) fills in the bodies. It runs through umbel as a Claude Code worker, so it reads the same `CLAUDE.md` and uses the same tools. Each worker owns one slice's files in its own worktree.
- The waves follow `docs/build-plan.md`. After each wave Claude merges, reads every line, runs `pnpm check` and `/code-review`, fixes what is wrong, and records the numbers in `docs/reviews/build-ledger.md`. Each wave lands as one pull request.
- The `unbuilt` markers are an exception to the no-stubs rule, approved by the owner on 2026-10-20. They are allowed on build branches only. Master accepts none, and `scripts/architecture.test.mjs` holds that.
- Spikes S1 and S2 go first, as the trial run.

**Kill criterion.** If, after two waves, the audit changes more than a third of the lines the workers wrote, or a worker keeps working around its tests, the remaining waves go to Sonnet.

**Consequences.**
- The tests of step 2 are written failing into the skeleton, not marked `todo` on master. A test reaches master with the code that passes it.
- DeepSeek bills per token. The account held 6.76 USD on 2026-10-20, and Claude asks the owner before it falls under 1 USD. A trivial smoke task spent 174,000 tokens, most of them cached, for about 0.01 USD.

## D-18 · Spike S1 passes, with the batch line restated · accepted (2026-10-20)

**Context.** Spike S1 (`docs/reviews/2026-10-20-spike-s1.md`) loaded one ProjectStore with 2,000,000 events. Every dashboard query answered in under half a second, and a batch alone committed in about 13 ms. A batch that arrived during the funnel waited about 290 ms, because a Durable Object runs one call at a time. That failed the line "the batch commits in under 100 ms" while a query runs. The SDKs wait 10 to 60 s and retry, so a wait like that loses nothing.

**Decision.** The owner restated the line on 2026-10-20. A batch waits no longer than the longest dashboard query, and each dashboard query reads at most 5,000,000 rows. That budget fits every query of S1's second run (the largest read 3,305,601 rows) and refuses the first run's retention (7,751,343 rows, 4.1 s). D-3 stands.

**Consequences.**
- Budgets count rows read, as `docs/engineering.md` prefers to times. The `query` slice's tests run each compiled query on a fixture of S1's size and fail when it reads more than the budget. Behaviour `query-09` holds this.
- One intake object per project stays. A separate object that takes intake while queries run is not built, because nothing measured calls for it.

## D-19 · Local runs address ProjectStores outside a jurisdiction, by an opt-out flag · accepted (2026-10-20)

**Context.** Local workerd throws "Jurisdiction restrictions are not implemented in workerd" on `jurisdiction("eu")`. Wrangler has no jurisdiction setting for a Durable Object binding. So `apps/worker/src/platform/project-store-id.ts`, which always uses the `eu` jurisdiction, cannot run in the Workers test pool or under `wrangler dev`. The owner left the call to Claude as tech lead.

**Decision.**
- `project-store-id.ts` addresses every ProjectStore in the `eu` jurisdiction unless the binding `LOCAL_UNSCOPED_PROJECT_STORES` is the string `"1"`. Then it uses the plain namespace.
- Only local runs set that binding: the Vitest config's Miniflare bindings, and the scripts that start `wrangler dev`, through `--var`. It is never in `wrangler.jsonc`.
- The safe case is the default. A deployment with no flag addresses the EU. A deployment can only get the flag through `wrangler.jsonc`, and `scripts/wrangler-config.test.mjs` already fails on any `vars` there.

**Why not the other ways.** Catching the workerd error and falling back would hide a real failure in production. Passing the namespace in from each caller would spread the EU rule over every caller, when it has one home today.

**Consequences.** This is an exception to the no-fallbacks rule, made by Claude on the owner's delegation. When `project-store-id.ts` lands, a check in `scripts/architecture.test.mjs` fails if the flag's name appears anywhere except that file, the Vitest configs and the local run scripts.

## D-20 · The choices the harvested specification rests on · accepted (2026-10-20)

**Context.** Step 2 harvested about 620 candidate behaviours from InsightFlare, flarelytics, counterscale, PostHog's SDKs, the spikes and our own docs. The candidates left choices open, and some donors disagreed. The owner left technical calls to Claude as tech lead. This entry is the one home of those choices; `docs/spec/behaviours.md` cites it.

**Intake answers.**
- A body that cannot be read (empty, bad gzip, bad base64, not JSON, not an event, a batch or an array) is 400. An unknown or missing token is 401. A failed registry or ProjectStore is 503. Every answer carries the CORS headers, and none is 204.
- A problem with one event drops that event and keeps the rest, answering 200. The problems are: no event name, no distinct id, `properties` not an object, or a distinct id over 200 characters. Over-long values are clipped inside the JSON object, never in its text (intake-04).
- An event with no `uuid`, or a malformed one, gets a UUIDv7. The hand-built client sends none.
- An event older than its project's retention, by event time, is dropped at intake with 200. Retention counts event time everywhere.
- A missing `$process_person_profile` counts as true.

**Bots and internal traffic.**
- `bot` is 1 only for a known bot user agent, which includes `HeadlessChrome` and script clients such as `curl`, or a Cloudflare verified-bot category. A missing user agent alone is not a bot.
- No network or ASN guesses. They would hide people on VPNs, and every server event of the hand-built client.
- Internal rules are of two kinds: an event property equals a value (for example `$host`), or a person property equals a value. They apply at query time, so a changed rule applies to old data. There are no IP rules, because no IP is kept (intake-07).

**Caps and size.**
- The daily cap counts the project's own calendar day, in its `timezone`, by arrival time.
- The default `daily_event_cap` becomes 40,000. Spike S1 measured about 530 bytes an event, so 40,000 a day for 395 days is about 8.4 GB.
- At or above 9 GB of database, a batch gets `quota_limited` and nothing is stored, while the sweep goes on.
- The recording-bytes cap counts gzip bytes written to R2. A chunk that would cross the cap is refused whole.

**Cookieless.**
- The hash uses the exact `$host`, so no public suffix list is needed. The salt's day comes from the event's `$timezone`, else the project's.
- A cookieless event with no client IP is dropped. It is never hashed with a placeholder IP.
- The salt for day D is deleted once D has ended at UTC-12, at (D+1) 12:00 UTC. Making a new salt deletes expired ones in the same transaction.

**Identity.**
- Two identified persons are never merged. If `$anon_distinct_id` already belongs to another identified person, the ids stay apart and the event is stored.
- For `$set`, the later event time wins. For `$set_once`, the earliest event time wins. So arrival order never decides.
- Groups are stored as ordinary events. No group model is built.

**Recordings.**
- Intake decodes the `cv: "2024-10"` fields, scrubs typed text in Input events and input `value` attributes, and drops `rrweb/network@1` plugin events. It stores plain rrweb events as gzip NDJSON. This keeps D-13's promise inside compressed payloads, so the player never sees `cv`.
- A chunk is one `$snapshot` event, unique on its uuid, so a retry stores it once. A session id must have the shape of a UUID, so no key can reach outside its session's prefix.
- A recording's start and end are its rrweb times, corrected by the skew of the chunk that carried them.

**Heatmaps.**
- A `$$heatmap` event is kept as points only, not as an event row. Points carry `bot` and the page `host`, so host rules and bot exclusion apply to them. Person-property rules cannot apply, and the answer says so. `mousemove` points are not stored.
- Scroll depth reads `$prev_pageview_max_content_percentage`, from `$pageleave` and from `$pageview`, counted once per `$prev_pageview_id`.

**Queries.**
- Ranges are half-open, and "last N days" is N calendar days including today. The previous period is the same number of calendar days before. Buckets are hour, day, week (from Monday) and month, in the asked time zone, filled with zeros, at most 512.
- A range reaching before the retention horizon is clipped, and the answer says so.
- An invalid time zone, limit, sort, granularity, filter or cursor is 400, never a quiet default. A ratio with a zero denominator is `null`.
- Funnels have 2 to 10 steps and always a window. The window's end is inclusive and runs from the entry event across the whole funnel. A person converts if any entry converts. Equal times break on storage order. Filters select events, not sessions.
- Retention cohorts start at a person's first counted event ever.
- A secret key reads only its own project, through `/api/external/query`, and a spec that names a project is 400. Dashboard paths refuse secret keys with 401. So query-01 and recordings-04 become 401 and 400 cases, never 403.
- Not built, so their candidates are rejected: conversions by source, new versus returning, bounce rate and session duration, query caches, batches of queries, cancellation, and an estimate of a query's cost before it runs. The rows-read budget is proven by tests at real size instead (query-09).

**Platform and projects.**
- A secret key is `cfa_sk_` and 43 base64url characters (32 random bytes), stored as a SHA-256 hash. Its last-used date is kept by the day.
- Unknown tokens are cached for 60 s too, so a new project may be refused for up to a minute. A deleted project's token is refused within 60 s. The Cache API lives in each data centre and cannot be purged everywhere, so "at once" is not offered. A purge waits 60 s after the delete mark.
- Requests that change dashboard state must come from the dashboard's own origin, because the browser sends the Access cookie by itself.
- A project has no host name of its own (D-10: the token decides the project).
- An alarm that fails throws, and Cloudflare's own alarm retry runs it again. A ProjectStore with nothing left to sweep drops its alarm, and the next write sets one.
- An object whose recorded schema step is newer than the deployed code answers 503 and writes nothing.
- `recordings_retention_days` is at most 365, so the 400-day R2 backstop never fires first.

## D-21 · How the skeleton and tests are made after the spikes · accepted (2026-10-21)

**Context.** D-17 had Claude write every signature and every test. The spikes showed that DeepSeek workers fill bodies well and stop at faults in the skeleton. On 2026-10-20 the owner asked that all delegated work run on DeepSeek, to spare their Claude subscription. They also asked Claude to design the whole structure itself, with as many tokens as it needs, and to keep auditing everything the workers make.

**Decision.**
- Claude writes the structure on `build/skeleton`: `packages/shared`, the platform folder, the schema steps, the composition root, the wrangler config, and every slice's files with their exported signatures and contracts.
- Before each wave, DeepSeek workers draft that wave's failing tests from `docs/spec/behaviours.md`, against the frozen signatures. Claude audits every test before any fill worker starts. A test must name its behaviour ID, prove that line, fail on an `unbuilt` marker and nothing else, and mock none of our code.
- Then DeepSeek workers fill the bodies, as in D-17.
- Every delegated agent runs on DeepSeek through umbel. No Claude subagents.

**Consequences.** The tests are written wave by wave, not all at once. The signatures are the contract the test workers write against, so a signature change after its tests exist is an audit finding.

## D-22 · ProjectStore calls answer a store that cannot serve with a value · accepted (2026-10-21)

**Context.** The skeleton had every ProjectStore RPC call throw when the schema could not serve, for example when the store is newer than the code (platform-22). A thrown error loses its type across RPC and arrives as a message only. The engineering rules say failure lives in the return type. The Workers test pool also reports every rejected Durable Object RPC call as an unhandled error, even when the caller handles it ([workers-sdk#7707](https://github.com/cloudflare/workers-sdk/issues/7707), open, still in `@cloudflare/vitest-plugin` 1.4.5). So a thrown failure cannot be tested green.

**Decision.** Every ProjectStore RPC call returns `Result<T, E>`, where `E` holds the SchemaError and any failure the call plans for. A store whose schema cannot serve answers `{ ok: false, error }` with the SchemaError and writes nothing. So does a batch the store refuses as a whole, such as a day's salt it cannot make (cookieless-17) or a row the table refuses (events-13): `ingest` answers `Result<IngestAnswer, SchemaError | IngestError>`. The caller maps each to 503. Errors nobody planned for, such as a broken invariant, still throw.

**Consequences.** Each slice unwraps one Result per store call. The skeleton's later calls (`ingest`, `runQuery` and the rest) change their return types before their wave's tests are written. The scheduled `alarm()` is called by Cloudflare, not over RPC, so it still throws to get Cloudflare's retry (platform-30).

## D-23 · Waves run as pleach plans: an Opus outline, DeepSeek tests and fills · accepted (2026-10-21)

**Context.** On 2026-10-21 the owner asked that wave 2 be planned with pleach and umbel: a Claude Opus 5.5 agent outlines the wave, and DeepSeek builds it. Claude still audits all of it. The project also dogfoods pleach, so what goes wrong is filed at jahala/pleach and jahala/umbel.

**Decision.**
- Each wave runs as two pleach plans in `docs/waves/w<N>/`, on the branch `build/w<N>` from master.
- The tests plan: an outline node on Claude Opus 5.5 brings the wave's files from `build/skeleton`, reconciles them with master and the decisions made since, writes the wave's shared test helpers, and maps each behaviour to a test file in `docs/waves/w<N>/map.md`. Then one DeepSeek test node per slice drafts the failing tests. A command node runs the red gate over the whole wave.
- Claude audits the landed tests on `build/w<N>`.
- The fill plan: DeepSeek fill nodes in dependency order, then a close node on Opus that integrates the fills and makes `pnpm check` pass. codex audits the close node by running the check itself.
- Claude audits every line, then the wave lands as one pull request, as in D-17.
- Every node's smoke is `pnpm wave:gate outline|red|fill`, which proves the same things as the D-21 gates, with `HEAD` as the base.
- The pleach config lives in `.context/pleach/` on the owner's Mac, because it imports pleach by absolute path. It sends nodes marked `deepseek` to Claude Code pointed at DeepSeek, with the key passed by name.
- `build/skeleton` becomes a draft. Each wave's outline node reconciles it.

**Kill criterion.** pleach stays if both runs of a wave land without merging by hand and the audit share stays under D-17's third. If pleach itself fails a run twice in one wave (a node failed by the conductor, a lost tree, a gate it cannot run), the remaining waves go back to D-21 with umbel alone.

**Consequences.** The outline costs Claude subscription tokens, and the tests and fills cost DeepSeek credit. The workers commit nothing themselves: pleach commits what passes its gate, on `node/<id>` branches.

## D-24 · The dashboard opens on a board of tiles, in cfmail's teal · accepted (2026-10-21)

**Context.** Before any screen of wave 5 was built, the owner asked for a UX review with the jev-ux-review skill, and for components taken from cfmail. The owner saw a static mockup of the result (`docs/design/prototype/board.html`), spot-checked the five findings and accepted them.

**Decision.**
- Each product opens on a board: tiles that start with the standard numbers (visitors, page views and sessions over a chart; pages, sources, countries and devices), to which the owner adds their own saved questions. The layout is `docs/design/layout-plan-2026-10.md`.
- The look takes cfmail's tokens and parts, with cfmail's teal as the one accent.
- The Worker gains what the plan needs before the screens are built: saved tiles, traffic channels, a funnel split into groups, recording filters, and the pages a recording visited. Each gets spec lines and tests first.
- Jev stays in use for later UX rounds, since the owner's spot-check passed the brief's kill criterion. Its label questions failed their calibration and are not used.

**Consequences.** Saved tiles are a new D1 table with its own lifetime. cfmail's code is MIT, so the first file taken from it brings its notice into `THIRD_PARTY_NOTICES.md`. Revenue and a people view wait.

## D-25 · A visitor is the person, else the distinct id, in every query kind · accepted (2026-10-21)

**Context.** Trends and top lists counted a visitor as the event's person, else its distinct id (query-72). Funnels and retention counted people only (query-30, query-62), so an event with no person counted nowhere. The posthog-js site runs posthog-js with `person_profiles: 'identified_only'`, so an anonymous visitor has no person until they sign in, and its main funnel (page view, demo, waitlist) would have counted almost nobody. PostHog counts such events in funnels too, through a person id it derives from the distinct id. The owner confirmed on 2026-10-21 that every visitor counts, anonymous ones included.

**Decision.** In every query kind, a visitor is the event's person, else its distinct id, which for a cookieless event is its daily hash. The rule is one SQL expression in `apps/worker/src/features/query/sql.ts`. An identify links an id's earlier events to the person (identity-01, identity-03), so a visitor who signs in counts once.

**Consequences.** query-30, query-62 and query-72 change. Retention cohorts include anonymous visitors, and its start is each visitor's first counted event ever.

## D-26 · Queries stay within the rows budget at S1's size · accepted (2026-10-21)

**Context.** The size test (query-09) runs every kind over 13 months of spike S1's fixture. The fills read 780 million rows for a trend, 41 million for a funnel, 6.3 million for retention and 44 million for the property list, against a budget of 5 million (D-18). Cloudflare charges per row read, so the trend alone would cost about 78 cents a load. The causes: SQLite built an automatic index on `bot` for each trend bucket instead of using `events_ts`, and Durable Objects refuse the pragma that turns automatic indexes off; the funnel followed every entry event through a recursion; retention probed every person and bucket; the property list read every event's JSON.

**Decision.**
- A trend names its index: `events_event_ts` when it counts one event, else `events_ts`.
- Funnels and retention read each visitor's events in one ordered pass, and the store folds those rows into the answer's few rows before they leave the object (`CompiledQuery.fold`). The fold is a pure function of the query slice, and holds one visitor's events at a time.
- The property list reads the newest 10,000 events of the range, and its answer says how many events it read (query-51).

**Consequences.** A funnel is still one statement (query-32), now with a fold. The property list is a sample, enough for the question editor's names but not a count over the whole range.

## D-27 · The owner signs in to the dashboard with Cloudflare, not Cloudflare Access · accepted (2026-10-21), supersedes D-5's Access half

**Context.** D-5 put the dashboard behind Cloudflare Access, with the Worker checking the Access JWT on every request. Setting up Access needs an Access application per host, which wrangler cannot create. cfmail signs its admin in with a private Cloudflare OAuth client instead (cfmail D-13, D-14), and the owner asked on 2026-10-21 for the same here: their Cloudflare login and its two-factor are the identity, with no separate login.

**Decision.**
- A private OAuth client in the owner's account, separate from cfmail's, which the owner creates. The Worker reads `CLOUDFLARE_CLIENT_ID` and `CLOUDFLARE_CLIENT_SECRET` as secrets. Its redirect address is `<dashboard origin>/auth/callback`.
- `GET /auth/sign-in` sends the browser to `https://dash.cloudflare.com/oauth2/auth` with scope `user-details.read`, a random state and a PKCE S256 challenge, kept in a signed cookie for ten minutes. `GET /auth/callback` checks the state, exchanges the code at `https://dash.cloudflare.com/oauth2/token` with the client's Basic credentials and the verifier, and reads the email from `https://api.cloudflare.com/client/v4/user`. Only the email in the `ADMIN_EMAIL` secret is admitted.
- The session is a cookie, `__Host-cfa_session`, holding the email and an expiry 12 hours on, signed with HMAC-SHA256 under the `AUTH_SECRET` secret. It is HttpOnly, Secure and SameSite=Lax. Nothing is stored server-side, so it has no table and no lifetime to sweep; rotating `AUTH_SECRET` signs everyone out.
- Every dashboard path checks the session where it checked the Access JWT, with the same single 401 body. A secret key sent as a Bearer token is still refused there, and state changes still need the dashboard's Origin (projects-26), which a cookie session makes essential.
- Until the client's secrets are set, `/auth/sign-in` answers 503 and every dashboard path 401.

**Consequences.** D-5's Access half is replaced; per-project keys for machine reads stay. `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` go, and with them the JWT and certificate code. The platform-02 to platform-06 lines about Access JWTs are rejected, and new lines cover the session and the sign-in. Tests stand in for Cloudflare's two endpoints through the injected `fetch`; the shapes are taken from Better Auth 1.7's Cloudflare provider, which cfmail uses in production, and the staging smoke checks the real flow once the client exists.

## D-28 · Settings save together, and the Pages tile counts page views · provisional, for the owner (2026-10-22)

**Context.** Building the dashboard overnight, with the owner away, met two choices the layout plan (D-24) did not settle the way the screens turned out.

**Decision.**
- Settings has one "Save changes" and "Discard" in its header for every setting, where the plan said each section saves on its own. One pair keeps the header calm, and a half-saved form is not possible. Keys, erasing, export and deleting still act at once, each behind its own dialog.
- The standard Pages tile counts page views (`event: "$pageview"`), and so does the Pages screen. Counting every event listed server-side events, which carry no page, as a "(none)" page.

**Consequences.** Both are one-line changes to reverse: per-section save buttons in `apps/web/src/features/settings/settings.tsx`, and the tile's spec in `packages/shared/src/tiles.ts`, which a new product takes and "Restore standard tiles" brings back.

## D-29 · Alerts come from the owner's Mac, and the backup signs in with the keychain's secret · provisional, for the owner (2026-10-22), its alerts superseded by D-30 and its restore line by `pnpm ops restore` (2026-10-22)

**Context.** Cloudflare's notifications have no alert for a failing Worker. The backup and export read each product's tables through the dashboard's export route, which needs a session, and a session needs `AUTH_SECRET`, which Cloudflare never gives back.

**Decision.**
- `pnpm ops watch staging --go` installs a LaunchAgent on the owner's Mac that asks `/healthz` every five minutes and shows a notification when it fails. For when the Mac sleeps, an outside monitor is recommended (UptimeRobot's free plan, as in cfmail); it needs the owner's account there, so it is not set up.
- `pnpm ops secrets` keeps `AUTH_SECRET` in the macOS keychain (service `cfanalytics-<env>`) as well as in the Worker. The backup, the export and the smoke test sign their own session with it.
- There is no restore command yet; `docs/operations.md` says what a restore needs.

**Consequences.** The alerts and the backup work only from this Mac. Losing the keychain entry means running `pnpm ops secrets` again, which signs everyone out.

## D-30 · Production replaces staging, and a watcher on Cloudflare emails alerts · accepted, sender provisional (2026-10-22), supersedes D-29's alerts; its address superseded by D-31

**Context.** The owner is the dashboard's only user, so they asked to turn staging into production. A Worker's workers.dev address cannot change in place, and the SDKs keep the address they are given. D-29's alerts came from a LaunchAgent on the owner's Mac, silent while it sleeps, and they asked whether the alerts could run on Cloudflare for free.

**Decision.**
- Production gets clean names before any real traffic: the Worker `cfanalytics` at its workers.dev address, the D1 registry `cfanalytics-registry` and the R2 bucket `cfanalytics-recordings`, both EU, the bucket with its 400-day rule. Staging, which held only test data, is removed.
- The watcher, `apps/watch`, is a separate Worker on a five-minute cron trigger. It asks production's `/healthz`, keeps its last check in one KV key, and emails the owner's address through a `send_email` binding locked to that address: when two checks in a row fail, and when the first check after passes (ops-01, ops-02). It runs apart from the Worker it watches, so a broken deploy cannot silence it. Cron triggers, a KV namespace of one key, and sends to a verified Email Routing address are free (Cloudflare's Email Service pricing, checked 2026-10-22).
- It sends from a `cfanalytics-alerts` address on the one domain in the account with Email Sending on. **Provisional, for the owner:** another onboarded domain works as well.
- The LaunchAgent goes. D-29's other half, the backup signing in with the keychain's secret, stands.

**Consequences.** One watcher for one production. It does not see a Cloudflare-wide outage, which takes the watcher down too; that is what Cloudflare's own status page is for.

## D-31 · Production answers on the dashboard's host and each product's own intake host · accepted (2026-10-22), supersedes D-30's address; its origin lookup superseded by D-32

**Context.** D-16 put the dashboard at `analytics.<the owner's company domain>` and each product's intake on its own domain, `e.<product domain>`. D-30 moved production to its workers.dev address without checking D-16, and the owner caught it.

**Decision.**
- Production's Worker answers only on its custom domains: the dashboard's host, and the two products' `e.` hosts for intake. Its workers.dev address is off. The three zones are in the same account, and Cloudflare makes each domain's DNS record and certificate.
- The first custom domain in `env.production` is the dashboard's address. The ops commands read it from there as the deployment's origin, so the address has one home.
- A product's SDKs send to their own intake host. The Worker checks callers by path, not host (architecture.md), so any of its hosts serves any product.
- `DASHBOARD_ORIGIN` is `https://<dashboard host>`, and the OAuth client's redirect is `https://<dashboard host>/auth/callback`.

**Consequences.** Supersedes D-30's address. A new product on another domain adds its `e.` route and deploys. The dashboard's install snippet shows the dashboard's own address, which works, though D-16 prefers the product's intake host.

## D-32 · An installation's values live in a private site file · accepted (2026-11-11), supersedes D-31's origin lookup

**Made by.** The owner's ruling for the c-f-x family (cf-kit conventions, section 4), applied by the lead of this repository for the public release (issue #30).

**Context.** This repository is to be public as `c-f-x/cf-analytics`. `apps/worker/wrangler.jsonc` held production's account id, D1 id and hostnames, `apps/watch/wrangler.jsonc` the watcher's account, KV id and addresses, and the ops scripts the admin's email. The family rule is that a public repository holds none of these. `@c-f-x/kit` will publish the family's loader, but it is not published yet.

**Decision.**
- The values live in `cf-analytics.jsonc`, in a private checkout of the owner's site repository that `CFX_SITE` names. `scripts/lib/site.mjs` reads and checks it, and joins it with the template configs into each command's own scratch folder.
- The deployment's origin is the site file's `worker.dashboard_host`. This replaces D-31's lookup of the first custom domain in `wrangler.jsonc`, which holds no routes now.
- The loader is the smallest this repository needs, behind one function, `readSite`. When `@c-f-x/kit` publishes its loader, `readSite` is replaced by it, and the site file takes the kit's schema.
- `scripts/wrangler-config.test.mjs` fails on any account or resource id, email address, workers.dev host or home folder in a tracked file. Real hostnames cannot be told from links by their shape, so where `CFX_SITE` is set, the same test also fails on any of the site file's hostnames, addresses or ids in a tracked file. Placeholder ids are allowed: a run of six or more of one hex digit, which random ids almost never hold.
- `pnpm ops wrangler production -- <arguments>` runs wrangler against the joined config, so the undo commands a plan prints still run after the plan's scratch folder is gone.

**Consequences.** Every `pnpm ops` command and `pnpm smoke` need `CFX_SITE`. CI, which cannot read the private repository, runs every check but the site-value one. The watcher's address moved from code into the `TO` variable.


## D-33 · The licence is MIT · accepted (2026-11-11)

**Made by.** The owner, for every c-f-x repository: "yes, MIT" (cf-kit D-6).

**Decision.** This repository is MIT, under the owner's copyright line in `LICENSE`, and each `package.json` says so. Third-party code keeps its own notice in `THIRD_PARTY_NOTICES.md`.

**Consequences.** Anyone may use, change and sell copies of the code, including as a hosted service.
