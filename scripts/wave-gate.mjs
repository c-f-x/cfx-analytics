import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { openRunScope } from "./lib/run-scope.mjs";
import { runSteps, spawnStep } from "./lib/run-steps.mjs";
import { ROOT } from "./lib/source.mjs";
import { behaviourIds, redVerdict, repoPath, testFilesUnder } from "./lib/wave.mjs";

// A pleach node's smoke gate in a wave (decisions D-21, D-23). Run it through
// the pinned pnpm, so the steps inside find the same pnpm:
//
//   pnpm wave:gate outline <wave file>...
//   pnpm wave:gate red <test file or slice folder>...
//   pnpm wave:gate fill <own file>... --tests <test file>...
//
// outline: every wave file exists and some still call unbuilt(); lint,
//   typecheck, every existing Worker test and the script checks pass, save
//   the one that wants no markers.
// red: only the test files (a folder stands for its test files) changed since HEAD; lint and typecheck pass;
//   every test names a kept behaviour and fails on an unbuilt marker.
// fill: only the own files changed since HEAD and none calls unbuilt(); lint,
//   typecheck and the given tests pass.
//
// pleach stages a node's work before its smoke, so HEAD is the node's base.

const [mode, ...rest] = process.argv.slice(2);
const split = rest.indexOf("--tests");
const files = (split === -1 ? rest : rest.slice(0, split)).map(repoPath);
const tests = split === -1 ? [] : rest.slice(split + 1).map(repoPath);
const usage = "usage: pnpm wave:gate outline|red|fill <file>... [--tests <test file>...]";
if (!["outline", "red", "fill"].includes(mode) || files.length === 0) fail(usage, 2);
if (mode === "fill" && tests.length === 0) fail(usage, 2);

const pnpm = (name, ...args) => ({ name, command: "pnpm", args });
const node = (name, ...args) => ({ name, command: process.execPath, args });
const WORKER = "apps/worker";
const MARKER_CHECK = "every skeleton body is built";
const inWorker = (file) => path.relative(WORKER, file);
const lintAndTypes = [pnpm("lint", "lint"), pnpm("typecheck", "typecheck")];

if (mode === "outline") {
  const missing = files.filter((file) => !existsSync(path.join(ROOT, file)));
  if (missing.length > 0) fail(`wave-gate: missing wave files: ${missing.join(", ")}`);
  const marked = files.filter((file) =>
    /\bunbuilt\(/.test(readFileSync(path.join(ROOT, file), "utf8")),
  );
  if (marked.length === 0)
    fail("wave-gate: no wave file calls unbuilt(), so nothing is left to fill");
  await steps([
    ...lintAndTypes,
    pnpm("worker tests", "--filter", "@cfanalytics/worker", "exec", "vitest", "run"),
    // Every script check but the one a build branch fails by design.
    node(
      "script checks",
      "--test",
      `--test-skip-pattern=${MARKER_CHECK}`,
      "scripts/architecture.test.mjs",
      "scripts/docs.test.mjs",
      "scripts/migrations.test.mjs",
      "scripts/wrangler-config.test.mjs",
    ),
  ]);
} else if (mode === "fill") {
  await steps([
    node("wave check", "scripts/wave-check.mjs", "HEAD", ...files),
    ...lintAndTypes,
    pnpm(
      "tests",
      "--filter",
      "@cfanalytics/worker",
      "exec",
      "vitest",
      "run",
      ...tests.map(inWorker),
    ),
  ]);
} else {
  // A folder stands for the test files under it, new ones included.
  const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  const owned = testFilesUnder(files, tracked);
  if (owned.length === 0) fail(`wave-gate: no test files under ${files.join(", ")}`);
  await steps([node("wave check", "scripts/wave-check.mjs", "HEAD", ...owned), ...lintAndTypes]);
  const scope = openRunScope({ installExitHandlers: true });
  const report = path.join(scope.dir, "report.json");
  const testFiles = owned.filter((file) => file.endsWith(".test.ts")).map(inWorker);
  await spawnStep({
    command: "pnpm",
    args: [
      "--filter",
      "@cfanalytics/worker",
      "exec",
      "vitest",
      "run",
      ...testFiles,
      "--reporter=json",
      `--outputFile=${report}`,
    ],
  });
  const written = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : null;
  await scope.close();
  if (written === null) fail("wave-gate: vitest wrote no report");
  const ids = behaviourIds(readFileSync(path.join(ROOT, "docs/spec/behaviours.md"), "utf8"));
  const { violations, passed } = redVerdict(written, ids);
  for (const title of passed) console.log(`wave-gate: passes already: ${title}`);
  for (const violation of violations) console.error(`wave-gate: ${violation}`);
  if (violations.length > 0) process.exit(1);
  console.log(
    `wave-gate: every test names a kept behaviour and fails on a marker (${passed.length} pass already)`,
  );
}

async function steps(list) {
  const result = await runSteps(list);
  if (!result.ok)
    fail(`wave-gate: "${result.failed.name}" failed with exit code ${result.failed.code}`);
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}
