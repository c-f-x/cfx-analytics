# Architecture

The parts of cfx-analytics, what each may depend on, and where each kind of logic lives. Tables and their lifetimes are in `docs/data-model.md`. How code is written and tested is in `docs/engineering.md`. Why it is shaped this way is in `docs/decisions.md`.

## The parts

```
 posthog-js · posthog-node · posthog-ios · plain fetch        Dashboard (React SPA)
        │  events, snapshots, config requests                       │ Cloudflare sign-in (D-27)
        ▼                                                           ▼
┌──────────────────────────────── Worker (Hono) ─────────────────────────────────┐
│ index.ts: the composition root. Builds every dependency once per request:      │
│ bindings, clock, random source, logger. Mounts each slice's routes.            │
│                                                                                 │
│  intake   config   recordings   heatmaps   query   projects   privacy           │
│     │        │         │            │        │        │          │              │
└─────┼────────┼─────────┼────────────┼────────┼────────┼──────────┼──────────────┘
      │ token → project (projects slice, D1 registry, Cache API 60 s)
      ▼
ProjectStore Durable Object · one per project · jurisdiction "eu" · SQLite
   thin class: runs schema steps, receives RPC, hands each call to a slice's store
   tables: events · persons · person_distinct_ids · salts · cookieless_sessions ·
           recordings · recording_chunks · heatmap_points · counters
   alarm: daily retention sweep across every slice
      │
      ▼
R2 bucket "recordings" · jurisdiction "eu" · snapshot chunks, gzip NDJSON
```

| Part | Holds | Runs |
|---|---|---|
| Worker | No state. Routes, decoding, validation, auth checks | Every request |
| D1 registry | Projects, tokens, secret key hashes, settings | Read on every intake request through a 60 s Cache API entry |
| ProjectStore | All of one project's data except snapshot bodies | One instance per project, single-threaded, in the installation's region (D-38) |
| R2 `recordings` | Snapshot chunk bodies | Written by ProjectStore only, read by the recordings slice |
| Web app | Nothing durable | In the browser, served as static assets by the Worker |

## Slices

A slice owns one feature from its HTTP route to its tables. Worker slices live in `apps/worker/src/features/`, dashboard slices in `apps/web/src/features/`. Code that more than one slice needs, and that is not a feature, lives in `apps/worker/src/platform/`: the ProjectStore class, schema steps, the clock and random source, the Result type, logging. Types and schemas that both the Worker and the web app read live in `packages/shared/`.

| Worker slice | Owns | Tables it writes |
|---|---|---|
| `projects` | Registry, tokens, secret keys, project settings, the board's tiles, creating and deleting projects | D1 `projects`, `secret_keys`, `board_tiles` |
| `intake` | PostHog capture paths (`/e`, `/i/v0/e`, `/batch`, `/capture`, each with or without a trailing slash), CORS, body decoding (gzip found by its first bytes, base64 form bodies), size limits, clipping, clock-skew correction, routing a batch to its ProjectStore | none: hands events to `events`, `identity`, `heatmaps` |
| `enrich` | Country from `request.cf`, browser, OS and device from the user agent, referrer cleaning, bot marking | none (pure) |
| `cookieless` | The daily salt, the server hash for `$posthog_cookieless`, and the server-made sessions cookieless visitors need | `salts`, `cookieless_sessions` |
| `identity` | Distinct ids, people, identify, alias, `$set`, `$set_once` | `persons`, `person_distinct_ids` |
| `events` | Storing events, de-duplication by `uuid`, the per-project daily caps | `events`, `counters` |
| `config` | `/array/<token>/config` and `config.js`, `/flags`, and the SDK's lazy scripts under `/static/`, all built from project settings and the pinned posthog-js version. The scripts are served from the ASSETS binding, the folder `apps/worker/assets/posthog/`. | none |
| `recordings` | The `/s/` path, snapshot chunks, recording metadata, input scrubbing, playback | `recordings`, `recording_chunks`, R2 objects |
| `heatmaps` | Click, rage-click and dead-click points per page and viewport width, and the heatmap route. Scroll depth is a `query` kind. | `heatmap_points` |
| `query` | Typed query specs, their compilers and the store's folds: trends, breakdowns, top lists, funnels, retention, scroll depth, the event list, the property list | none (reads) |
| `privacy` | Retention cutoffs and the sweep's order, deletion by person, export pages, and starting a deleted project's purge | deletes through each slice's prune and erase functions, called from `ingest.ts` and `sweep.ts` |
| `alerts` | The weekly email: each product's last whole week in its time zone, the queries that read it, and its plain-text summary (#23) | none (pure) |

