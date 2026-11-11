import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ROOT } from "./lib/source.mjs";
import { versionViolations } from "./lib/versions.mjs";

/** @param {string} file @returns {unknown} */
const versionOf = (file) => JSON.parse(readFileSync(path.join(ROOT, file), "utf8")).version;

test("a package at another version than the root's is named", () => {
  assert.deepEqual(
    versionViolations("1.2.0", [
      { file: "apps/a/package.json", version: "1.2.0" },
      { file: "apps/b/package.json", version: "1.1.0" },
      { file: "packages/c/package.json", version: undefined },
    ]),
    [
      "apps/b/package.json is at 1.1.0, the root at 1.2.0",
      "packages/c/package.json is at undefined, the root at 1.2.0",
    ],
  );
});

test("every workspace package carries the root's version", () => {
  const listed = spawnSync("git", ["ls-files", "apps/*/package.json", "packages/*/package.json"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(listed.status, 0, listed.stderr);
  const files = listed.stdout.split("\n").filter((file) => file !== "");
  assert.ok(files.length > 0, "git lists no workspace package");
  const root = versionOf("package.json");
  assert.equal(typeof root, "string");
  assert.deepEqual(
    versionViolations(
      String(root),
      files.map((file) => ({ file, version: versionOf(file) })),
    ),
    [],
  );
});
