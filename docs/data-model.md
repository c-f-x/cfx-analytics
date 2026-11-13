# Data model

Every store cfx-analytics keeps, what it holds, how long, and what removes the rest. Each store's rule is built with the store, and a test in the owning slice ages fixture rows and proves the rule. Where the parts are is in `docs/architecture.md`.

## Lifetimes

Every store the deployment binds and every table the schema steps make has one row here, by its binding, class or table name. `scripts/lifetimes.test.mjs` fails when one is missing, or when a row names no store (the c-f-x conventions, section 5).

| Store | Holds | Lifetime | Removed by |
|---|---|---|---|
| `REGISTRY` | The D1 registry, in the installation's region (D-38): the tables `projects`, `secret_keys`, `board_tiles` and `email_addresses` below | As long as the deployment runs; each table's rows by its own rule | Deleting the database (`docs/operations.md`) |
| `projects` | One row per project: name, public token, time zone, settings | Until the project is deleted, then until its data is purged | `privacy` purge, after the ProjectStore and R2 prefix are empty |
| `secret_keys` | Hash, label, created and last-used dates of each project secret key | Until revoked or the project is deleted | `projects` on revoke; `privacy` purge |
| `email_addresses` | The addresses the owner added for the weekly email, and when (D-40). Whether each is confirmed is read from Cloudflare each time, never stored | Until the owner removes it in Settings | `alerts` on remove |
| `board_tiles` | Each project's board: saved questions in position order, each a query spec without range or time zone, and whether it is a standard tile (D-24); a standard tile asked a new question becomes the board's own (projects-45) | Until removed from the board, or the project is deleted, then until its data is purged; at most 40 a project | `projects` on remove; `privacy` purge, in the batch that removes the project's rows |
| `ProjectStore` | One SQLite Durable Object per product, in the installation's region (D-38): the tables `store_meta` to `counters` below | Until its product is deleted, then until the purge | The purge deletes the whole object's storage (privacy-03) |
| `store_meta` | The schema step runner's record: the last step applied and the product's id | As long as its ProjectStore | The purge, with the rest of the object |
| `events` | One row per event | The project's `events_retention_days`, 395 by default, counted by event time. Intake drops an event already older than that. | Daily alarm |
| `persons` | One row per identified person, with properties | Until the person has no events and no recordings left | Daily alarm; deletion by person |
| `person_distinct_ids` | Each distinct id mapped to a person | Same as its person | Same as its person |
| `salts` | One random salt per calendar day, the day taken in the event's `$timezone`, else the project's | Until that day has ended in every time zone: day D's salt goes at (D+1) 12:00 UTC, when D ends at UTC-12. Making a new salt deletes expired ones, so at most three exist. An event whose day's salt is gone is hashed with today's salt. | Daily alarm; salt creation (D-20) |
| `cookieless_sessions` | Each cookieless hash's current session id and last event time | Same as the salt it was made with | Daily alarm |
| `recordings` | One row per session recording, with derived metadata | The project's `recordings_retention_days`, 30 by default | Daily alarm; deletion by person |
| `recording_chunks` | One row per chunk object in R2 | Same as its recording | Same as its recording |
| `heatmap_points` | One row per click, rage click or dead click point. A `$$heatmap` event is kept only as its points (D-20). | The project's `heatmaps_retention_days`, 90 by default | Daily alarm; deletion by person |
| `counters` | Events and recording bytes taken today, for the daily caps. The events count includes `$$heatmap` events, which make points, not event rows (heatmaps-21) | Two days | Daily alarm |
| `RECORDINGS` | The R2 bucket, in the installation's region (D-38): gzip NDJSON chunk bodies | Same as their `recording_chunks` row | Daily alarm deletes the objects first, then the rows. The same sweep removes orphan objects with no row. A bucket lifecycle rule deletes any object older than 400 days as a backstop. |
| `STATE` | The watcher's KV namespace: its last check, in one key (D-30) | Overwritten by each check, every five minutes | The next check; removed with the namespace |

## Copies outside the stores

Copies of the data that no binding holds. Each still has a lifetime.

