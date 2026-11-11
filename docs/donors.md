# Donors: what we take, from where

All donors are MIT licensed. Read them at the pinned commit, never at HEAD, so this list stays true.

When code is copied or closely adapted, add the donor's copyright notice to `THIRD_PARTY_NOTICES.md` in the same change. Ideas and behaviours need no notice. On 2026-11-11 every source line of 30 characters or more was compared with each donor at its pinned commit, and none was copied (`docs/reviews/2026-11-public-readiness.md`, Donors).

PostHog's protocol comes from PostHog's own MIT SDKs and docs (`docs/spec/posthog-protocol.md`). Nothing is taken from a project without a licence.

## Pinned commits

| Donor | Commit | Used for |
|---|---|---|
| [shivamanupadi/traks](https://github.com/shivamanupadi/traks) | `308d3f5b34` | Period maths, single-scan query ideas, visitor hash, referrer cleaner, bot lists |
| [RavelloH/InsightFlare](https://github.com/RavelloH/InsightFlare) | `a4b67dd447` | Bot classifier, funnel planner, batching pattern, architecture check idea |
| [kalle-works/flarelytics](https://github.com/kalle-works/flarelytics) | `a493aece75` | Pure SQL templates with SQL-text tests |
| [PostHog/posthog-js](https://github.com/PostHog/posthog-js) | `3deae66003` | The browser and Node protocol, the compatibility tests' client, and the lazy scripts we serve (D-15) |
| [PostHog/posthog](https://github.com/PostHog/posthog) | `edc1585d12` | Reference only: its capture service confirms server behaviour (clock skew, cookieless hashing). MIT outside `ee/`; no code taken |
| [PostHog/posthog-ios](https://github.com/PostHog/posthog-ios) | `ed6d2dd8b6` | The protocol from a macOS app |
| [benvinegar/counterscale](https://github.com/benvinegar/counterscale) | `de70cac29a` | Test ideas only, harvested into `docs/spec/behaviours.md`. No code (see below) |
| [rrweb-io/rrweb](https://github.com/rrweb-io/rrweb) | pinned when added | Replayer and player for recordings and heatmap backgrounds |

## Take

| What | From | Into slice | How |
|---|---|---|---|
| Period, time zone and daylight-saving maths (`resolvePeriod`, `previousRange`, bucket generation) | traks `packages/shared/src/queries.ts:202-472` | `query` | Idea; written with `now` and `tz` passed in, and with the DST and date-line tests traks never wrote |
| Comparing this period with the last in one scan, and conditional aggregation | traks `queries.ts:534-797` | `query` | Ideas only; rewrite for SQLite with bound parameters |
| Visitor hash rotating daily, refusing an empty secret | traks `apps/platform/collect/src/index.ts:152-211` | `cookieless` | Adapt to PostHog's inputs (project, salt, IP, user agent, host) |
| Referrer cleaner | traks `collect/src/lib/referrer.ts` | `enrich` | Idea only; written from `docs/spec/behaviours.md` (enrich-19 to enrich-22) |
| Bot and AI-referrer lists | traks `packages/shared/src/bots.ts`, `ai-sources.ts` | `enrich` | Idea; the bots come from `isbot` (MIT), a dependency, and seven AI crawler names of our own (`apps/worker/src/features/enrich/bots.ts`) |
| Bot classifier and its test | InsightFlare `src/lib/edge/collector/bot-protection.ts` | `enrich` | Idea; ours uses `isbot` (MIT) too |
| Funnel planner: staged steps, conversion window, structural budgets | InsightFlare `providers/d1/internal/funnel-planner.ts` | `query` | Port the algorithm onto our `events` table; it already targets SQLite |
| Batching with a revision check, so a late write never overwrites a newer one | InsightFlare `src/lib/edge/ingest/flush.ts`, `scheduler.ts` | `events`, `recordings` | Pattern only; never the 1,905-line class |
| Architecture allowlist check | InsightFlare `scripts/check-architecture.ts` | `scripts/` | Idea; we keep fewer rules |
| Pure SQL templates with table-driven SQL-text tests | flarelytics worker query templates | `query` | Pattern |

## Do not take

| What | Why |
|---|---|
| Any donor's dashboard UI | Huge (InsightFlare's is 119k lines), and not our design |
| traks' route and page monoliths, its isolate globals, its UA parser, its session model | Hidden state; it misdetects Samsung Internet and iPads; it has no identified users |
| InsightFlare's query engine, filter DSL, typed DAL and SQLite stand-in for D1 | 77k lines with three SQL paths half-migrated; we test on real runtimes (D-12) |
| counterscale's query class, R2 rollup and tracker | SQL injection across sites; the rollup never merges and is never read; posthog-js is our tracker |
| flarelytics' funnel queries | Unordered daily ratios, not funnels |
| workers-sentinel | Error tracking is not built (D-11) |
| Every donor's legacy shims, demo modes and mock providers | Against our rules |
