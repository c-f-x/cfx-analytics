# Operations

How cfx-analytics is deployed, watched, backed up and exported. One deployment, production, has run since 2026-10-22 (D-30). The values that say where it runs live in a private site file, never in this repository (D-32).

## Rules

- The lead deploys checked work from current `master`: dry run first, then `--go`, then `pnpm smoke production` (D-36). Creating or deleting a Cloudflare resource, deleting or restoring data, and anything that costs money need the owner's explicit go.
- Every operation is one command. It stops at its first failing step and says which step failed. Before it changes anything, it prints what it will do and how to undo each step, and it changes nothing without `--go`.
- A deploy runs every check, builds the Worker once, and ships that build: it fails unless the bundle it uploaded is byte for byte the one it checked.
- Secrets are drawn and piped by the commands, never typed, printed or put on a command line.
- No tracked file holds an installation's account id, resource id, hostname or email address. `scripts/wrangler-config.test.mjs` fails on one.

## The site file

An installation's values live in `cfx-analytics.jsonc`, in a private checkout that the environment variable `CFX_SITE` names (the c-f-x family's conventions, section 4). Every `pnpm ops` command and `pnpm smoke` read it, and stop with the reason when it is missing or wrong. Each command joins it with the template configs, `apps/worker/wrangler.jsonc` and `apps/watch/wrangler.jsonc`, into its own scratch folder, which it removes when it ends (`scripts/lib/site.mjs`).

Its shape is `site.example.jsonc` at the repository's root: copy it, fill in your own values, and keep the copy private. Every value in the example is a placeholder.

A key it does not know, or a value of the wrong shape, is an error that names it, so a misspelt key is never silently ignored.

`jurisdiction` says where the data is stored: `"eu"`, or left out for Cloudflare's default placement (D-38). It is chosen once, when the database and bucket are made, because Cloudflare cannot move a store. The deploy joins it into the bucket's binding and into `STORE_JURISDICTION`, which tells the Worker where its ProjectStores are. Before any step, the deploy looks for the bucket in that region and stops when it is not there (ops-03). Backup and restore address the bucket in the same region.

## Cloudflare resources

