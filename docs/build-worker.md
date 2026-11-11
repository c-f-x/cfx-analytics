# Brief for a build worker

You are filling in part of a skeleton that Claude wrote (decision D-17, `docs/build-plan.md`). Your prompt names your own files, the tests that prove them, and the commit your branch started from (the base).

## Read first

- `CLAUDE.md`, then `docs/architecture.md` and `docs/engineering.md`.
- `docs/data-model.md` when your files touch a store: a `store.ts`, a schema step, or anything that keeps, ages or deletes data. Every store says how long it keeps its data and what removes the rest.
- `docs/decisions.md` when a choice in the skeleton looks wrong to you. Check whether a decision already explains it before you say so.
- The line in `docs/spec/behaviours.md` for each behaviour ID your tests name.
- Every section of `docs/spec/posthog-protocol.md` that a comment in your files cites.

## What you may change

Only the bodies of the functions in your own files. A body that calls `unbuilt(...)` is yours to write. Remove the `unbuilt` import once nothing in the file uses it. You may add private helpers inside your own files.

You may not change these:
- an exported name, parameter, parameter type or return type
- any test, fixture or other file not named in your prompt
- the schema steps, `packages/shared`, `package.json` or the lockfile

Your tree holds the wave's base and your own files, nothing else. Do not bring in another worker's files, even for a moment. A test that needs another worker's file may fail until that file lands. Say so in your final message.

If a signature, a comment or a test looks wrong, stop. Say what is wrong and why in your final message. Never change a test to make it pass, and never write code that recognises a test's inputs.

## How to write it

Follow `docs/engineering.md`. In short:
- Pure files take the time, random values and settings as arguments. They return a `Result` and never throw, and never import I/O.
- `store.ts` uses bound parameters only.
- No mocks, stubs, TODOs, fallbacks or compatibility shims.
- Comments say why, not what, in plain language with short sentences and no em dashes.
- Before you write a helper, look for one that already does the job in your slice or in `apps/worker/src/platform/`. Use it instead of writing a second one.

## Done

You are done when every one of these exits 0. Read each exit code, and never decide with `grep` on the output.

```
node scripts/wave-check.mjs <base> <your own files>
pnpm exec oxlint --type-aware <your own files>
pnpm exec biome check <your own files>
pnpm typecheck
pnpm --filter <package> exec vitest run <your test files>
```

Lint only your own files: another worker's files are still unbuilt while you work, and lint fails on them. The audit runs `pnpm check` on the whole tree.

Then commit on your branch, with a message that says what you built and why. Do not push. Do not open a pull request. Do not touch Cloudflare.

## When pleach runs you

From wave 2, pleach starts you in a detached worktree and runs your gate itself (decision D-23). Then these replace the steps above:
- Your prompt names your gate, a `pnpm wave:gate` command. Run it through the pinned pnpm, as `npx -y pnpm@12.14.0 wave:gate ...`, and read its exit code. It runs the checks above with `HEAD` as the base.
- Leave your work uncommitted. Do not create a branch. pleach commits what passes its gate.
- If a fault in the skeleton or the specification stops you, write `BLOCKED.md` at the repository root. Say what is wrong, where, and what would fix it. Then stop. pleach does not ask again, and the audit reads it. Once it exists, your gate fails at its wave check, so report the gate's exit code from the run before you wrote it.

## Your final message

- What you built, file by file, in one line each.
- The commands above and their exit codes.
- Anything you could not finish, and why.
- Anything in the skeleton you think is wrong.