| Web slice | Screen |
|---|---|
| `overview` | Visitors, page views, top pages, referrers and countries, against the previous period |
| `events` | A trend with a breakdown, and the raw event list |
| `funnels` | Ordered funnels with a conversion window |
| `retention` | Cohort retention |
| `recordings` | Recording list with filters, the player, and the session's events beside it |
| `heatmaps` | Click and scroll heatmaps over a recorded snapshot of the page |
| `settings` | Projects, keys, retention, recording and heatmap switches, internal-traffic rules |

### Inside a Worker slice

| File | Holds | May import |
|---|---|---|
| `core.ts` | Pure logic: parsing, validation, hashing inputs, query building, metadata derivation. Returns Results and never throws. | its own slice's pure files, other slices' `index.ts` for types, `apps/worker/src/platform/result.ts`, `packages/shared` |
| `store.ts` | SQL against the ProjectStore or D1, with bound parameters. Takes the SQL handle as a parameter. | its own `core.ts`, the platform folder |
| `http.ts` | Hono routes: read the request, check the caller, call core and store, shape the answer | its own files, other slices' `index.ts`, the platform folder |
| `index.ts` | What the slice offers others | its own files |

Inside a ProjectStore, one batch touches several slices' tables in one transaction. That sequence lives in the platform folder: `apps/worker/src/platform/ingest.ts` for batches, recording chunks, a deletion by person and an export page, and `apps/worker/src/platform/sweep.ts` for the alarm's daily sweep and a deleted project's purge. Each slice still owns its own SQL. Routes register in each slice's `http.ts`, and the composition root mounts them.

A slice may split `core.ts` into several pure files when it grows. Each keeps the `core` rules, and the check knows them by their place in the slice, not by name.

## Dependency rules