| Copy | Holds | Kept for | Removed by |
|---|---|---|---|
| Cache API | Registry answers for tokens | 60 seconds | Expiry |
| Exports | One product's tables as NDJSON: `pnpm ops export` writes them to a folder the owner names, and the dashboard's Export data downloads one table at a time | The owner's choice; neither ever deletes a file | The owner |
| Emails | The weekly email (#23): each product's week of counts, top pages and sources, and links to the dashboard. No visitor's personal data | The recipients' choice | The recipients |
| Backups | `pnpm ops backup`'s folder: the registry's rows, every product's tables and every recording object, with a manifest. It holds visitors' data | The owner's choice. A repeat run adds what is new and never deletes, so data erased in production stays in an older backup | The owner |
| Point-in-time recovery | Cloudflare's own copy of each ProjectStore | 30 days | Cloudflare |
| D1 Time Travel | Cloudflare's own copy of the registry, to any minute | 30 days on Workers Paid (developers.cloudflare.com/d1/reference/time-travel/, read 2026-11-11) | Cloudflare |

A deletion request or a retention sweep removes data at once from the live stores. Point-in-time recovery and Time Travel can restore it for up to 30 days, so each consuming project's privacy text says deletion completes within 30 days. A backup the owner keeps is outside that window: a deletion request must be applied to it too, or the backup deleted.

A ProjectStore whose database reaches 9 GB takes no more events or chunks until the sweep frees room: intake answers `quota_limited` (D-20). One object holds at most 10 GB.

## Project settings

Settings are columns on `projects`, each with a CHECK constraint. The registry is their one home: the ProjectStore reads them from D1 when it needs them and never keeps its own copy.

| Setting | Default | Used by |
|---|---|---|
| `timezone` | `Europe/Oslo` | `query` day buckets |
| `events_retention_days` | 395 | `privacy` |
| `recordings_retention_days` | 30, at most 365 | `privacy` |
| `heatmaps_retention_days` | 90 | `privacy` |
| `daily_event_cap` | 40,000 (D-20: with 395 days of retention this fits in 9 GB) | `events` |
| `daily_recording_bytes_cap` | 500 MB | `recordings` |
| `recording_enabled`, `recording_sample_rate`, `recording_min_duration_ms` | off, 1.0, 2,000 | `config`, `recordings` |
| `heatmaps_enabled`, `autocapture_enabled`, `dead_clicks_enabled` | off, on, off | `config` |
| `internal_rules` | none | `query` |

## Tables

Columns are defined in the schema steps, which are the one home of the shape. This section says what the columns mean where the name does not.

**events.** `uuid` is unique, so a retried event is stored once. An event that arrives without one gets a UUIDv7. `ts` is when the event happened, in milliseconds, corrected for the client's clock as PostHog does. `received_at` is when it arrived. `person_id` is the person the event's distinct id belongs to, and stays null while the id belongs to none. An event with `$process_person_profile: false` never makes or changes a person, but it counts for the person its id belongs to, now or once an identify or alias links the id, so earlier anonymous events count for the person (identity-01, identity-03). Cookieless events never have a person. `bot` is 0 or 1, set at intake. Internal traffic is not stored as a flag: the project's rules decide it at query time, so a changed rule applies to old data (D-20). `page` is the page key, host plus path with no trailing slash (enrich-23, enrich-38). `properties` is the event's JSON after clipping. Indexes: `ts`, `(event, ts)`, `(person_id, ts)`, `(session_id)`. Spike S1 measures what each index costs.

**persons.** `property_times` holds, per property, the event time its value came from and whether `$set_once` wrote it, so `$set` keeps the latest time and `$set_once` the earliest, whatever order events arrive in (D-20).

**recordings.** One row per `$session_id`. `start_ts` and `end_ts` are the earliest and latest rrweb times of its chunks, each corrected by its chunk's clock skew. `active_ms` sums the gaps of at most 5 s between input events. `first_url` comes from the earliest chunk's first rrweb Meta event. `distinct_id` is the distinct id of the chunk that made the row. The person is read through `person_distinct_ids` from that distinct id when the list is read, so an identify after the recording began counts; `person_id` is not written.

**recording_chunks.** One row per `$snapshot` event, unique on its uuid, so a retried chunk is stored once. `object_key` is the R2 key. `first_ts` and `last_ts` order the chunks for playback. When a chunk holds a full snapshot, `snapshot_path` and `snapshot_width` say of which page at which width, so a heatmap can find a page to draw on.

**heatmap_points.** `path` is the page without its query string, and `host` the page's host, so host rules apply to points. `bot` is set at intake as for events. `width_band` is the viewport width rounded down to 100 px. `x` and `y` are in the coordinates posthog-js sends (`docs/spec/posthog-protocol.md`), rounded to whole pixels. `fixed` marks points on fixed-position elements, which do not scroll with the page. `event_uuid` and `seq` make a retried `$$heatmap` event store nothing twice, and `distinct_id` lets deletion by person reach the points; a cookieless point has none. Points take nothing from a daily cap.

## Schema steps

A change to a store's shape is a new numbered step, never an edit to an applied one. A ProjectStore's step runner keeps its own record, the last step applied and the project's id, in a `store_meta` table it makes itself. ProjectStore steps run inside the object when it starts, in order, and the object records the last step it ran. D1 steps run with `wrangler d1 migrations apply`. `pnpm migrations:lock` records each new step's hash in `migrations.lock.json`; it never changes an entry already there. `scripts/migrations.test.mjs` fails when a locked step changes or disappears, when a step is not locked, when a new step sorts before a locked one, or when a lock entry from the main line changed.

<!-- generated:schema-steps -->
- `apps/worker/migrations/0001-registry.sql`
- `apps/worker/migrations/0002-board-tiles.sql`
- `apps/worker/migrations/0003-weekly-email.sql`
- `apps/worker/src/platform/schema/0001-project-store.sql`
<!-- /generated:schema-steps -->