One deployment serves every product (D-10). Its resources keep the names they were made with (the owner's ruling, 2026-11-11). Their ids and hostnames are in the site file.

| Resource | Name | Undo |
|---|---|---|
| D1 database, EU jurisdiction | `cfanalytics-registry` | `pnpm ops wrangler production -- d1 delete cfanalytics-registry` |
| R2 bucket, EU jurisdiction | `cfanalytics-recordings` | `pnpm ops wrangler production -- r2 bucket delete cfanalytics-recordings --jurisdiction eu` (empty it first) |
| R2 lifecycle rule | `delete-after-400-days` on that bucket: objects expire after 400 days | `pnpm ops wrangler production -- r2 bucket lifecycle remove cfanalytics-recordings --name delete-after-400-days --jurisdiction eu` |
| Worker | `cfanalytics`, with no workers.dev address | `pnpm ops wrangler production -- delete` |
| Custom domains | The dashboard's host and each product's intake host, from the site file, each with its DNS record and certificate made by Cloudflare (D-16, D-31) | take the host out of the site file and deploy |
| Durable Object class | `ProjectStore`, SQLite, every instance in the site file's region (D-38) | removed with the Worker |
| Worker secrets | `AUTH_SECRET`, `ADMIN_EMAIL`, `DASHBOARD_ORIGIN`, by `pnpm ops secrets production --go`; `CLOUDFLARE_CLIENT_ID` and `CLOUDFLARE_CLIENT_SECRET`, put by the owner | `pnpm ops wrangler production -- secret delete <name>` |
| OAuth client | "cfanalytics admin sign-in", private to the owner's account, scope `user-details.read`, redirect `https://<dashboard host>/auth/callback` (D-27). Made in the Cloudflare dashboard (Manage account, OAuth clients): response type Code, grant type Authorization Code, token authentication Client Secret Basic. Wrangler cannot make one | delete it in the dashboard |
| Watcher Worker | `cfanalytics-watch`, a cron trigger every five minutes, no address (D-30) | `pnpm --filter @cfanalytics/watch exec wrangler delete --name cfanalytics-watch` |
| KV namespace | `cfanalytics-watch-state`: the watcher's last check, one key | `pnpm ops wrangler production -- kv namespace delete --namespace-id <the site file's watch.kv_id>` |

The bindings below are generated from the template `apps/worker/wrangler.jsonc` by `pnpm docs:gen`. A deploy binds the same names to the site file's resources.

<!-- generated:bindings -->
| Block | Binding | Kind | Resource |
|---|---|---|---|
| top level | REGISTRY | D1 | cfanalytics-registry-local |
| top level | RECORDINGS | R2 | cfanalytics-recordings-local (no jurisdiction) |
| top level | PROJECT_STORE | Durable Object | ProjectStore |
| top level | ASSETS | Assets | assets |
<!-- /generated:bindings -->

## Commands

Each runs from the repository root, from a clean checkout of current `origin/master`. `pnpm ops <command>` with no `--go` only prints its plan. `<env>` is `production`.

| Command | Does |
|---|---|
| `pnpm check` | Lint, typecheck, tests (including the doc and script checks), the size tests, the dashboard's build, the Worker's and the watcher's, in that order, stopping at the first failure |
| `pnpm ops deploy <env> [--go]` | Reads the undo points first (the registry's time-travel bookmark, the Worker's current version). Then: `pnpm check`, the dashboard's build, one bundle of the Worker, the registry migrations, the deploy, a check that the uploaded bundle is the checked one, and `/healthz`. A failure lists the undo of every step taken, newest first. The working tree must be clean, so a deploy is always a commit. |
| `pnpm ops secrets <env> [--go]` | Draws a new `AUTH_SECRET`, keeps it in the macOS keychain (service `cfanalytics-<env>`, account `AUTH_SECRET`) for the backup, and pipes it, the site file's `admin_email` and `https://<dashboard host>` to `wrangler secret put`. A new `AUTH_SECRET` signs everyone out. |
| `pnpm ops health <env> [--notify]` | Asks `/healthz` and exits 1 unless it answers 200. With `--notify`, a failure also shows a macOS notification. |
| `pnpm ops watch [--go]` | Deploys the watcher (`apps/watch`, D-30), with the site file's watch block. |
| `pnpm ops wrangler <env> -- <arguments>` | Runs wrangler against the deployment, with the site file joined in. The undo lines in every plan use it. |
| `pnpm smoke <env>` | The smoke test of a deployment (`apps/compat/smoke.mjs`): `/healthz` answers 200, the dashboard's data is 401 without a session while its page is served, and the real posthog-node and posthog-js reach it, with a recording and heatmap points, checked through its API. The SDKs send to a product made for the run alone, which the run deletes and purges at the end, whatever happened, so production keeps no test product or test data. |
| `pnpm ops backup <env> <folder>` | Writes `registry.sql` (the registry's rows, without its schema), every product's tables as NDJSON under `projects/<id>/`, every recording chunk's object under `objects/`, and `manifest.json`. A repeat run into the same folder fetches only new objects. The folder holds visitors' data: keep it on an encrypted disk. |
| `pnpm ops restore <env> <folder> [--go]` | Puts a backup into a deployment that holds no product yet: the registry's rows, then each product's tables through the import route in the order `persons`, `person_distinct_ids`, `events`, `recordings`, `recording_chunks`, `heatmap_points` (privacy-30), then the recording objects. A repeat run adds nothing twice. The plan names each step's undo. |
| `pnpm ops export <env> <project id> <folder>` | One product's tables as NDJSON, as the dashboard's Export data gives them one table at a time. |
| `node scripts/posthog-scripts.mjs <version>` | Replaces the pinned posthog-js scripts in `apps/worker/assets/posthog/` with another version's, byte for byte from npm, and prints their SHA-256 for `SCRIPT_SHA256` in `apps/worker/src/features/config/core.ts` (D-15). Change `POSTHOG_JS_VERSION` and the notice in `THIRD_PARTY_NOTICES.md` with it. |

The smoke test, the backup, the export and the restore sign in to the dashboard's API with a session signed by the keychain's `AUTH_SECRET`, so they work only from the Mac that ran `pnpm ops secrets` (`scripts/lib/dashboard-api.mjs`).

## Health and alerts

`GET /healthz` answers 200 when the Worker runs and both the registry and the recordings bucket answer, and 503 when either does not. It does not touch a ProjectStore, so a failing store shows as failed intake in the logs and in `pnpm smoke`, not here.

Cloudflare's notifications have no alert for Worker errors, so the watcher, `cfanalytics-watch`, does it (D-30). It is a separate Worker on a five-minute cron trigger, so a broken deploy of the Worker it watches cannot silence it. It emails the site file's `watch.to` from `watch.from` when two checks in a row fail, and again on the first check that passes after. It costs nothing: cron triggers, one KV key and sends to a verified address are free. In the c-f-x family, cfx-status takes this job over later.

The Worker writes one log line per failure (`project_store_failed`, `registry_unavailable`, `sign_in_failed` and others) to Workers Logs, which keeps 7 days on the paid plan. `pnpm ops wrangler production -- tail --status error` shows them live.

### The weekly email

Every Monday at 06:00 UTC the Worker emails each of the site file's `alert_addresses` one summary of the week before: every product's visitors and sessions against the week before, its top pages and sources, and its rage clicks and clicks that did nothing (#23). It comes from `watch.from`, the address the watcher sends from. Each run logs `job_done` or `job_failed` with the name `weekly_email`. The owner can send it at once from the dashboard, or with `POST /api/emails/weekly`.

The site file's addresses must be confirmed destination addresses under Email Routing. The binding has no allowlist (D-40), so mail to an unconfirmed one would go out metered instead of being refused.

More addresses are added in a product's Settings, under "Emails" (D-40). Adding one asks Cloudflare, through its Email Routing API, to email that person a link. The address shows "Waiting for confirmation" until they click it. The Worker sends only to the site file's addresses and to added ones Cloudflare marks confirmed (alerts-13). Each product's Settings can also turn its weekly email off, or leave it out for one address (alerts-09).

Adding addresses needs a Cloudflare API token with one permission, Account, Email Routing Addresses, Edit. The owner makes it once under My Profile, API Tokens, Create Custom Token. It is the Worker's secret `CLOUDFLARE_EMAIL_TOKEN`, piped in so it never shows: `read -rs v && printf '%s' "$v" | pnpm ops wrangler production -- secret put CLOUDFLARE_EMAIL_TOKEN; unset v`. Without it, the weekly email still goes to the site file's addresses, and Settings says adding addresses needs a setup step. Removing an address takes it off this tool's list and keeps Cloudflare's record, which other tools may send to.
