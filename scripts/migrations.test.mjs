import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { baseViolations, currentHashes, LOCK_FILE, lockViolations } from "./lib/migrations.mjs";
import { ROOT } from "./lib/source.mjs";

const lock = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
const git = (...args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });

test("the lock check flags an edited, missing, unlocked or out-of-order step", () => {
  const locked = { "m/0001-a.sql": "h1", "m/0003-c.sql": "h3" };
  const now = { "m/0001-a.sql": "changed", "m/0002-b.sql": "h2" };
  assert.deepEqual(lockViolations(locked, now), [
    "m/0001-a.sql changed after it was locked; add a new step instead",
    "m/0003-c.sql is locked but missing",
    "m/0002-b.sql is not locked; run pnpm migrations:lock",
    "m/0002-b.sql sorts before the locked m/0003-c.sql",
  ]);
});

test("every schema step is locked and no locked step changed", () => {
  assert.deepEqual(lockViolations(lock, currentHashes()), []);
});

test("the base check flags a lock entry the branch changed", () => {
  assert.deepEqual(baseViolations({ "m/0001-a.sql": "h1" }, { "m/0001-a.sql": "h2" }), [
    "m/0001-a.sql was locked on the main line and its lock entry changed",
  ]);
});

test("no step locked on the main line changed in this branch", () => {
  const base = git("merge-base", "HEAD", "origin/master");
  assert.equal(base.status, 0, `cannot find where this branch left origin/master: ${base.stderr}`);
  const shown = git("show", `${base.stdout.trim()}:migrations.lock.json`);
  // A main line from before the lock file existed has nothing locked.
  const baseLock = shown.status === 0 ? JSON.parse(shown.stdout) : {};
  assert.deepEqual(baseViolations(baseLock, lock), []);
});
