# Build plan

The handover for the agent that builds cfx-analytics. It is one continuous build of the whole architecture (decision D-11). The steps below are an order of dependencies, not releases. Each step lands as one or more pull requests, each reviewed with `/code-review` before merge. Nothing is deployed to Cloudflare without the owner's go.

## Before you start

Read `AGENTS.md`, then the docs it lists. When a decision looks wrong to you, say so before building around it.

The foundations are in place: the doc, architecture, config, schema-step, run-scope and check-runner guards, and the tooling. Keep every guard green, and add the guard named in `docs/engineering.md` when the code it guards lands.

## How the build runs

Claude writes a skeleton of every file and audits. DeepSeek workers fill the skeleton in, one wave at a time (decision D-17).

1. **Skeleton.** On the branch `build/skeleton`, Claude writes these in full: the shared types and zod schemas, the platform folder, the schema steps, the composition root's wiring, and every test. Each test names its behaviour ID and fails. Every other function gets its exported signature and a comment saying what it must do and which behaviour IDs it serves. Its body calls `unbuilt("<slice>.<function>")` from `unbuilt.ts` in `apps/worker/src/platform/`, a file that exists on build branches only. Neither the marker nor its file may reach master: `scripts/architecture.test.mjs` fails while any remain.
2. **A wave.** A branch `build/w<N>` from master takes the wave's files from the skeleton. From wave 2 the wave runs as pleach plans (decision D-23). Each slice goes to one worker, in its own worktree under the system temp folder, on its own branch `build/w<N>-<slice>`. A worker is DeepSeek V4.1 Flash (`deepseek-flash`) running as a Claude Code worker through umbel. Its prompt names its own files and tests, and points at `docs/build-worker.md`. Up to five workers run at once.
3. **Done.** A worker is done when its tests, lint on its own files and `pnpm typecheck` pass, and `node scripts/wave-check.mjs <base> <own files>` shows it changed nothing else and left no marker.
4. **Audit.** Claude merges the workers' branches into `build/w<N>`, reads every line, runs `pnpm check` and `/code-review`, and fixes what is wrong. The wave lands as one pull request. Its numbers go into `docs/reviews/build-ledger.md`: tests passing on arrival, lines the audit changed, tokens and balance from `node scripts/wave-usage.mjs`. A signature or test the audit changed goes back into `build/skeleton` before the next wave. Each worktree goes to the Trash once its branch is merged.
5. **Spend.** The DeepSeek account held 6.76 USD on 2026-10-20. Claude asks the owner before it falls under 1 USD.
6. **Kill criterion.** If the audit still changes more than a third of the workers' lines after two waves, or a worker keeps working around its tests, the remaining waves go to Sonnet. The ledger records what was learned either way.

The spikes are the trial run of this method. Their code lives only on its branch. Their reports land on master.

## 1. Two spikes that can stop the project

Run both before any feature code, and write each result with its numbers and conditions to a dated report in `docs/reviews/`.

Both passed on 2026-10-20: S1 with its batch line restated (D-18, `docs/reviews/2026-10-20-spike-s1.md`), and S2 as written (`docs/reviews/2026-10-20-spike-s2.md`).

**S1. One ProjectStore answers the dashboard.** Load a ProjectStore under `wrangler dev` with the schema and indexes in `docs/data-model.md`:
- 2,000,000 synthetic events: 50 event names, 20,000 people, 13 months of timestamps
- 50,000 heatmap points

Measure:
- a 30-day trend broken down by country
- a 3-step ordered funnel with a 7-day window
- 8-week retention cohorts
- a heatmap for one path and width band
- a 100-event intake batch, alone and while the funnel query runs

First check the timer on a known case.

- **Passes** when each query answers in under 2 seconds and the batch commits in under 100 ms.
- **Fails** otherwise. Then try daily rollup tables inside the same object and measure again. If that fails too, stop and bring the numbers to the owner.

**S2. The real SDKs work unchanged.** Build the smallest intake that stores events and snapshots, and point each SDK at `wrangler dev`:
- posthog-js in Playwright, with recording and heatmaps switched on by our remote-config answer
- posthog-node
- posthog-ios in a macOS command-line target

Confirm that events, batches, identify, alias, cookieless mode, recording chunks and heatmap points arrive as `docs/spec/posthog-protocol.md` describes.
- **Passes** when every SDK delivers with no setting beyond the host.
- **Fails** when one needs a patched SDK. Record which and why, and ask the owner before continuing.

The spike code is throwaway. It is moved to the Trash once its report is written, and the real slices are built test-first.

## 2. The specification

Complete `docs/spec/behaviours.md` by harvesting the donor tests as that file describes, and by reading `docs/spec/posthog-protocol.md`. Write the failing test for every `keep` and `adapt` line into the skeleton. A test reaches master with the code that passes it.

## 3. The Worker slices

Build in dependency order, each slice test-first until its tests pass. Slices in one wave depend only on earlier waves, so their workers run side by side:
1. Wave 1: `platform`, `projects` and `enrich`
2. Wave 2: `intake`, `cookieless`, `identity` and `events`, which share one transaction. Before its skeleton, fit the daily event cap and the retention to one object's 10 GB: S1 measured about 530 bytes an event, so 10 GB holds about 19 million (`docs/reviews/2026-10-20-spike-s1.md`, finding 2).
3. Wave 3: `config`, `recordings` and `heatmaps`. posthog-js sends `$pageleave` on a same-tab link navigation in a headed Chrome, checked on 2026-10-21 (S2 report, finding 3), so scroll depth can rely on it.
4. Wave 4: `query` and `privacy`

The scripts that create a project and issue its keys need a person at a terminal, like cfmail's admin procedures.

## 4. The dashboard

Agree the visual reference with the owner first (`docs/design.md`). Then build the web slices in `docs/architecture.md` as wave 5, each against the Worker's real API in tests. Screens wait for the owner's review before merge.

## 5. Operations

As wave 6, add these, each a single command that stops at its first failure and says how to undo each step before it acts:
- deploy: dry run first, and the build that was checked is the build that ships
- backup and restore
- export
- the health check and how the owner hears of failures

Record each in `docs/operations.md`. Creating the Cloudflare resources waits for the owner's go.

## 6. Moving projects over

Each move is a pull request in that project's repo, made with the owner's go.
- **The hand-built client.** Its analytics config answers our host. Its `visits()` door calls `/api/external/query` with a project secret key. Its list of processors and its privacy policy drop PostHog.
- **The posthog-js site.** `NEXT_PUBLIC_POSTHOG_HOST` points at its intake host, and its posthog-js version matches the one cfx-analytics serves (D-15). Its privacy text names cfx-analytics and the recording retention.

## Review points

After the spikes, after the Worker slices, and after the dashboard, stop:
1. Re-read all code written so far against `docs/architecture.md` and `docs/engineering.md`.
2. Run `/code-review` on the whole tree.
3. Report to the owner what changed from this plan, and why.
