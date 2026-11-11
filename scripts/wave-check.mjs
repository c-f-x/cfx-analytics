import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./lib/source.mjs";
import { repoPath, waveViolations } from "./lib/wave.mjs";

// `node scripts/wave-check.mjs <base> <own file>...`: a DeepSeek worker's gate.
// It fails when anything changed since <base> outside the worker's own files,
// committed or not, or when an own file still calls unbuilt().
const [base, ...files] = process.argv.slice(2);
if (!base || files.length === 0) {
  console.error("usage: node scripts/wave-check.mjs <base> <own file>...");
  process.exit(2);
}

const git = (...args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
const changed = [
  ...new Set([
    ...git("diff", "--name-only", base),
    ...git("ls-files", "--others", "--exclude-standard"),
  ]),
];
const own = files.map(repoPath);
const ownSources = own
  .map((p) => path.join(ROOT, p))
  .filter((file) => existsSync(file))
  .map((file) => ({ file, text: readFileSync(file, "utf8") }));

const found = waveViolations({ changed, own, ownSources });
for (const f of found) console.error(`wave-check: ${f}`);
if (found.length > 0) process.exit(1);
console.log(`wave-check: ${own.length} own files built, nothing else changed since ${base}`);
