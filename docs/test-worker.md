# Brief for a test worker

You write the failing tests for part of a wave, before anyone writes the code (decision D-21). The signatures and their comments are frozen: they are the contract you test against. Your prompt names the behaviour IDs you cover, the test files you own, and the commit your branch started from (the base).

## Read first

- `CLAUDE.md`, then `docs/engineering.md`, especially "Testing".
- Each behaviour line your prompt names, in `docs/spec/behaviours.md`. The line is the specification. Test what it says, all of it, and nothing it does not say.
- The source files your behaviours point at: their exported signatures and the comments above them.
- `docs/data-model.md` when a behaviour touches a store, and `docs/spec/posthog-protocol.md` when it cites a section.
- The helpers in `apps/worker/test/helpers/`. Use them rather than writing your own.

## What a test must be

- Its title starts with the behaviour ID it proves: `it("projects-14 · a new key is shown once and only its hash is stored", ...)`. One behaviour may need several tests. Every behaviour you were given gets at least one.
- It fails now, and only because the code is not built. Run it: each failure must come from an `unbuilt: <name>` error, or from an assertion on what an `unbuilt` function would have answered. A failure for any other reason means the test is wrong.
- It goes through a real boundary: a pure function's input and output, an HTTP request through `SELF.fetch` or the exported app, an RPC call, or real D1, Durable Object and R2 storage in the Workers pool.
- It mocks nothing of our code. The only stand-ins allowed are the outside world's inputs: request bodies, clocks and random bytes passed in as values, Cloudflare's OAuth endpoints passed as `deps.fetch`, and dashboard sessions signed by `apps/worker/test/helpers/session.ts`.
- It holds on a busy machine. Wait for the event, never a fixed time. Pass time and ids in. Claim no fixed port, name or path. Give each test its own project id or object name, so tests never share rows.
- It is tested at the size it meets in use when the behaviour names a size.
- Every expected value is worked out by hand from the contract and checked: a count, a length, a date in a time zone, a level of nesting. Wave 3's faults were all of this kind: a daylight-saving day on the wrong date, six asterisks for five characters, keys a helper reordered, a value read one level too deep.
- A value the test seeds, such as a project's settings or a clock, reaches the code under test. Follow it through every helper the test calls, and pass it on where a helper would put its own default in its place.

## What you may change

Only your own test files, and new files under `apps/worker/test/helpers/` that your prompt names. Never a source file, a schema step, `package.json` or another worker's test.

If a behaviour cannot be tested through the frozen signatures, or the line and the comment disagree, do not work around it. Skip that behaviour and say why in your final message. Never weaken an assertion to make a test easier to write.

## Done

You are done when every one of these exits as stated. Read each exit code, and never decide with `grep` on the output.

```
node scripts/wave-check.mjs <base> <your own files>      exits 0
pnpm exec oxlint --type-aware <your own files>           exits 0
pnpm exec biome check <your own files>                   exits 0
pnpm typecheck                                           exits 0
pnpm --filter <package> exec vitest run <your files>     exits 1: every test fails, each on a marker
```

Then commit on your branch, with a message that lists the behaviour IDs covered. Do not push. Do not open a pull request. Do not touch Cloudflare.

## When pleach runs you

From wave 2, pleach starts you in a detached worktree and runs your gate itself (decision D-23). Then these replace the steps above:
- Your prompt names your gate, a `pnpm wave:gate` command. Run it through the pinned pnpm, as `npx -y pnpm@12.14.0 wave:gate ...`, and read its exit code. It runs the checks above with `HEAD` as the base.
- Leave your work uncommitted. Do not create a branch. pleach commits what passes its gate.
- If a fault in the skeleton or the specification stops you, write `BLOCKED.md` at the repository root. Say what is wrong, where, and what would fix it. Then stop. pleach does not ask again, and the audit reads it. Once it exists, your gate fails at its wave check, so report the gate's exit code from the run before you wrote it.

## Your final message

- Each behaviour ID with the test titles that cover it.
- Any behaviour you skipped, and why.
- The commands above and their exit codes, and how many tests failed on a marker.
- Anything in the signatures or the specification you think is wrong.
