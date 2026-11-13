# Contributing

Thank you for helping. This file says how to propose a change. `AGENTS.md` holds the project's rules, for people and agents alike, and wins where this file disagrees.

## Before you start

- For a bug, open an issue with the steps that show it. For an idea, open an issue first, so we can agree on it before you write code.
- To report a vulnerability, follow `SECURITY.md`. Never open a public issue for it.

## Make the change

1. Branch from `master` and open a pull request against it.
2. Add the behaviour to `docs/spec/behaviours.md`, then write the failing test that names its ID, such as `intake-03`, then the change that makes it pass.
3. Run `pnpm check`. It runs lint, types, every test, the real-size tests and the builds, and stops at the first failure. It must pass.
4. If the change touches what the PostHog SDKs send or receive, run `pnpm compat`. If it touches the dashboard, run `pnpm e2e`.
5. Keep the pull request to one change. Say why in its description.

## Licence

By contributing, you agree that your contribution is licensed under the MIT License in `LICENSE`.
