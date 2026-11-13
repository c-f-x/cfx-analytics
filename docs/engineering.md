# Engineering

How code is written and tested here. Every rule names the check that fails when it is broken, or says that nothing holds it yet. The test commands and their measured times are in `CLAUDE.md`.

## Writing code

**Pure core, I/O at the edge.** Logic lives in a slice's pure files and takes everything it needs as arguments: the time, random values, settings, the rows to work on. `store.ts` and `http.ts` do the I/O and call the core. The composition root, `apps/worker/src/index.ts`, builds the clock, the random source and the bindings once per request and passes them down.

**Failure is a value.** Pure functions return `Result<T, E>` from `apps/worker/src/platform/result.ts` and never throw. An error type names what went wrong in words a log reader understands. `http.ts` turns a failed Result into a status code and a one-sentence message. A throw is allowed only for a broken invariant, where continuing would corrupt data.

**One home per rule.** A limit, a default, a schema or a metric is defined once. Values both the Worker and the web app need, such as query specs, their zod schemas and answer shapes, live in `packages/shared`. Settings live in the D1 registry and nowhere else.

**State has an owner.** The Worker keeps no module-level mutable state: a value that belongs to one request lives in that request's scope. Per-project state lives in that project's ProjectStore. The dashboard shows only the answer to its newest request: every TanStack Query key holds every input of its spec, so an older answer that arrives late never replaces a newer one.

**SQL.** Every statement uses bound parameters. A column or JSON path chosen at run time comes from a closed list in a pure compiler, or is passed as a parameter to `json_extract`. No ORM.

**Names and comments.** Follow the code around you. A comment says why, not what. Docs, comments and commit messages follow the owner's writing rules: plain language, short sentences, no em dashes.

**Copied code.** Code taken from a donor (`docs/donors.md`) keeps the donor's licence notice in `THIRD_PARTY_NOTICES.md`, added in the same change. Nothing is taken from a project without a licence.

## Rules and their guards

| Rule | Guard |
|---|---|
| Pure files do no I/O and call no clock or random source | `scripts/architecture.test.mjs` |
| Pure files never throw | `scripts/architecture.test.mjs` |
| Slices meet only through `index.ts` | `scripts/architecture.test.mjs` |
| Each slice owns its own SQL: the ProjectStore's orchestration (`ingest.ts`, `sweep.ts`) calls the slices' table functions and runs no statement itself | `scripts/architecture.test.mjs` |
| No module-level mutable state in the Worker | `scripts/architecture.test.mjs` |
| A ProjectStore is addressed in the region the site file names, through `STORE_JURISDICTION`, and a value that is no region refuses every request (D-38) | `scripts/architecture.test.mjs` forbids a region written into the code and keeps the variable's name in its allowed files (platform-54); `apps/worker/src/platform/health.test.ts` proves the refusal (platform-53). |
| No secrets in `wrangler.jsonc`, and no deployment value in any tracked file: no account or resource id, email address (but the published `security@c-f-x.com`), workers.dev host or home folder, and the template configs hold no `account_id` or routes (D-32) | `scripts/wrangler-config.test.mjs`, each rule also run on a sample it must flag. Real hostnames are found as the site file's own values, so that part runs only where `CFX_SITE` is set, on the owner's Mac; CI runs the rest |
| Applied schema steps never change | `scripts/migrations.test.mjs` |
| Every store and table has a lifetime: each D1, R2 and KV binding, Durable Object class and table the code makes has a row under `## Lifetimes` in `docs/data-model.md`, and every row names one (D-9) | `scripts/lifetimes.test.mjs`, which reads the bindings from the templates joined with `site.example.jsonc`, and the tables from the schema steps and the Worker's source |
| Every workspace package carries the root's version, so a release tag names one version | `scripts/versions.test.mjs` |
| Master holds no skeleton marker (`unbuilt`, decision D-17) | `scripts/architecture.test.mjs` |
| A build worker changes only its own files and leaves no marker in them | `scripts/wave-check.mjs`, run by the worker and again in the audit |
| Docs name only paths that exist, generated tables match the code, and `CLAUDE.md` stays under 150 lines | `scripts/docs.test.mjs` |
| A run leaves nothing behind, even when killed | `scripts/run-scope.test.mjs` |
| An operation stops at its first failing step | `scripts/check.test.mjs` |
| A deploy names the undo of every step before it runs, and ships only the bundle it checked | `scripts/ops.test.mjs` |
| No promise is left unawaited | oxlint `typescript/no-floating-promises` with type-aware linting |
| Types are strict, with no unchecked index access | `tsc` with `strict` and `noUncheckedIndexedAccess` |
| A project never reads another project's data | For recordings, `apps/worker/src/features/recordings/http.test.ts` (recordings-04) asks for project B's session under project A's id and gets 404, and a secret key gets 401 on both dashboard routes. The heatmap route names only a project id, so it reads that project's store alone. For queries, `apps/worker/src/features/query/http.test.ts` (query-01) answers project B's key with B's events only, refuses a spec that names a project, and refuses the key on both dashboard paths. |
| The access checks are proven to guard | `scripts/guard-proof.test.mjs` removes each check in a scratch copy and expects the named behaviour's test to fail. The unchanged copy must pass first (platform-15). |
| No IP address is stored | `apps/worker/src/features/intake/http.test.ts` (intake-07) reads every stored row back and finds none of the addresses sent; `apps/worker/src/features/cookieless/ingest.test.ts` (cookieless-01) does the same for cookieless ids. |
| Two requests reaching for the last of a project's daily cap: exactly one gets it | `apps/worker/src/features/intake/http.test.ts` (intake-09) sends two batches at once through the Worker; `apps/worker/src/features/events/ingest.test.ts` (events-04) sends ten. The cap lives in the ProjectStore, its one writer. |
| Each compiled query reads at most 5,000,000 rows on a fixture of spike S1's size (D-18, D-26) | `apps/worker/src/features/query/budget.size.test.ts` (query-09, query-13), run by `pnpm test:size` inside `pnpm check`: a case per kind, and three trend shapes |
| One rule, one home: helpers that several slices need live once (`packages/shared`, `apps/worker/src/platform/`, `apps/worker/src/features/query/sql.ts`) | Nothing yet checks this mechanically; each wave's audit looks for repeats across files |

