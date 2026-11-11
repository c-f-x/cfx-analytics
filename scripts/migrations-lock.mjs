import { readFileSync, writeFileSync } from "node:fs";
import { currentHashes, LOCK_FILE } from "./lib/migrations.mjs";

// `pnpm migrations:lock`: records new schema steps. It never changes an entry
// that is already locked, so an edited step stays a failing check.
const lock = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
const added = [];
for (const [file, hash] of Object.entries(currentHashes())) {
  if (file in lock) continue;
  lock[file] = hash;
  added.push(file);
}
writeFileSync(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`);
console.log(added.length > 0 ? `locked: ${added.join(", ")}` : "no new steps");
