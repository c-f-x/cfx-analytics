import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  crossSliceViolations,
  moduleStateViolations,
  orchestrationImportViolations,
  orchestrationSqlViolations,
  PROJECT_STORE_ID,
  projectStoreAddressViolations,
  pureFileViolations,
  regionVarViolations,
  unbuiltViolations,
  WEB_SRC,
  WORKER_SRC,
  webImportViolations,
} from "./lib/architecture.mjs";
import { importsOf, ROOT, readSources, sourceFiles } from "./lib/source.mjs";

const worker = readSources(sourceFiles(WORKER_SRC));
const web = readSources(sourceFiles(WEB_SRC));
const shared = readSources(sourceFiles(path.join(ROOT, "packages")));

const at = (p) => path.join(ROOT, p);
const sample = (p, text) => ({ file: at(p), text });

test("the import scan sees the shapes the code uses", () => {
  const text = [
    'import { a } from "./a.ts";',
    'import type { B } from "../b.ts";',
    'import {\n  c,\n  type D,\n} from "@cfanalytics/shared/x";',
    'export { e } from "./e.ts";',
    'import "./side-effect.ts";',
    'const f = await import("./f.ts");',
  ].join("\n");
  assert.deepEqual(importsOf(text), [
    { spec: "./a.ts", typeOnly: false },
    { spec: "../b.ts", typeOnly: true },
    { spec: "@cfanalytics/shared/x", typeOnly: false },
    { spec: "./e.ts", typeOnly: false },
    { spec: "./side-effect.ts", typeOnly: false },
    { spec: "./f.ts", typeOnly: false },
  ]);
});

test("the pure-file check flags I/O, clocks, randomness and throws", () => {
  const found = pureFileViolations([
    sample("apps/worker/src/features/intake/core.ts", 'import { Hono } from "hono";'),
    sample("apps/worker/src/features/intake/core.ts", 'import { put } from "./store.ts";'),
    sample(
      "apps/worker/src/features/intake/clip.ts",
      'import { log } from "../../platform/log.ts";',
    ),
    sample("apps/worker/src/features/intake/core.ts", "export const now = () => Date.now();"),
    sample(
      "apps/worker/src/features/intake/core.ts",
      "export const id = () => crypto.randomUUID();",
    ),
    sample(
      "apps/worker/src/features/intake/core.ts",
      'export function f() { throw new Error("x"); }',
    ),
    // Allowed: the Result type, a comment that names Date.now(), and I/O files.
    sample(
      "apps/worker/src/features/intake/core.ts",
      'import { ok } from "../../platform/result.ts";\n// not Date.now()',
    ),
    sample("apps/worker/src/features/intake/store.ts", "export const now = () => Date.now();"),
  ]);
  assert.deepEqual(found, [
    "apps/worker/src/features/intake/core.ts imports hono",
    "apps/worker/src/features/intake/core.ts imports ./store.ts",
    "apps/worker/src/features/intake/clip.ts imports ../../platform/log.ts",
    "apps/worker/src/features/intake/core.ts reads a clock, a random source or the network",
    "apps/worker/src/features/intake/core.ts reads a clock, a random source or the network",
    "apps/worker/src/features/intake/core.ts throws",
  ]);
});

test("pure files do no I/O, read no clock or random source, and never throw", () => {
  assert.deepEqual(pureFileViolations(worker), []);
});

test("the cross-slice check flags reaching into another slice's files", () => {
  const found = crossSliceViolations([
    sample("apps/worker/src/features/query/http.ts", 'import { x } from "../events/store.ts";'),
    sample("apps/worker/src/features/query/http.ts", 'import { y } from "../events/index.ts";'),
    sample("apps/worker/src/features/query/http.ts", 'import { z } from "../events";'),
    sample("apps/worker/src/features/query/core.ts", 'import { w } from "./compile.ts";'),
  ]);
  assert.deepEqual(found, ["apps/worker/src/features/query/http.ts imports ../events/store.ts"]);
});

test("slices meet only through index.ts", () => {
  assert.deepEqual(crossSliceViolations(worker), []);
});

test("the addressing check flags a Durable Object addressed outside its one home", () => {
  const found = projectStoreAddressViolations([
    { file: PROJECT_STORE_ID, text: "export const id = (ns, p) => ns.idFromName(p);" },
    sample(
      "apps/worker/src/features/intake/http.ts",
      "const id = env.PROJECTS.idFromName(project);",
    ),
    {
      file: PROJECT_STORE_ID,
      text: 'export const id = (ns, p) => ns.jurisdiction("eu").idFromName(p);',
    },
    {
      file: PROJECT_STORE_ID,
      text: "export const id = (ns, env, p) => ns.jurisdiction(env.REGION).idFromName(p);",
    },
  ]);
  assert.deepEqual(found, [
    "apps/worker/src/features/intake/http.ts addresses a Durable Object itself",
    'apps/worker/src/platform/project-store-id.ts writes the jurisdiction "eu" into the code',
  ]);
});

test("a ProjectStore is addressed only by project-store-id.ts, with its region from configuration", () => {
  assert.deepEqual(projectStoreAddressViolations(worker), []);
});

