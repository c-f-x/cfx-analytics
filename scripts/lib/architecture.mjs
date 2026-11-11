import path from "node:path";
import { importsOf, ROOT, rel, withoutComments } from "./source.mjs";

// The rules of docs/architecture.md ("Dependency rules") and docs/engineering.md
// ("Rules and their guards") that no linter knows. Each function takes source
// texts and returns what breaks its rule, so a test can feed it a sample.

export const WORKER_SRC = path.join(ROOT, "apps/worker/src");
export const WEB_SRC = path.join(ROOT, "apps/web/src");
const FEATURES = path.join(WORKER_SRC, "features");
const PLATFORM = path.join(WORKER_SRC, "platform");
export const PROJECT_STORE_ID = path.join(PLATFORM, "project-store-id.ts");
export const UNBUILT = path.join(PLATFORM, "unbuilt.ts");

const SLICE_IO_FILES = new Set(["store.ts", "http.ts", "index.ts"]);

/** The slice a file belongs to, or null when it is outside features/. */
export function sliceOf(file) {
  const parts = path.relative(FEATURES, file).split(path.sep);
  return parts[0] === ".." || parts.length < 2 ? null : parts[0];
}

/** A slice's pure files: everything in the slice except store.ts, http.ts and index.ts. */
export function isPureFile(file) {
  return sliceOf(file) !== null && !SLICE_IO_FILES.has(path.basename(file));
}

const resolve = (file, spec) => path.resolve(path.dirname(file), spec);

