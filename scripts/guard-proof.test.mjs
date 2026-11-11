import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { openRunScope } from "./lib/run-scope.mjs";

// The access checks are proven to guard (platform-15, engineering.md). Each
// case removes one check from a scratch copy of the repo and runs the tests
// that should notice. The case passes only when the named behaviour's test
// fails. The unchanged copy runs first and must pass, so a broken harness
// cannot pass for a removed check. Later waves add their own checks here,
// such as the secret key check of the external query path.

const ROOT = path.resolve(import.meta.dirname, "..");
const SESSION = "apps/worker/src/platform/session.ts";
const SIGN_IN = "apps/worker/src/platform/sign-in.ts";
const PROJECTS_HTTP = "apps/worker/src/features/projects/http.ts";
const SESSION_TESTS = ["src/platform/session.test.ts"];
const SIGN_IN_TESTS = ["src/platform/sign-in.test.ts"];
const UNSET_TESTS = ["src/platform/unset.test.ts"];
const PROJECTS_TESTS = ["src/features/projects/http.test.ts"];
const HEATMAPS_HTTP = "apps/worker/src/features/heatmaps/http.ts";
const RECORDINGS_HTTP = "apps/worker/src/features/recordings/http.ts";
const QUERY_HTTP = "apps/worker/src/features/query/http.ts";
const PRIVACY_HTTP = "apps/worker/src/features/privacy/http.ts";
// A timeout catches a hung workerd, never a slow one.
const HANG_MS = 120_000;

/** Each removed check: the file, the exact text taken out, and the test that must fail. */
const REMOVED_CHECKS = [
  {
    name: "the shortest AUTH_SECRET check",
    file: SESSION,
    text: '  if (typeof secret !== "string" || secret.length < AUTH_SECRET_MIN) return null;\n',
    with: '  if (typeof secret !== "string") return null;\n',
    tests: UNSET_TESTS,
    fails: "platform-51",
  },
  {
    name: "requireAdmin lets every request through",
    file: SESSION,
    text: '    if (isSecretKeyBearer(c.req.header("authorization"))) return unauthorized();\n',
    with: '    c.set("caller", { email: "anyone" });\n    await next();\n    return undefined;\n',
    tests: SESSION_TESTS,
    fails: "platform-01",
  },
  {
    name: "the secret key Bearer check",
    file: SESSION,
    text: '    if (isSecretKeyBearer(c.req.header("authorization"))) return unauthorized();\n',
    tests: PROJECTS_TESTS,
    fails: "platform-07",
  },
  {
    name: "the session's signature check",
    file: SESSION,
    text: "  if (!valid) return null;\n",
    tests: SESSION_TESTS,
    fails: "platform-44",
  },
  {
    name: "the session's expiry check",
    file: SESSION,
    text: '  if (typeof email !== "string" || typeof exp !== "number" || now >= exp) return null;\n',
    with: '  if (typeof email !== "string" || typeof exp !== "number") return null;\n',
    tests: SESSION_TESTS,
    fails: "platform-44",
  },
  {
    name: "the session's admin email check",
    file: SESSION,
    text: "  return email.toLowerCase() === adminEmail.toLowerCase() ? email : null;\n",
    with: "  return email;\n",
    tests: SESSION_TESTS,
    fails: "platform-44",
  },
  {
    name: "the sign-in's state check",
    file: SIGN_IN,
    text: '  if (typeof verifier !== "string" || flow.state !== state) return null;\n',
    with: '  if (typeof verifier !== "string") return null;\n',
    tests: SIGN_IN_TESTS,
    fails: "platform-46",
  },
  {
    name: "the callback's admin email check",
    file: SIGN_IN,
    text: "  if (email.toLowerCase() !== signIn.auth.adminEmail.toLowerCase()) {\n",
    with: "  if (email === null) {\n",
    tests: SIGN_IN_TESTS,
    fails: "platform-47",
  },
  {
    name: "the same-origin check",
    file: SESSION,
    text: "      if (origin !== dashboardOrigin) return forbiddenOrigin();\n",
    tests: PROJECTS_TESTS,
    fails: "projects-26",
  },
  {
    name: "a project route mounted without a session",
    file: PROJECTS_HTTP,
    text: '  app.get("/api/projects", access, handleList);\n',
    with: '  app.get("/api/projects", handleList);\n',
    tests: SESSION_TESTS,
    fails: "platform-01",
  },
  {
    name: "the heatmap route mounted without a session",
    file: HEATMAPS_HTTP,
    text: '  app.post("/api/projects/:id/heatmap", requireAdmin(), handleHeatmap);\n',
    with: '  app.post("/api/projects/:id/heatmap", handleHeatmap);\n',
    tests: ["src/features/heatmaps/http.test.ts"],
    fails: "platform-01",
  },
  {
    name: "the recordings list mounted without a session",
    file: RECORDINGS_HTTP,
    text: '  app.get("/api/projects/:id/recordings", requireAdmin(), handleList);\n',
    with: '  app.get("/api/projects/:id/recordings", handleList);\n',
    tests: ["src/features/recordings/http.test.ts"],
    fails: "recordings-04",
  },
  {
    name: "the recording chunks route mounted without a session",
    file: RECORDINGS_HTTP,
    text: '  app.get("/api/projects/:id/recordings/:session/chunks", requireAdmin(), handleChunks);\n',
    with: '  app.get("/api/projects/:id/recordings/:session/chunks", handleChunks);\n',
    tests: ["src/features/recordings/http.test.ts"],
    fails: "recordings-04",
  },
  {
    name: "the dashboard query route mounted without a session",
    file: QUERY_HTTP,
    text: '  app.all("/api/projects/:id/query", requireAdmin(), handleDashboardQuery);\n',
    with: '  app.all("/api/projects/:id/query", handleDashboardQuery);\n',
    tests: SESSION_TESTS,
    fails: "platform-01",
  },
  {
    name: "the privacy routes mounted without a session",
    file: PRIVACY_HTTP,
    text: "  const access = requireAdmin();\n",
    with: "  const access: MiddlewareHandler<AppEnv> = async (_c, next) => next();\n",
    tests: SESSION_TESTS,
    fails: "platform-01",
  },
];

