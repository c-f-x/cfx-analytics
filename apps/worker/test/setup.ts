import { applyD1Migrations, env } from "cloudflare:test";

// Every test file starts with the registry's schema applied to its own D1.
await applyD1Migrations(env.REGISTRY, env.TEST_MIGRATIONS);