const IO_MODULE = /^(hono(\/|$)|cloudflare:|node:)/;
const IMPURE_CALL =
  /\bDate\.now\(|\bnew Date\(\s*\)|\bMath\.random\(|\bcrypto\.(randomUUID|getRandomValues)\(|\bperformance\.now\(|(^|[^.\w])fetch\(/m;
const THROW = /\bthrow\b/;

export function pureFileViolations(sources) {
  const found = [];
  for (const { file, text } of sources) {
    if (!isPureFile(file)) continue;
    for (const { spec } of importsOf(text)) {
      if (IO_MODULE.test(spec)) {
        found.push(`${rel(file)} imports ${spec}`);
        continue;
      }
      if (!spec.startsWith(".")) continue;
      const target = resolve(file, spec);
      const base = path.basename(target);
      if (sliceOf(target) !== null && (base === "store.ts" || base === "http.ts")) {
        found.push(`${rel(file)} imports ${spec}`);
      }
      // unbuilt.ts exists only on build branches; unbuiltViolations keeps it off master.
      if (target.startsWith(PLATFORM + path.sep) && target !== UNBUILT && base !== "result.ts") {
        found.push(`${rel(file)} imports ${spec}`);
      }
    }
    const code = withoutComments(text);
    if (IMPURE_CALL.test(code))
      found.push(`${rel(file)} reads a clock, a random source or the network`);
    if (THROW.test(code)) found.push(`${rel(file)} throws`);
  }
  return found;
}

export function crossSliceViolations(sources) {
  const found = [];
  for (const { file, text } of sources) {
    const from = sliceOf(file);
    if (from === null) continue;
    for (const { spec } of importsOf(text)) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(file, spec);
      const to =
        sliceOf(target) ?? (path.dirname(target) === FEATURES ? path.basename(target) : null);
      if (to === null || to === from) continue;
      const entry = path.join(FEATURES, to, "index.ts");
      if (target !== entry && target !== path.join(FEATURES, to))
        found.push(`${rel(file)} imports ${spec}`);
    }
  }
  return found;
}

const ADDRESSING = /\.(idFromName|idFromString|newUniqueId|jurisdiction)\(/;

export function projectStoreAddressViolations(sources) {
  const found = [];
  for (const { file, text } of sources) {
    const code = withoutComments(text);
    if (file === PROJECT_STORE_ID) {
      if (!/\.jurisdiction\(\s*["']eu["']\s*\)/.test(code))
        found.push(`${rel(file)} does not use the eu jurisdiction`);
      continue;
    }
    if (ADDRESSING.test(code)) found.push(`${rel(file)} addresses a Durable Object itself`);
  }
  return found;
}

export function webImportViolations(sources) {
  const found = [];
  for (const { file, text } of sources) {
    for (const { spec, typeOnly } of importsOf(text)) {
      const intoWorker =
        spec.startsWith("@cfanalytics/worker") ||
        (spec.startsWith(".") &&
          resolve(file, spec).startsWith(path.join(ROOT, "apps/worker") + path.sep));
      if (intoWorker && !typeOnly) found.push(`${rel(file)} imports ${spec} for more than types`);
    }
  }
  return found;
}

// Module-level mutable state: a top-level let or var, or a top-level
// collection made with a constructor (Map, Set, Array), which requests on one
// isolate would share. Constant lists written as literals are allowed. Each
// allowed file says why.
const MODULE_STATE =
  /^(export\s+)?(let|var)\s|^(export\s+)?const\s+\w+(\s*:[^=]+)?\s*=\s*new\s+(Map|Set|WeakMap|WeakSet|Array)\b/m;
export const MODULE_STATE_ALLOWED = {};

export function moduleStateViolations(sources) {
  return sources
    .filter(
      ({ file, text }) =>
        !MODULE_STATE_ALLOWED[rel(file)] && MODULE_STATE.test(withoutComments(text)),
    )
    .map(({ file }) => `${rel(file)} keeps module-level mutable state`);
}

// A skeleton body calls unbuilt("<slice>.<function>") until a worker fills it
// in (decision D-17). Build branches carry markers; master carries none.
const UNBUILT_CALL = /\bunbuilt\(/;

export function unbuiltViolations(sources) {
  const found = [];
  for (const { file, text } of sources) {
    if (path.basename(file) === "unbuilt.ts") found.push(`${rel(file)} exists`);
    else if (UNBUILT_CALL.test(withoutComments(text))) found.push(`${rel(file)} is not built yet`);
  }
  return found;
}

// The ProjectStore's orchestration calls several slices; a slice that imported
// it back for more than types would make a module cycle (architecture.md).
const ORCHESTRATION = new Set(
  ["project-store.ts", "ingest.ts", "sweep.ts"].map((f) => path.join(PLATFORM, f)),
);

export function orchestrationImportViolations(sources) {
  const found = [];
  for (const { file, text } of sources) {
    if (sliceOf(file) === null) continue;
    for (const { spec, typeOnly } of importsOf(text)) {
      if (!typeOnly && spec.startsWith(".") && ORCHESTRATION.has(resolve(file, spec))) {
        found.push(`${rel(file)} imports ${spec}`);
      }
    }
  }
  return found;
}

// Each slice owns its own SQL (architecture.md): the ProjectStore's
// orchestration calls the slices' table functions and runs no statement of
// its own. project-store.ts may read storage itself for the schema and alarm.
const ORCHESTRATION_NO_SQL = ["ingest.ts", "sweep.ts"].map((f) => path.join(PLATFORM, f));
const SQL_CALL = /\.exec\(/;

export function orchestrationSqlViolations(sources) {
  return sources
    .filter(({ file }) => ORCHESTRATION_NO_SQL.includes(path.resolve(ROOT, file)))
    .filter(({ text }) => SQL_CALL.test(withoutComments(text)))
    .map(({ file }) => `${rel(path.resolve(ROOT, file))} runs SQL itself`);
}

// D-19: only local runs set the flag that addresses ProjectStores outside a
// jurisdiction. Its name may appear only where it is read or set for a local
// run, and in this check (platform-18).
export const LOCAL_FLAG = "LOCAL_UNSCOPED_PROJECT_STORES";
export const LOCAL_FLAG_ALLOWED = [
  "apps/worker/src/platform/project-store-id.ts",
  "apps/worker/src/platform/env.ts",
  "apps/worker/vitest.config.ts",
  // The real-SDK suite starts wrangler dev, a local run (docs/engineering.md, "Real SDKs").
  "apps/compat/wrangler.mjs",
  "scripts/lib/architecture.mjs",
  "scripts/architecture.test.mjs",
];

export function localFlagViolations(sources) {
  return sources
    .filter(
      ({ file, text }) => text.includes(LOCAL_FLAG) && !LOCAL_FLAG_ALLOWED.includes(rel(file)),
    )
    .map(({ file }) => `${rel(file)} names ${LOCAL_FLAG}`);
}
