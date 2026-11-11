import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./source.mjs";

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Schema steps: D1 registry migrations, and the ProjectStore's own steps. Each
// is a numbered .sql file. docs/data-model.md, "Schema steps".
export const STEP_FOLDERS = ["apps/worker/migrations", "apps/worker/src/platform/schema"];
export const LOCK_FILE = path.join(ROOT, "migrations.lock.json");

export function stepFiles(root = ROOT) {
  const out = [];
  for (const folder of STEP_FOLDERS) {
    const dir = path.join(root, folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).toSorted(byText)) {
      if (name.endsWith(".sql")) out.push(`${folder}/${name}`);
    }
  }
  return out;
}

export const hashOf = (text) => createHash("sha256").update(text).digest("hex");

export function currentHashes(root = ROOT) {
  return Object.fromEntries(
    stepFiles(root).map((f) => [f, hashOf(readFileSync(path.join(root, f), "utf8"))]),
  );
}

/**
 * Compares the steps on disk with the lock. A locked step that changed or
 * disappeared breaks the rule; so does an unlocked step, and a new step that
 * sorts before a locked step in the same folder.
 */
export function lockViolations(lock, current) {
  const found = [];
  for (const [file, hash] of Object.entries(lock)) {
    if (!(file in current)) found.push(`${file} is locked but missing`);
    else if (current[file] !== hash)
      found.push(`${file} changed after it was locked; add a new step instead`);
  }
  for (const file of Object.keys(current)) {
    if (file in lock) continue;
    found.push(`${file} is not locked; run pnpm migrations:lock`);
    const folder = path.dirname(file);
    const later = Object.keys(lock).filter((f) => path.dirname(f) === folder && f > file);
    if (later.length > 0) found.push(`${file} sorts before the locked ${later[0]}`);
  }
  return found;
}

/** Locked entries of the base branch that the branch removed or changed. */
export function baseViolations(baseLock, lock) {
  return Object.entries(baseLock)
    .filter(([file, hash]) => lock[file] !== hash)
    .map(([file]) => `${file} was locked on the main line and its lock entry changed`);
}
