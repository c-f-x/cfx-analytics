import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The registry's D1 steps, applied to each test run's fresh database by
// test/setup.ts.
const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        // Local values of the deployment's secrets, and the D-19 flag: local
        // workerd refuses jurisdiction(), so tests address ProjectStores
        // without one. No deployment carries this binding.
        bindings: {
          TEST_MIGRATIONS: migrations,
          LOCAL_UNSCOPED_PROJECT_STORES: "1",
          AUTH_SECRET: "test-auth-secret-not-for-deployment",
          ADMIN_EMAIL: "admin@example.test",
          CLOUDFLARE_CLIENT_ID: "test-client-id",
          CLOUDFLARE_CLIENT_SECRET: "test-client-secret",
          DASHBOARD_ORIGIN: "https://dashboard.test",
        },
        // A real D1 database with no steps applied, so a registry query fails
        // as it does when D1 is unwell (platform-42).
        d1Databases: { UNMIGRATED_REGISTRY: "unmigrated-registry" },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    // The run scope keeps everything this run creates, including wrangler's
    // logs, and removes it at the end (scripts/lib/run-scope.mjs).
    globalSetup: ["../../scripts/lib/vitest-run-scope.mjs"],
    // Tests run in a real workerd. A timeout catches hangs, never slowness:
    // at a load average near 100, tests of thousands of rows took over 40 s.
    testTimeout: 120_000,
  },
});
