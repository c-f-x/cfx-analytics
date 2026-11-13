# Public readiness, 2026-11-11

What holds in this repository before it goes public as `c-f-x/cf-analytics` (issues #30 and #31). It covers /project-foundations step 1, /test-setup's survey, a scan of the full git history, and the gaps against cf-kit's conventions. Nothing was fixed in this pass. Each number names the command that produced it. The tree read is `origin/master` at `bb63715`.

## Conclusion

The code's guards hold, and no secret is in the history. Four things stop a public release today:
- Deployment values and the owner's addresses sit in tracked files, and the check that claims to forbid them does not.
- Five docs are false.
- There is no licence.
- At the tip, 15 tracked files hold the owner's addresses, Mac paths or Cloudflare ids, and 54 name the owner's domains or private products. The history holds the same, in more commits.

## Rules and their guards

From the table in `docs/engineering.md`, each rule checked against its guard.

| Rule | State | Why |
|---|---|---|
| Pure files do no I/O and never throw; slices meet through `index.ts`; each slice owns its SQL; no module-level state; no skeleton marker | Held | `scripts/architecture.test.mjs`, which also runs each check on a sample it must flag |
| A ProjectStore is addressed in the EU | Held | `scripts/architecture.test.mjs`; `scripts/wrangler-config.test.mjs` keeps the opt-out flag out of the config |
| No secrets or deployment values in `wrangler.jsonc` | **False** | `scripts/wrangler-config.test.mjs` fails only on a `vars` block and on credential-named keys. `env.production` holds the account id, the D1 id and four real hostnames, and the test passes |
| Applied schema steps never change | Held | `scripts/migrations.test.mjs` |
| Docs name only paths that exist, generated tables match, `CLAUDE.md` under 150 lines | Held | `scripts/docs.test.mjs`. It checks paths, not whether a sentence is true; five docs are false (below) |
| A run leaves nothing behind | Held | `scripts/run-scope.test.mjs` |
| An operation stops at its first failing step; a deploy names every undo and ships the bundle it checked | Held | `scripts/check.test.mjs`, `scripts/ops.test.mjs` |
| No promise unawaited; strict types | Held | oxlint type-aware; `tsc` strict with `noUncheckedIndexedAccess` |
| A project never reads another's data; access checks proven to guard | Held | recordings-04 and the heatmap tests; `scripts/guard-proof.test.mjs` removes each of 12 checks and expects a named test to fail |
| No IP address stored; the last of a daily cap goes to one request | Held | intake-07, cookieless-01; intake-09, events-04 |
| Each query reads at most 5,000,000 rows at S1's size | Held | `budget.size.test.ts`, in `pnpm check` |
| A build worker changes only its own files | Untested | `scripts/wave-check.mjs` runs only inside a build wave, never in CI |
| One rule, one home | Untested | The doc says so: nothing checks it mechanically |
| Every store has a lifetime row | Untested | No check. `docs/data-model.md` misses the watcher's KV namespace and `pnpm ops backup` folders, and names `pnpm run export`, which does not exist |

## Tests and CI

| Measure | Value | Command |
|---|---|---|
| `pnpm check`, whole | 187 s at load average 65 (61 s measured on 2026-10-22 at load 2) | `npx -y pnpm@12.14.0 check` |
| Worker tests | 839 in 74 files, 17.7 s | same run |
| Size tests | 12 tests, 128 s, 97 % of it in the tests | same run |
| Shared, dashboard, watcher tests | 18, 9 and 5 tests, each under 0.3 s | same run |
| A pull request's CI | 3 s queued, 132 s running (run 42239079046) | `gh run view 42239079046 --json jobs` |
| CI outcomes, last 100 runs | 58 passed, 1 failed, 4 cancelled | `gh run list --limit 100 --json conclusion` |

**Flaky:** the one failure, run 39816980459 on 2026-10-22, was `budget.size.test.ts`: "Hook timed out in 120000ms". Its fixture of 2 million events is built in a `beforeAll` hook. Under a busy Mac that build takes over two minutes. Today the whole file took 128 s at load 65. The root cause is building a fixed-size fixture against a fixed deadline. Step 6 measures it and fixes the cause.

**/test-setup:** the fast suite takes 18 s, so steps 2 and 3 apply: fast and heavy tests are already apart (`pnpm test` and `pnpm test:size`), and there is no changed-only run yet. Steps 4 and 5 are skipped, since nothing is slow enough to need them.

## History

Command: `gitleaks git . --log-opts="--all" --redact` over every branch. It scanned 160 commits; the other 4 of the 164 non-merge commits change no file (pleach's status commits).

- **Secrets: none.** One finding, `generic-api-key` in `apps/worker/src/platform/log.test.ts:38` (commit `c5245bd761`), is a made-up key in a test that proves keys are redacted from logs. Commit messages scanned apart: no secret.
- **Personal data and deployment values** (`git log --all -G<pattern>`, `git grep` at the tip):

| What | Commits | Files at the tip |
|---|---|---|
| The owner's Gmail address | 6 | `apps/worker/src/platform/env.ts`, `scripts/lib/dashboard-api.mjs`, `scripts/ops.test.mjs`, `cfanalytics:docs/plans/2026-10-21-overnight-goal.md`, `cfanalytics:docs/reviews/2026-10-22-overnight.md` |
| The owner's company address | 1, and 1 commit message | `apps/watch/src/index.ts`, `apps/watch/wrangler.jsonc`, `scripts/ops.mjs`, `docs/decisions.md`, `docs/operations.md` |
| Paths on the owner's Mac | 5 | `cfanalytics:docs/plans/2026-10-21-overnight-goal.md`, `docs/waves/w2/fill.plan.json`, `docs/waves/w3/close.plan.json`, `docs/waves/w3/fill.plan.json`, `docs/waves/w4/fill.plan.json` |
| The Cloudflare account id | 8 | both `wrangler.jsonc` files, `docs/operations.md`, `scripts/ops.test.mjs`, the overnight plan and review |
| D1 and KV ids | 5 | both `wrangler.jsonc` files, `docs/operations.md`, the overnight review |
| The owner's domains and product names | 18 or more | 36 files name a private product; 31 name one product's domain, most of them in the Jev review's raw answers and the list of consumers |

**Recommendation: publish a fresh history.** The current history stays private as the archive. Rewriting it would mean cleaning those values out of 164 commits by hand, and one missed value cannot be taken back once public. A fresh history has one starting commit from the cleaned tree, scanned again before it is pushed. The cost is that public readers do not see how the code grew; the decision log and specification keep the reasoning.

## Donors

`docs/donors.md` marks traks' period maths and bot lists and InsightFlare's bot classifier as "Copy". Every source line of 30 characters or more in this repository's apps, packages and scripts was compared with each donor at its pinned commit (traks `308d3f5`, InsightFlare `a4b67dd`, flarelytics `a493aec`, counterscale `de70cac`). The most any file shares with a donor is 6 such lines. Each is generic: joining byte chunks, WebCrypto calls, React hooks. So no donor code was copied, and `donors.md` is to say "Idea" rather than "Copy". `THIRD_PARTY_NOTICES.md` already holds the two sources that were copied: posthog-js's served scripts and cfmail's dashboard parts.

## False docs

- `README.md`: "Status: designed, not built". Production has run since 2026-10-22.
- `docs/operations.md`, line 3: "Staging runs; production does not exist yet."
- `apps/worker/wrangler.jsonc`, top comment: names the Access team domain and audience, which D-27 removed.
- `docs/decisions.md`: D-5 reads "accepted", though D-27 replaced its Access half. D-29 reads "provisional", though D-30 replaced its alert half.
- `docs/data-model.md`: the exports row names `pnpm run export`; the command is `pnpm ops export`.

## Vendor names, for the owner's decision

The analytics vendor's name appears in tracked files in these areas: `README.md` (3 mentions), `CLAUDE.md` (4), `THIRD_PARTY_NOTICES.md`, the worker's code (42 files, mostly package and protocol names), the compatibility suite (20 files), the dashboard (1), `packages/shared` (2), 11 top-level docs, `docs/spec/` (2), `cfanalytics:docs/research/` (21), `docs/reviews/` (4) and `docs/waves/` (8). The code's mentions are protocol names the SDKs send, such as `$posthog_cookieless`, and cannot change. Command: `git grep -liE posthog origin/master`.

## Gaps against cf-kit's conventions

| Section | Gap |
|---|---|
| 1, layout | No `docs/contract.md` (planned). `wrangler.jsonc` is at `apps/worker/`, not the root |
| 3, deploy path | `pnpm ops <command>`, not `pnpm ops <tool> <command>`. No `install` or `uninstall` |
| 4, deployment values | Held in tracked files; no site file. The check misses them (above) |
| 5, lifetimes | No lifetimes check. The sweep logs `sweep`, not `sweep_done` |
| 6, health | `/healthz` answers `{"ok":true}`, without `parts`. The watcher mails the owner, which the family gives to cf-status |
| 7, backups | No round-trip test |
| 11, installing | No `.dev.vars.example` or `site.example.jsonc` |
| 14, public text | No names check |

Sections 3, 6 and 11 wait for the kit's shared code (cf-kit D-5); this pass closes 4, 5 and the docs.
