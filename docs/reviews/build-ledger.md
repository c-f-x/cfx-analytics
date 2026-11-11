# Build ledger

One row per wave of the skeleton-and-waves build (decision D-17, `docs/build-plan.md`). It is the evidence for the kill criterion: if the audit still changes more than a third of the workers' lines after two waves, the remaining waves go to Sonnet.

How each number is taken:
- **Tests on arrival** are the wave's tests that pass on the workers' merged branches, before the audit changes anything.
- **Audit share** is the lines the audit added or changed, divided by the lines the workers wrote, from `git diff --numstat` between the merged workers' commit and the audited commit.
- **Tokens** come from `node scripts/wave-usage.mjs` over the workers' transcripts. Input is uncached input.
- **Balance** is the DeepSeek account after the wave.

| Date | Wave | Workers | Tests on arrival | Audit share | Tokens (input / cached / output) | Balance (USD) | Notes |
|---|---|---|---|---|---|---|---|
| 2026-10-20 | smoke | 1 | 1 of 1 | none | 57,796 / 115,712 / 743 | 6.75 | Trivial task, to check the wiring. The worker followed the owner's global rules and used tilth. |
| 2026-10-20 | S1 | 2, then 1 for a second round | 26 of 26, then 9 of 9 | 7 of 1,222 lines (0.6%) | 276,129 / 13,697,408 / 175,096 | 6.55 | Spike S1. The audit changed only how the run starts wrangler, after a process leak that was the skeleton's fault. Report: `docs/reviews/2026-10-20-spike-s1.md`. |
| 2026-10-20 | S2 | 4, the routes worker after the decode worker | 30 of 30 | 75 of 1,510 lines (5.0%) | 336,657 / 13,873,408 / 137,400 | 6.37 | Spike S2. Every audit change came from running the real SDKs, which no worker could do. Report: `docs/reviews/2026-10-20-spike-s2.md`. |
| 2026-10-21 | 1, tests | 4 test workers | 240 tests drafted, 237 fail on a marker, 4 pass on code written in full | 9 changes to tests and contracts | see below | 5.55 | First test round of D-21. Report below. |
| 2026-10-21 | 1, fill | 4 fill workers | 239 of 241; the other two failed on faults in the tests | 54 of 1,458 lines (3.7%) | 410,774 / 21,273,472 / 221,540 | 4.93 | Platform, projects and enrich filled. The fill round cost 0.62 USD. Report below. |
| 2026-10-21 | 2, tests (pleach) | 1 Opus outline, 4 DeepSeek test nodes, 1 command sink | 184 tests, all failing on a marker; 83 of 88 behaviours covered, 5 deferred by the map | 76 of 3,508 test lines (2.2%) | DeepSeek 610,822 / 17,205,120 / 256,641; Opus outline 13,950,407 cached, 118,456 out (subscription) | 4.25 | First pleach run (D-23): six nodes, none failed or retried, landed by fast-forward. The test round cost 0.68 USD. Report below. |
| 2026-10-21 | 2, fill (pleach) | 6 DeepSeek fill nodes, 1 Opus close with a codex audit | 2 fills stopped with BLOCKED.md on 4 test faults and 1 contract fault; after the fixes, every gate green | 24 of 1,335 source lines (1.8%) after the land, plus 5 test and contract fixes before it | DeepSeek 1,210,723 / 36,344,704 / 419,123 | 2.64 | Five runs to land: two blocked fills, one lint miss of the audit's, one audit with no verdict block (jahala/pleach#149). The fill round cost 1.61 USD, so wave 2 cost about 2.30 USD in all. |
| 2026-10-21 | 3, tests (pleach) | 1 Opus outline, 3 DeepSeek test nodes, 1 command sink | every mapped behaviour covered; 3 tests pass on earlier waves' code | 1 contract decision (heatmaps-21) and its test | see the fill row | 1.67 | One test node stalled on a 16-minute DeepSeek call and was resumed. The tests round cost 0.97 USD. |
| 2026-10-22 | 3, fill (pleach) | 8 DeepSeek fill nodes, 1 Opus close with a codex audit | 3 fills stopped with BLOCKED.md on 4 test faults; 2 fills lost both attempts to a network outage | 7 of 1,671 source lines after the land | see the fill transcripts | 9.70 | Six runs. The recordings HTTP fill was brought in by hand from its quarantine (jahala/pleach#152). The fill round cost 1.97 USD, so wave 3 cost 2.94 USD in all. |

## What we learned

Written after each wave: what the workers got wrong, and what the next skeleton does about it.

### S1 (2026-10-20)

- Three times a worker stopped at a fault in the skeleton instead of working around it: a tsconfig stricter than the file it imports, a JSDoc type that no longer matched, and a brief its test could not pass. All three faults were Claude's. The brief's "stop and say so" rule works, so the skeleton has to be right, and its faults show up fast.
- One final report claimed something the code does not do. It said people are picked with a Zipf weight, but the code picks them uniformly, as the spec asked. The audit reads the code, not the report.
- The worker's SQL was good. It used the indexes well, and it found two SQLite facts the skeleton did not know: `rowsWritten` counts index entries, and bound numbers arrive as REAL.
- umbel reported a stop once while the worker still held the prompt in its queue. When a stop comes with no final message, look at the pane before reading.
- One worker ran two rounds and came within 9% of its context limit. Each round now gets a fresh worker.
- A Claude Code worker sends about 58,000 tokens a call, most of them cached. Two workers and a second round cost 0.20 USD in all.

### S2 (2026-10-20)

- Workers again stopped at faults in the skeleton: a page link that dropped its own settings, a deprecated initialiser in a comment, and an RPC return type that workers-types turns into `never`.
- All 1,510 lines arrived passing their unit tests. The audit's 75 lines all came from running the real SDKs end to end: posthog-js's bot filter, `$pageleave` timing, and posthog-ios's state folder. No worker could have found these, because none could run the whole spike. The skeleton should name a runnable end-to-end check earlier, so the last worker of a wave can run it.
- Inside a wave, a worker whose tests call another worker's files starts after that worker merges. Here the routes worker waited for the decode worker.
- After two waves the audit share is 0.6% and 5.0%, far under the kill criterion's one third. The method continues for wave 1.

### Wave 1, test round (2026-10-21)

- Four DeepSeek workers drafted 240 tests from the behaviour lines, against the frozen signatures. Each test names its behaviour ID. They use real D1, Durable Objects and the Cache API, real eviction, real RS256 keys, and poisoned bindings to prove what a path must not touch. None mocks our code.
- Every worker reported the clauses it could not reach through the signatures, instead of weakening them. Their notes found real faults: a failed schema step had no error value, the Access refetch on an unknown key could not be injected, a behaviour line contradicted its donor (enrich-28), and three clauses were untestable as written.
- The audit changed contracts and lines where the workers were right, and fixed four tests: one that expected a throw, one that followed the wrong reading of enrich-28, one that tested rules as JSON text, and duplicated helpers moved into one shared file. It added one test, for the Access refetch.

### Wave 1, fill round (2026-10-21)

- Four DeepSeek workers filled 16 files, 1,458 lines, in parallel. Each kept to its own files and left no markers (`scripts/wave-check.mjs`). The audit changed 54 of their lines.
- Two tests failed on faults in the tests, and both workers found the cause instead of bending the code. A stream with the default high-water mark pulls once when it is built, so "no pull before reading" needs a high-water mark of 0. The Workers test pool reports every rejected Durable Object RPC call as unhandled (workers-sdk#7707). That one changed the design: store calls now answer failure as a value (D-22).
- The audit found three faults no test caught. A 512-character cut-off hid long user agents that name a bot. Registry failures sent D1's own error text to the caller (platform-42 now covers it). Three helpers were written twice across enrich's files. Workers write what their own file needs, so the audit looks for repeats across files.
- One worker reported a check it ran by copying another worker's unfinished file into its tree and removing it again. The result was right, but the brief should say that a worker's tree holds only its base and its own files.
- `scripts/guard-proof.test.mjs` now proves the nine access checks guard: each removed check fails its named test (platform-15).

### Wave 2, tests round under pleach (2026-10-21)

- The run needed no hand-merging: six nodes closed on their first attempt, and `pleach land` fast-forwarded `build/w2`. Two pleach faults cost a restart before any node ran: a relative `--config` path (jahala/pleach#148), and Biome formatting the committed plan, which the outline fixed for itself.
- The Opus outline did what a skeleton author has to: it reconciled the drafts with wave 1, applied D-22, narrowed ingest to this wave, mapped all 88 behaviours, and asked eight questions instead of guessing. Its `surfaceUnbuilt` makes a marker inside a route reach the test by name, which the red gate needs for HTTP tests. Its 800-line capture helper let four workers share one way to build SDK requests and read a store back.
- The DeepSeek test nodes wrote 184 tests, one or more for every behaviour their tables gave them, with no mocks and no fixed waits. Their handbacks found what the contracts left open: a STRICT type violation throws even under `INSERT OR IGNORE`, and two identity rules differ from PostHog's merging.
- The audit changed 76 lines. Five "no store contacted" checks asked about a project the request never named, which is always true; they now poison every ProjectStore. A batch of 250 events was missing, though posthog-js can send one. A pure time test had a tolerance it did not need. Setup requests now check their answers.
- One test idea to keep: a check that something was not touched is only worth having when the thing could have been touched. Poisoning the binding makes it so.

### Wave 2, fill round under pleach (2026-10-21)

- Two fill workers stopped with BLOCKED.md instead of bending code to fit, and both were right. Between them they found four test faults the test audit had passed: a key test and a depth test that contradicted their own contract, a seeded cap that never reached the batch through the helper, and two projects' session rows compared whole. They also found one contract that forced a workaround: `sessionFor` took a ready session id, and now takes a function. All five were found by running the tests against real code, which a test audit cannot do.
- pleach handled every block as designed: no retry, the tree kept on `quarantine/<id>`, the reason in the journal. None of the five extra runs was pleach's fault, so D-23's kill criterion is untouched. They cost one restart each, because a fix to the base needs `--fresh` and a set-aside branch for a verified node that must fill again.
- The audit's own lint miss cost a run. Every edit the audit makes to a test between runs now gets lint, typecheck and the red gate before the rerun.
- The codex audit needs a command that prints pleach's verdict block. The wrapper lives outside the repo, so no builder can rewrite its gate (jahala/pleach#149).
- The Opus close did what a merge of six fills needs: it removed the build-branch markers, and gave two rules that fills had each written their own copy of (`calendarDay`, `messageOf`) one home.
- After the land, the audit fixed three gaps and gave each a test: fractional event times reaching a STRICT INTEGER column, a STRICT refusal escaping as a throw, and linked ids that skipped the distinct id limit (identity-21).
- Audit habits from this round: follow a seeded value through every helper it passes, and read each fill's handback before its code.

### Wave 3 under pleach (2026-10-21 and -22)

- The outline left heatmap points outside every daily cap. The audit made each `$$heatmap` event count against the events cap (heatmaps-21), so the bill stays bounded the way D-20 intends.
- Four more test faults reached the fills, all of one kind: an assertion that contradicts its own contract or itself. The 23-hour daylight-saving day was the wrong date. A five-character value was expected to mask to six asterisks. A helper reordered an event's keys. An assertion read one `data` level too deep. Each fill worker found its fault by running the test against real code, wrote BLOCKED.md, and was right.
- A test audit can catch this kind by working each assertion's arithmetic by hand (counts, lengths, dates, nesting) instead of reading for intent. The next wave's test audit does that.
- pleach costs that were not the work's: a network outage burned both attempts of two fills at once (jahala/pleach#151). A single slow DeepSeek call read as idle, twice (jahala/umbel#117). And a test fix on the target branch could not reach a node whose needs were all closed (jahala/pleach#152). The way out was `land --sinks`, the worker's file brought in by hand with its own gate run on the landed base, and the close as a one-node plan. None of the three is a run pleach itself failed, so D-23's kill criterion is untouched.
- The Opus close gave one home to four answer helpers that several routes had copied. The audit then did the same for `DAY_MS` and the store's bound-parameter limit, and added the three new dashboard routes to the guard proof.

### Wave 4 under pleach (2026-10-21)

- The test audit worked every expected value out by hand, as wave 3's ledger asked, and fixed seven tests before any fill ran. The fills still found nine more: an SQL error that named the table before the column, `getAlarm` answering the wall clock for an alarm set in the past, a store never bound, an empty store that rightly dropped its alarm, a JWT sent where only a key was meant, and three more of the same kind. A test audit catches arithmetic; only running the tests against real code catches how the platform behaves.
- Two fills blocked on those faults, and the third need of their dependants could not reach them (jahala/pleach#152). The recovery was wave 3's: land the five verified fills, bring the blocked workers' finished files in by hand, fix the tests, and fill the privacy routes as a one-node plan. pleach failed no run itself.
- The rows budget (D-18) was only checked by the query-route node, so the four kind files that write the SQL never met it. At spike S1's size they read 780 million rows for a trend, 41 million for a funnel, 44 million for the property list and 6.3 million for retention. D-26 rewrote them: a named index for trends (Durable Objects refuse the pragma that would stop SQLite's automatic indexes), one ordered pass per visitor folded in the store for funnels and retention, a trend fold for totals and ranking, and a bounded sample for properties. Lesson for the fill split: a size test belongs to the node that writes the SQL it measures.
- D-25 makes every query kind count a visitor as the person, else the distinct id. Funnels and retention had counted people only, which would have hidden the posthog-js site's anonymous visitors. The owner confirmed the rule.
- The fills copied helpers the code already had, in up to six places each: SQL fragments, the visitor rule, base64url, JSON pointers, splitting into runs, the time helpers and the JSON body ladder. Each now has one home. The audit also found the projects routes reading bodies with no size limit (projects-39), two cache headers for dashboard answers, and the sweep running SQL itself, which the architecture check caught after the hand landing.
- The guard proof now covers the query and privacy routes.