| Rule | Guard |
|---|---|
| Pure files import no I/O (`hono`, `cloudflare:*`, `node:*`, a slice's `store.ts` or `http.ts`), and call no clock or random source | `scripts/architecture.test.mjs` |
| A slice reaches another slice only through that slice's `index.ts` | `scripts/architecture.test.mjs` |
| A ProjectStore is addressed only by `apps/worker/src/platform/project-store-id.ts`, in the region `STORE_JURISDICTION` names, never one written into the code | `scripts/architecture.test.mjs` |
| The web app imports the Worker for types only | `scripts/architecture.test.mjs` |
| No slice imports the ProjectStore's orchestration (`project-store.ts`, `ingest.ts`, `sweep.ts` in the platform folder) except for types. Those files call several slices' `index.ts`, because one transaction holds them all, so a value import back would make a cycle. | `scripts/architecture.test.mjs` |
| No module-level mutable state in the Worker | `scripts/architecture.test.mjs` |
| The tracked config names no jurisdiction; the deploy takes the region from the site file, and stops when the bucket is not there (ops-03) | `scripts/wrangler-config.test.mjs`, `scripts/ops.test.mjs` |

## Flows

### An event

1. `intake` answers the CORS preflight, decodes the body, and refuses it over the size limit (20 MiB for events, 25 MiB for recordings, PostHog's own limits).
2. `projects` resolves the token. An unknown token is answered 401, and no ProjectStore is contacted.
3. `intake` clips each event, gives it a UUIDv7 if it has none, and asks `enrich` for its derived fields.
4. One RPC call carries the whole batch, with the IP and user agent, to the project's ProjectStore.
5. Inside the object, one transaction does the rest:
   - `events` checks the daily cap.
   - `cookieless` replaces `$posthog_cookieless` with its hash and gives the event a server-made session id, ending a session after 30 minutes without events. The IP is used for the hash and then discarded.
   - `identity` resolves people. Identify can arrive before the anonymous events it joins, so the merge never depends on arrival order.
   - `events` inserts with `INSERT OR IGNORE`.
   - `heatmaps` stores the points of heatmap events.
6. The Worker answers 200 with `{"status": 1}` after the transaction commits. Every SDK drops data on most 4xx answers and retries 5xx, and de-duplication makes a retry safe. A project at its daily cap gets 200 with PostHog's `quota_limited` field, which pauses the browser SDK, never an error status (`docs/spec/posthog-protocol.md`, section 11).

### A recording chunk

1. posthog-js and posthog-ios send snapshot events to `/s/`. `recordings` decodes them and resolves the token as above. Each `$snapshot` event is one chunk.
2. In the Worker, compressed fields (`cv: "2024-10"`) are decoded and network plugin events dropped, so what is stored is plain rrweb events. Input values are replaced with asterisks, whatever the client masked (D-20). The chunk's metadata is read from its events, and the events are gzipped as NDJSON.
3. One RPC call carries the request's chunks to the ProjectStore (`ingestSnapshots`). For each chunk, it takes the chunk's gzip bytes whole from the daily recording-bytes cap, before any write, so two requests never both take the last bytes.
4. It writes the chunk to R2 under `<project>/<session>/<received ms>-<uuid>.ndjson.gz`.
5. It records the chunk and folds its metadata into the recording's row: start, end, active time, first URL, clicks and keypresses. The recording's person is read through its distinct id when the list is read, so an identify after the recording began counts.

If step 5 fails after step 4, the chunk is an orphan, and its bytes stay counted. The retention sweep removes orphans by listing the session's prefix against `recording_chunks`.

### Playback and heatmaps

The player fetches a recording's chunks in order from `/api/projects/:id/recordings/:session/chunks`, as one NDJSON stream, and plays them with rrweb's replayer, which the dashboard loads only on the screens that show a recording. A heatmap comes from `POST /api/projects/:id/heatmap`: points from `heatmap_points` for one path and one viewport-width band, the page's bands that hold points (heatmaps-23), and the newest full snapshot of that path in that band. The dashboard offers only those bands, the busiest first, and fetches the snapshot's one chunk with `?chunk=<key>` (recordings-36). Its range rules are the ones every dashboard answer shares, and their one home is `packages/shared/src/range.ts`. They are drawn over that snapshot, rendered by rrweb's replayer with scripts off. Without a recording of the page, the points are drawn over a blank page of the same size.

### A query

`POST /api/projects/:id/query` takes one typed spec, defined in `packages/shared` and validated with zod. The `query` slice compiles it to statements of `{ sql, params }`, built from the fragments in `apps/worker/src/features/query/sql.ts`. Property names are bound parameters to `json_extract` and never pasted into SQL text. The ProjectStore runs the statements in one RPC call (`runQuery`). Bots and internal traffic are left out unless the spec asks for them. The answer says what was left out, which date range and time zone it covered, and how many rows it read.

A visitor is the event's person, else its distinct id, in every kind (D-25). Every compiled query reads at most 5,000,000 rows on a fixture of spike S1's size (D-18), which `budget.size.test.ts` checks per kind. To stay within it, trends, funnels and retention read each event once, and the store folds the rows into the answer's few rows before they leave the object (`CompiledQuery.fold`, D-26). The fold is a pure function of the kind's own file. The property list reads the newest 10,000 events of the range.

### A deletion

A deletion by person (`POST /api/projects/:id/persons/erase`, the distinct id in the body) is one RPC call. The ProjectStore deletes the person's R2 objects first. If any delete fails, it deletes no row and the Worker answers 502, and a repeat finishes the work. Otherwise one transaction deletes the person's events, points, recordings, ids and person.

A project is deleted in two requests. `DELETE /api/projects/:id` marks it, and its token and keys are refused within 60 seconds. `POST /api/projects/:id/purge` sets the store's alarm for 60 seconds after the mark. The alarm then deletes the project's R2 prefix, wipes the store, removes the D1 rows and finally clears the object. A pass that stops part way runs again on the next alarm and deletes nothing twice. Each alarm reads the project's row in the registry, so a store whose project is marked deleted purges instead of sweeping.

### The weekly email

A cron trigger runs the Worker's `scheduled` handler on Mondays at 06:00 UTC. It runs `apps/worker/src/platform/weekly.ts` through the kit's `job`, so each run logs `job_done` or `job_failed`. The run lists the products from the registry, asks each product's store the `alerts` slice's questions about its last whole week through the same `runProjectQuery` the dashboard uses, and builds one email. `apps/worker/src/platform/mail.ts`, the one module that sends, sends it through the `send_email` binding to each of the site file's alert addresses, which the deploy writes into the binding's allowlist. A product whose store does not answer is left out and logged. `POST /api/emails/weekly` runs the same thing at once.

### Who may call what

| Path | Caller | Check |
|---|---|---|
| Capture paths, `/s/`, remote config, `/flags` | Any SDK | A known public token. The token is public by design, so daily caps limit abuse. |
| `/static/` scripts | Any browser | none; they are posthog-js's own public scripts |
| `/api/external/query` | A project's own backend, such as a product's own admin panel | That project's secret key as a Bearer token, compared by hash. The key decides the project. |
| `/auth/sign-in`, `/auth/callback`, `/auth/sign-out`, `/auth/status` | The owner's browser | none to start; the callback admits only `ADMIN_EMAIL`'s Cloudflare account (D-27). Until `AUTH_SECRET`, `ADMIN_EMAIL` and `DASHBOARD_ORIGIN` are set, sign-in is 503 and every dashboard path 401 (platform-51) |
| `/api/projects` and `/api/projects/:id/*` | The owner, through the dashboard | A session cookie signed with `AUTH_SECRET`, checked in the Worker on every request; state changes also need the dashboard's Origin |
| `/`, `/projects`, `/p/*`, `/app/*` | The owner's browser | none; the dashboard's page holds no data and asks the API for everything. Its answers refuse framing and sniffing (platform-50) |
| `/api/emails/weekly` | The owner, through the dashboard | A session cookie, and the dashboard's own origin (alerts-08) |
| `/healthz` | Monitoring | none; it reveals nothing |

The Worker checks the caller by path, whatever the host, so the dashboard's data needs a session on every host and the SDK paths need none. The owner signs in with Cloudflare through a private OAuth client in their account, and the session lives in a signed cookie, so nothing about it is stored (D-27).

## Where things are

Generated from the folders by `pnpm docs:gen`. `scripts/docs.test.mjs` fails when it is out of date.

<!-- generated:layout -->
```
apps/
  compat/
    clients/
    macos/
      Sources/
        CompatMac/
    pages/
  watch/
    src/
  web/
    public/
    src/
      components/
        ui/
      features/
        board/
        editor/
        events/
        pages/
        projects/
        recordings/
        settings/
        sign-in/
      lib/
  worker/
    assets/
      posthog/
    migrations/
    src/
      features/
        alerts/
        config/
        cookieless/
        enrich/
        events/
        heatmaps/
        identity/
        intake/
        privacy/
        projects/
        query/
        recordings/
      platform/
        schema/
    test/
      helpers/
packages/
  shared/
    src/
scripts/
  lib/
```
<!-- /generated:layout -->
