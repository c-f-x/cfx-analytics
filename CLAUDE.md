# cfx-analytics

Product analytics for the owner's projects, running on Cloudflare. It accepts what PostHog's SDKs send, keeps each project's data in its own Durable Object, records sessions into an R2 bucket, and draws heatmaps. Each installation chooses where its data is stored; the owner's is in the EU (D-38). It is our own code, built from parts and test ideas harvested from MIT projects.

**State (2026-11-11): production runs, and this repository is its home.** The build runs by the skeleton-and-waves method of decisions D-17 and D-21, and from wave 2 as pleach plans (D-23, `docs/waves/`). Waves 1 to 4 are filled and audited (`docs/reviews/build-ledger.md`), and so are the real-SDK suite, the dashboard (`apps/web`), Cloudflare sign-in (D-27) and the operations commands (`pnpm ops`, `docs/operations.md`). Production runs on the dashboard's host and each product's own intake host (D-16, D-31), and replaced staging (D-30); `apps/watch` emails the owner when it fails. Where it runs lives in a private site file named by `CFX_SITE`, never in this repository (D-32, `docs/operations.md`). This repository, `c-f-x/cfx-analytics` (named `cf-analytics` until D-34), began on 2026-11-11 from the cleaned tree of `jahala/cfanalytics` with a fresh history; the old repository is archived and private. Next: the c-f-x ground rules (cfx-kit D-8), then the owner's go to make it public.

## Start here

| Doc | Read it for |
|---|---|
| `docs/build-plan.md` | The order of work, how it is built in waves, and the two spikes that can stop the project |
| `docs/build-worker.md` | The brief every DeepSeek build worker follows |
| `docs/waves/` | Each wave's pleach plans and its map of behaviours to tests and fills (D-23) |
| `docs/decisions.md` | Decisions already made, with reasons. Check it before asking the owner. |
| `docs/architecture.md` | The parts, slices, flows and dependency rules |
| `docs/data-model.md` | Every store, its lifetime, and the schema steps |
| `docs/engineering.md` | How code is written and tested, and the guard behind each rule |
| `docs/operations.md` | Cloudflare resources, commands, health |
| `docs/onboarding.md` | Connecting a website or a server, and seeing that its events arrive |
| `docs/design.md` | Where the dashboard's look comes from |
| `docs/spec/behaviours.md` | The specification. Tests are written from it, before the code. |
| `docs/spec/posthog-protocol.md` | What the PostHog SDKs send and expect, from their source |
| `docs/donors.md` | What to take from which project, at which commit |

## Hard rules

- The trunk is `master`. Work on a branch and open a pull request.
- The lead deploys checked work from current `master`: dry run first, then `--go`, then `pnpm smoke production` (D-36). Creating or deleting a Cloudflare resource, deleting or restoring data, and anything that costs money need the owner's explicit go.
- Delete with `trash`, never `rm`. A run may `rm` a temp folder that the same run created.
- A test comes before the code it proves, and names the behaviour ID it proves (`intake-03`). Never delete a failing test.
- No mocks of our own code, no stubs, no TODOs, no fallbacks and no compatibility shims without the owner's approval.
- Take nothing from a project without a licence: its code and tests are all rights reserved.
- Copied third-party code gets its licence notice in `THIRD_PARTY_NOTICES.md` in the same change.
- A change fixes every doc it makes false, in the same pull request. `pnpm docs:gen` rewrites the generated tables.
- When you add code that a rule in `docs/engineering.md` says "nothing yet" about, add its guard in the same change.

## Writing

Docs, comments, commits and pull requests follow the owner's writing rules: plain language, short sentences, no em dashes. Commit bodies explain why.

## Test strategy

Measured on the owner's Mac on 2026-10-22 with a load average near 2, through `npx pnpm`, after the dashboard. Measure again when a wave lands.

| Command | Checks | Time |
|---|---|---|
| `pnpm lint` | oxlint (type-aware) and Biome | about 1 s |
| `pnpm typecheck` | `tsc` in every package, and the scripts with `checkJs` | about 1 s |
| `pnpm test` | Worker and shared tests, and the script checks under `scripts/`, including the guard proof | about 16 s: the Worker's 839 tests, the shared package's 18, the dashboard's 9 and the watcher's 5, then the script checks, of which the guard proof is the longest |
| `pnpm test:size` | The real-size tests (`*.size.test.ts`), such as query-09's 2 million events, which `pnpm test` leaves out | about 50 s |
| `pnpm compat` | The real posthog-node, posthog-js and posthog-ios against the Worker under `wrangler dev` (`apps/compat`, `--only` picks clients). Not part of `pnpm check`: run it before a pull request that touches intake, config, recordings, heatmaps or identity | about 28 s with the Swift build cached; the first run builds posthog-ios |
| `pnpm e2e` | The dashboard end to end: every screen against the Worker under `wrangler dev`, in light and dark (`apps/compat/dashboard.mjs`; `--shots <folder>` keeps a picture of each). Not part of `pnpm check`: run it before a pull request that touches `apps/web` or a route the dashboard reads | about 27 s |
| `pnpm smoke <env>` | A deployment end to end: health, the signed-out refusal, and the real posthog-node and posthog-js with a recording and heatmap points. Run it after every deploy | about 11 s against production |
| `pnpm check` | Lint, typecheck, test and the size tests in order, then the dashboard's build and the Worker's, stopping at the first failure | about 61 s |

When each runs:
1. **While working:** the test files you touch, such as `pnpm --filter @cfanalytics/worker exec vitest run <file>`. A change only under `scripts/` may run `node --test "scripts/**/*.test.mjs"` alone.
2. **Every pull request:** `pnpm check`, which includes the size tests. CI runs it again on the pull request's merge result. Add `pnpm compat` or `pnpm e2e` when the change touches what they cover.
3. **The main line after each merge:** CI runs `pnpm check` on every push to `master`.
4. **A release:** `pnpm check`, `pnpm compat` and `pnpm e2e` on a fresh clone. There are no releases yet.

The fast suite takes under 30 s, so there is no changed-only run: when unsure what a change touches, run everything. Check each command's exit code. Never filter its output with `grep` to decide whether it passed.

## CI

CI runs on GitHub's hosted runners (`ubuntu-latest`). This repository is to be public, and a runner on the owner's Mac would run any pull request's code, so it has none. The repository variable `CI_RUNS_ON` can name other runners as a JSON value. Measured on 2026-11-11: `pnpm check` takes about 7 minutes there, of which the Worker's tests take about 140 s and the size tests about 176 s.

## Tooling

pnpm is pinned in `packageManager`. If the installed pnpm differs, run it through `npx -y pnpm@<pinned>`. Node is pinned in `.node-version`.