test("the web import check flags runtime imports of the Worker", () => {
  const found = webImportViolations([
    sample("apps/web/src/features/query/api.ts", 'import { app } from "@cfanalytics/worker/app";'),
    sample(
      "apps/web/src/features/query/api.ts",
      'import type { App } from "@cfanalytics/worker/app";',
    ),
  ]);
  assert.deepEqual(found, [
    "apps/web/src/features/query/api.ts imports @cfanalytics/worker/app for more than types",
  ]);
});

test("the web app imports the Worker for types only", () => {
  assert.deepEqual(webImportViolations(web), []);
});

test("the module-state check flags state requests could share", () => {
  const found = moduleStateViolations([
    sample("apps/worker/src/a.ts", "let cache;"),
    sample("apps/worker/src/b.ts", "export const seen = new Map();"),
    sample("apps/worker/src/c.ts", "export const queue = new Array<string>();"),
    sample("apps/worker/src/e.ts", 'const PATHS = ["/e", "/batch"] as const;'),
    sample("apps/worker/src/d.ts", "const LIMIT = 500;\nfunction f() {\n  let x = 1;\n}"),
  ]);
  assert.deepEqual(found, [
    "apps/worker/src/a.ts keeps module-level mutable state",
    "apps/worker/src/b.ts keeps module-level mutable state",
    "apps/worker/src/c.ts keeps module-level mutable state",
  ]);
});

test("the Worker keeps no module-level mutable state", () => {
  assert.deepEqual(moduleStateViolations(worker), []);
});

test("the unbuilt check flags skeleton markers and the marker's own file", () => {
  const found = unbuiltViolations([
    sample("apps/worker/src/platform/unbuilt.ts", "export function unbuilt(what) {}"),
    sample(
      "apps/worker/src/features/intake/core.ts",
      'export const f = () => unbuilt("intake.f");',
    ),
    sample(
      "apps/worker/src/features/intake/clip.ts",
      "// was unbuilt() until wave 2\nexport const g = 1;",
    ),
  ]);
  assert.deepEqual(found, [
    "apps/worker/src/platform/unbuilt.ts exists",
    "apps/worker/src/features/intake/core.ts is not built yet",
  ]);
});

test("every skeleton body is built (no unbuilt markers on master)", () => {
  assert.deepEqual(unbuiltViolations([...worker, ...web, ...shared]), []);
});

test("the orchestration SQL check flags SQL run outside the slices that own it", () => {
  const found = orchestrationSqlViolations([
    sample(
      "apps/worker/src/platform/ingest.ts",
      'sql.exec("SELECT 1 FROM heatmap_points WHERE event_uuid = ?", id);',
    ),
    sample("apps/worker/src/platform/ingest.ts", "insertPoints(sql, points);"),
    sample("apps/worker/src/features/heatmaps/store.ts", 'sql.exec("SELECT 1");'),
  ]);
  assert.deepEqual(found, ["apps/worker/src/platform/ingest.ts runs SQL itself"]);
});

test("the ProjectStore's orchestration runs no SQL of its own", () => {
  assert.deepEqual(orchestrationSqlViolations(worker), []);
});

test("the orchestration check flags a slice importing the ProjectStore's orchestration for more than types", () => {
  const found = orchestrationImportViolations([
    sample(
      "apps/worker/src/features/intake/http.ts",
      'import { ingestBatch } from "../../platform/ingest.ts";',
    ),
    sample(
      "apps/worker/src/features/intake/http.ts",
      'import type { IngestRequest } from "../../platform/ingest.ts";',
    ),
    sample(
      "apps/worker/src/platform/project-store.ts",
      'import { insertEvents } from "../features/events/index.ts";',
    ),
  ]);
  assert.deepEqual(found, [
    "apps/worker/src/features/intake/http.ts imports ../../platform/ingest.ts",
  ]);
});

test("no slice imports the ProjectStore's orchestration for more than types", () => {
  assert.deepEqual(orchestrationImportViolations(worker), []);
});

// Every file of the repo a run could read: code, configs and scripts, tests included.
function everyFile(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) everyFile(full, out);
    else if (/\.(ts|tsx|mjs|js|json|jsonc|toml)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("platform-54 · the region variable's check flags its name outside its allowed files", () => {
  const found = regionVarViolations([
    sample("apps/worker/src/features/intake/http.ts", "if (env.STORE_JURISDICTION) {}"),
    sample("apps/worker/wrangler.jsonc", '"vars": { "STORE_JURISDICTION": "eu" }'),
    sample("apps/worker/src/platform/project-store-id.ts", "env.STORE_JURISDICTION"),
  ]);
  assert.deepEqual(found, [
    "apps/worker/src/features/intake/http.ts names STORE_JURISDICTION",
    "apps/worker/wrangler.jsonc names STORE_JURISDICTION",
  ]);
});

test("platform-54 · the region variable appears only in the files allowed to name it", () => {
  const files = ["apps", "packages", "scripts"].flatMap((d) => everyFile(path.join(ROOT, d)));
  assert.deepEqual(regionVarViolations(readSources(files)), []);
});
