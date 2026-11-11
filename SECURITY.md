# Security

## Reporting a vulnerability

Please don't open a public issue. Write to security@c-f-x.com, or use GitHub's private advisory form on this repository (Security, then "Report a vulnerability"). We answer within 72 hours and agree a disclosure date with you.

## What counts

cfx-analytics holds other people's data: the visitors of the sites that send to it. The reports we most want are about:

- reading or changing one product's data with another product's token or key;
- reaching the dashboard's API without the owner's Cloudflare sign-in;
- data that outlives its retention period or a deletion request;
- a recording or heatmap that anyone but the owner can see.

## Supported versions

Only the newest commit on `master` gets fixes. There are no releases yet.

## How it is tested

- Every pull request runs `pnpm check`: lint, typecheck, the Worker's tests on the real Workers runtime, the real-size tests and the builds.
- `scripts/guard-proof.test.mjs` removes each access check in turn from a scratch copy and expects a named test to fail, so a check that guards nothing is found.
- `scripts/wrangler-config.test.mjs` fails on a secret, an account or resource id, or an email address in any tracked file.
