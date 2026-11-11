import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { openRunScope } from "./lib/run-scope.mjs";
import { ROOT } from "./lib/source.mjs";

// Replaces the pinned posthog-js lazy scripts the Worker serves (D-15) with
// another version's, byte for byte, from the npm package:
//
//   node scripts/posthog-scripts.mjs <version>
//
// It refreshes every script already in apps/worker/assets/posthog/, so the
// list of kinds keeps one home, SCRIPT_KINDS in the config slice. npm checks
// the package's integrity as it downloads it. The script then prints each
// file's SHA-256 for SCRIPT_SHA256. Upgrading also means changing
// POSTHOG_JS_VERSION and the notice in THIRD_PARTY_NOTICES.md, and running
// pnpm check, whose config-27 test compares the served bytes with the hashes.

const FOLDER = path.join(ROOT, "apps/worker/assets/posthog");

const version = process.argv[2];
if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: node scripts/posthog-scripts.mjs <version>, such as 1.438.12");
  process.exit(2);
}

const scripts = readdirSync(FOLDER)
  .filter((name) => name.endsWith(".js"))
  .toSorted();
if (scripts.length === 0) {
  console.error(`${FOLDER} holds no scripts to refresh`);
  process.exit(1);
}

const scope = openRunScope({ installExitHandlers: true });
try {
  execFileSync(
    "npm",
    ["pack", `posthog-js@${version}`, "--loglevel=error", "--pack-destination", scope.dir],
    {
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  const tarball = path.join(scope.dir, `posthog-js-${version}.tgz`);
  execFileSync("tar", ["-xzf", tarball, "-C", scope.dir]);

  const dist = path.join(scope.dir, "package", "dist");
  const missing = scripts.filter((name) => !existsSync(path.join(dist, name)));
  if (missing.length > 0) {
    throw new Error(`posthog-js ${version} has no ${missing.join(", ")}`);
  }

  for (const name of scripts) {
    const target = path.join(FOLDER, name);
    copyFileSync(path.join(dist, name), target);
    const digest = createHash("sha256").update(readFileSync(target)).digest("hex");
    console.log(`  "${name.replace(/\.js$/, "")}": "${digest}",`);
  }
} finally {
  await scope.close();
}
