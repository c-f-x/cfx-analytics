import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { openRunScope } from "./lib/run-scope.mjs";
import { runSteps } from "./lib/run-steps.mjs";

// `pnpm check`: every check, in order, stopping at the first failure. The build
// is checked into this run's own folder and removed with it; a deploy builds
// once, checks that build, and ships it (docs/operations.md).
const scope = openRunScope({ installExitHandlers: true });

// Wrangler keeps a .wrangler folder beside the Worker's config. A developer's
// `wrangler dev` keeps local data there, so it is removed only when this run
// created it.
const WRANGLER_FOLDER = path.resolve(import.meta.dirname, "../apps/worker/.wrangler");
const wranglerFolderExisted = existsSync(WRANGLER_FOLDER);

// The dashboard builds into the Worker's assets (apps/web/vite.config.ts), so
// the Worker's build ships it. The built app is removed only when this run
// built it, as with the .wrangler folder.
const APP_FOLDER = path.resolve(import.meta.dirname, "../apps/worker/assets/app");
const appFolderExisted = existsSync(APP_FOLDER);
process.env.WRANGLER_LOG_PATH = path.join(scope.dir, "wrangler-logs");

const pnpm = (...args) => ({ command: "pnpm", args });

const steps = [
  { name: "lint", ...pnpm("lint") },
  { name: "typecheck", ...pnpm("typecheck") },
  { name: "test", ...pnpm("test") },
  // The real-size tests (*.size.test.ts) take tens of seconds, so the
  // everyday `pnpm test` leaves them out and the check runs them here.
  { name: "size tests", ...pnpm("test:size") },
  { name: "dashboard build", ...pnpm("--filter", "@cfanalytics/web", "build") },
  {
    name: "build",
    ...pnpm(
      "--filter",
      "@cfanalytics/worker",
      "exec",
      "wrangler",
      "deploy",
      "--dry-run",
      "--outdir",
      path.join(scope.dir, "worker"),
    ),
  },
  {
    name: "watcher build",
    ...pnpm(
      "--filter",
      "@cfanalytics/watch",
      "exec",
      "wrangler",
      "deploy",
      "--dry-run",
      "--outdir",
      path.join(scope.dir, "watch"),
    ),
  },
];

const result = await runSteps(steps);
const { leftovers } = await scope.close();
if (!wranglerFolderExisted) rmSync(WRANGLER_FOLDER, { recursive: true, force: true });
if (!appFolderExisted) rmSync(APP_FOLDER, { recursive: true, force: true });
if (leftovers.length > 0) console.error(`check: left behind: ${leftovers.join(", ")}`);
if (result.ok && leftovers.length === 0) {
  console.log("\ncheck: every step passed");
} else {
  if (!result.ok) {
    console.error(`\ncheck: "${result.failed.name}" failed with exit code ${result.failed.code}.`);
    if (result.skipped.length > 0) console.error(`check: not run: ${result.skipped.join(", ")}`);
  }
  process.exit(1);
}