Each check that reads source text also runs on a sample it must flag, so a check that silently stops matching fails too.

## Testing

**The specification comes first.** Every behaviour in `docs/spec/behaviours.md` has an ID. A test names the ID it proves, is written before the code, and fails first. A failing test is never deleted.

**Real runtimes, no stand-ins.** Anything that touches SQL, R2 or a ProjectStore runs in the Workers test pool (`@cloudflare/vitest-plugin`) against real local Durable Objects, D1 and R2. Pure files are tested in plain Node. Nothing in our own code is mocked. The only fakes are the outside world's inputs: request bodies, clocks and random sources passed in as values.

**Real SDKs.** Compatibility tests run the real posthog-js in Playwright, plus posthog-node and posthog-ios, against `wrangler dev`. They prove that the SDKs work unchanged. posthog-js drops all events from a browser it takes for a bot, so Playwright runs its full Chromium in new headless mode with the automation flag off and no "Headless" in the user agent. posthog-ios keeps state under the real home folder, so its runs set `CFFIXED_USER_HOME` inside the run's scope. Spike S2 has the details (`docs/reviews/2026-10-20-spike-s2.md`). The suite lives in `apps/compat` and runs with `pnpm compat` (`--only node,browser,ios` picks clients): it starts the Worker under `wrangler dev` in a run scope, seeds a project, runs each SDK, and reads what was stored straight from the persisted state. Each check names its behaviour ID, and the run exits 0 only when every check passed.

**The dashboard end to end.** `pnpm e2e` (`apps/compat/dashboard.mjs`) builds the dashboard, starts the Worker under `wrangler dev` with a throwaway `AUTH_SECRET`, signs a session the way the Worker does, and seeds a product with two weeks of events through `/batch` and a real posthog-js visit with its recording and heatmap. Playwright then visits every screen in light and dark mode and checks it against the Worker's own answers (dashboard-05 to dashboard-13). A screen that throws or logs a console error fails the run. Chromium does not keep a `__Host-` cookie on a plain-http origin, so the session goes in a request header. With `--shots <folder>` the run keeps a picture of each screen, and of each failed check, for a design review.

**Real size.** Anything that lists or loops is tested at the size it meets in use. The fixture generator in spike S1 builds two million events, 20,000 people and thirteen months. Recordings are tested with real rrweb output of several megabytes.

**Tests hold on a busy machine.**
- A test waits for the event it needs, never for a fixed time.
- Time and ids are inputs.
- No test claims a fixed port, name or path. Ports come from the operating system, and folders come from the run's own scope.
- A timeout catches hangs, not slowness.

**A run leaves nothing behind.** Every test run, script and local server keeps what it creates in its own run folder from `scripts/lib/run-scope.mjs`. That folder sits under the system temp folder, and `WRANGLER_LOG_PATH` points into it. The run removes its folder on every ending. The next run sweeps the folders of runs that died, stopping the processes they recorded and moving their folders to the Trash. A sweep never mistakes a live run for a dead one: a run writes its owner file whole, by renaming a finished draft into place, and gives its folder a closing name with its pid before removing it. A folder another run removed while the sweep read it is skipped. A process that starts processes of its own, such as wrangler dev, is started as a process group and recorded as one, so the processes it started stop with it.

## Costs

No call costs money per request today: everything runs inside the Workers Paid plan's included amounts. What could grow the bill is traffic, and the per-project daily caps on events and recording bytes bound it (`docs/data-model.md`). If a paid API is ever called, it goes through one door that reserves its cost against a shared budget before the call and records what was charged after.

## Measuring

A number is trusted only after its instrument gives the right answer on a known case. Each recorded number says the machine, its load and the date. Budgets count bytes, rows read and statements, never milliseconds, so a busy machine cannot make them flaky. The spike S1 timings are the exception, measured once with their conditions written down.