/** The text with `check.text` replaced; the text must appear exactly once, so a stale case fails. */
export function removeCheck(source, check) {
  const at = source.indexOf(check.text);
  if (at === -1 || source.indexOf(check.text, at + 1) !== -1) {
    throw new Error(
      `${check.file} holds "${check.text.trim()}" ${at === -1 ? "nowhere" : "twice"}`,
    );
  }
  return source.slice(0, at) + (check.with ?? "") + source.slice(at + check.text.length);
}

let scope;

before(() => {
  scope = openRunScope({ installExitHandlers: true });
});

after(async () => {
  const { leftovers } = await scope.close();
  assert.deepEqual(leftovers, []);
});

/** A copy of the repo's sources in this run's scope, with the installed modules linked in. */
function scratchCopy(name) {
  const dir = path.join(scope.dir, name);
  mkdirSync(dir);
  for (const file of ["package.json", "tsconfig.base.json", "tsconfig.json"]) {
    cpSync(path.join(ROOT, file), path.join(dir, file));
  }
  cpSync(path.join(ROOT, "scripts/lib"), path.join(dir, "scripts/lib"), { recursive: true });
  for (const pkg of ["apps/worker", "packages/shared"]) {
    cpSync(path.join(ROOT, pkg), path.join(dir, pkg), {
      recursive: true,
      filter: (from) => !/[/\\](node_modules|dist|\.wrangler)$/.test(from),
    });
    symlinkSync(path.join(ROOT, pkg, "node_modules"), path.join(dir, pkg, "node_modules"));
  }
  symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
  return dir;
}

/** Runs the worker's tests in `dir`; resolves with the names of the tests that failed. */
function failingTests(dir, files) {
  const worker = path.join(dir, "apps/worker");
  const report = path.join(dir, "report.json");
  const vitest = path.join(ROOT, "apps/worker/node_modules/vitest/vitest.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [vitest, "run", ...files, "--reporter=json", `--outputFile=${report}`],
      { cwd: worker, stdio: "ignore", detached: true },
    );
    scope.recordChild(child.pid, { group: true });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!existsSync(report)) {
        reject(new Error(`vitest exited ${code} in ${dir} and wrote no report`));
        return;
      }
      const results = JSON.parse(readFileSync(report, "utf8")).testResults ?? [];
      const failed = results
        .flatMap((file) => file.assertionResults ?? [])
        .filter((result) => result.status === "failed")
        .map((result) => result.title);
      resolve({ code, failed });
    });
  });
}

test("the unchanged copy passes, so the harness itself is sound (platform-15)", {
  timeout: HANG_MS,
}, async () => {
  const dir = scratchCopy("unchanged");
  const { code, failed } = await failingTests(dir, [
    ...SESSION_TESTS,
    ...SIGN_IN_TESTS,
    ...PROJECTS_TESTS,
  ]);
  assert.deepEqual(failed, []);
  assert.equal(code, 0);
});

test("removeCheck refuses text that is missing or appears twice (platform-15)", () => {
  const check = { file: "x.ts", text: "check();\n" };
  assert.equal(removeCheck("a\ncheck();\nb\n", check), "a\nb\n");
  assert.throws(() => removeCheck("a\n", check), /nowhere/);
  assert.throws(() => removeCheck("check();\ncheck();\n", check), /twice/);
});

// Each case has its own copy and its own workerd, so they run side by side.
describe("each access check removed", { concurrency: true, timeout: HANG_MS }, () => {
  for (const [index, check] of REMOVED_CHECKS.entries()) {
    test(`removing ${check.name} fails ${check.fails} (platform-15)`, async () => {
      const dir = scratchCopy(`removed-${index}`);
      const file = path.join(dir, check.file);
      writeFileSync(file, removeCheck(readFileSync(file, "utf8"), check));
      const { code, failed } = await failingTests(dir, check.tests);
      assert.notEqual(code, 0);
      assert.ok(
        failed.some((title) => title.startsWith(check.fails)),
        `expected a ${check.fails} test to fail, got: ${failed.join("; ") || "none"}`,
      );
    });
  }
});
