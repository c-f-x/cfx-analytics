import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parse } from "jsonc-parser";
import { boundStores, lifetimesTable, lifetimeViolations, tablesOf } from "./lib/lifetimes.mjs";
import { joinWatch, joinWorker, siteOf } from "./lib/site.mjs";
import { ROOT } from "./lib/source.mjs";

// The lifetimes table (D-9, c-f-x conventions section 5): every store the
// deployment binds and every table the schema steps leave has a row in
// docs/data-model.md, and every row names one of them.

const read = (file) => readFileSync(path.join(ROOT, file), "utf8");

/**
 * The Worker's schema steps and source, tests left out, in name order so a
 * later step's DROP or rename follows the CREATE it undoes.
 * @returns {string[]}
 */
function workerTexts() {
  return ["apps/worker/migrations", "apps/worker/src"].flatMap((dir) =>
    readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(sql|ts)$/.test(file) && !/\.(test|d)\.ts$/.test(file))
      .toSorted()
      .map((file) => read(path.join(dir, file))),
  );
}

test("a store or table without a row, and a row without a store, are named", () => {
  const markdown = [
    "## Lifetimes",
    "",
    "| Store | Holds | Lifetime | Removed by |",
    "|---|---|---|---|",
    "| `DB` | the registry | as long as the tool runs | uninstall |",
    "| `gone` | an old table | 30 days | the sweep |",
    "",
  ].join("\n");
  const { stores, problems } = lifetimesTable(markdown);
  assert.deepEqual(problems, []);
  assert.deepEqual(lifetimeViolations(["DB", "results"], stores), [
    "results has no row in the lifetimes table",
    "the row gone names no store",
  ]);
});

test("a table of the wrong shape is named", () => {
  const markdown = [
    "## Lifetimes",
    "| Store | Holds | Kept for | Removed by |",
    "|---|---|---|---|",
    "| D1 `projects` | rows | | the sweep |",
  ].join("\n");
  assert.deepEqual(lifetimesTable(markdown).problems, [
    'the table\'s columns are "Store | Holds | Kept for | Removed by", not "Store | Holds | Lifetime | Removed by"',
    "row 1 has an empty or missing cell",
    "row 1's Store cell is not one name in backticks",
  ]);
  assert.deepEqual(lifetimesTable("# Data model\n").problems, ["there is no ## Lifetimes heading"]);
});

test("a table a later step drops or renames leaves the list", () => {
  assert.deepEqual(
    tablesOf([
      "CREATE TABLE a (x);\nCREATE TABLE IF NOT EXISTS b (x);",
      "DROP TABLE a;\nALTER TABLE b RENAME TO c;",
    ]),
    ["c"],
  );
});

test("a Durable Object another Worker holds is not this Worker's store", () => {
  assert.deepEqual(
    boundStores({
      d1_databases: [{ binding: "DB" }],
      durable_objects: {
        bindings: [{ class_name: "Own" }, { class_name: "Theirs", script_name: "other" }],
      },
      env: {
        production: { r2_buckets: [{ binding: "BLOBS" }], kv_namespaces: [{ binding: "KV" }] },
      },
    }),
    ["DB", "Own", "BLOBS", "KV"],
  );
});

test("every store and table of this deployment has a row in docs/data-model.md", () => {
  const site = siteOf(parse(read("site.example.jsonc")));
  assert.ok(site.ok, site.ok ? "" : site.errors.join("; "));
  const worker = joinWorker(parse(read("apps/worker/wrangler.jsonc")), site.value, "apps/worker");
  const watch = joinWatch(parse(read("apps/watch/wrangler.jsonc")), site.value, "apps/watch");
  // Every table the code makes: the schema steps of both stores, and any a
  // module creates for itself, such as the step runner's own record.
  const stores = [...boundStores(worker), ...boundStores(watch), ...tablesOf(workerTexts())];
  const { stores: rows, problems } = lifetimesTable(read("docs/data-model.md"));
  assert.deepEqual(problems, []);
  assert.deepEqual(lifetimeViolations(stores, rows), []);
});
