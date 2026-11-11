import type { D1Migration } from "@cloudflare/vitest-plugin";

// Bindings only tests have (vitest.config.ts).
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      UNMIGRATED_REGISTRY: D1Database;
    }
  }
}
