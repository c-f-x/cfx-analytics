import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { stepFiles } from "./migrations.mjs";
import { ROOT } from "./source.mjs";
import { configBlocks, readWranglerConfig } from "./wrangler-config.mjs";

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The docs that say what holds in this repo now. The decision log is history,
// and the research, donor and consumer docs describe other repos, so their
// paths are not this repo's.
export const CHECKED_DOCS = [
  "CLAUDE.md",
  "README.md",
  "docs/architecture.md",
  "docs/build-plan.md",
  "docs/build-worker.md",
  "docs/data-model.md",
  "docs/design.md",
  "docs/engineering.md",
  "docs/onboarding.md",
  "docs/operations.md",
];

export const BRIEF = "CLAUDE.md";
export const BRIEF_MAX_LINES = 150;

const PLANNED = " (planned)";

const REPO_ROOTS = /^(apps|packages|scripts|docs|\.github)\//;
const FILE_EXT = /\.(md|ts|tsx|mjs|js|json|jsonc|sql|ya?ml|toml)$/;

/**
 * Repo paths a doc names in backticks: a token with a slash that starts at a
 * top-level folder or ends in a file extension. URL paths ("/s/"), templates
 * ("<slice>"), globs, package names and other repos' paths ("repo:path") are
 * not this repo's files. A path followed by "(planned)" is not built yet.
 */
export function namedPaths(text) {
  const paths = [];
  for (const m of text.matchAll(/`([^`\s]+)`( \(planned\))?/g)) {
    const token = m[1].replace(/:\d+(-\d+)?$/, "");
    if (!token.includes("/") || /^[/@]/.test(token) || /[<>*:{}()$]/.test(token)) continue;
    if (!REPO_ROOTS.test(token) && !FILE_EXT.test(token)) continue;
    paths.push({ path: token.replace(/\/$/, ""), planned: m[2] === PLANNED });
  }
  return paths;
}

/** Paths a doc names that do not exist, and paths marked planned that now exist. */
export function pathViolations(doc, text, exists = (p) => existsSync(path.join(ROOT, p))) {
  const found = [];
  const named = namedPaths(text);
  const planned = new Set(named.filter((n) => n.planned).map((n) => n.path));
  for (const p of planned)
    if (exists(p)) found.push(`${doc}: ${p} exists, so drop its "(planned)"`);
  for (const { path: p } of named) {
    if (!planned.has(p) && !exists(p)) found.push(`${doc}: ${p} does not exist`);
  }
  return [...new Set(found)];
}

// ── Generated blocks ────────────────────────────────────────────────────────

const BLOCK = /<!-- generated:([a-z-]+) -->\n([\s\S]*?)<!-- \/generated:\1 -->/g;

const SKIP_DIRS = new Set(["node_modules", "dist", ".wrangler", ".turbo", "coverage"]);

/**
 * The folders git ignores under `root`, as absolute paths, so the table shows
 * the repository and never a build's output that happens to be on disk.
 */
function ignoredFolders(root) {
  const listed = execFileSync(
    "git",
    ["-C", root, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
    { encoding: "utf8" },
  );
  return new Set(
    listed
      .split("\n")
      .filter((line) => line.endsWith("/"))
      .map((line) => path.join(root, line.slice(0, -1))),
  );
}

function folders(dir, depth, ignored) {
  if (depth === 0 || !existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."))
    .filter((e) => !ignored.has(path.join(dir, e.name)))
    .map((e) => e.name)
    .toSorted(byText)
    .map((name) => ({ name, children: folders(path.join(dir, name), depth - 1, ignored) }));
}

function tree(nodes, indent = "") {
  return nodes.flatMap((n) => [`${indent}${n.name}/`, ...tree(n.children, `${indent}  `)]);
}

function layout(root) {
  const top = ["apps", "packages", "scripts"].filter((d) => existsSync(path.join(root, d)));
  const ignored = ignoredFolders(root);
  const lines = top.flatMap((d) => [
    `${d}/`,
    ...tree(folders(path.join(root, d), 4, ignored), "  "),
  ]);
  return ["```", ...lines, "```"].join("\n");
}

function bindings() {
  const rows = [];
  for (const [block, cfg] of configBlocks(readWranglerConfig())) {
    for (const d of cfg.d1_databases ?? []) rows.push([block, d.binding, "D1", d.database_name]);
    for (const b of cfg.r2_buckets ?? [])
      rows.push([
        block,
        b.binding,
        "R2",
        `${b.bucket_name} (${b.jurisdiction ?? "no jurisdiction"})`,
      ]);
    for (const o of cfg.durable_objects?.bindings ?? [])
      rows.push([block, o.name, "Durable Object", o.class_name]);
    for (const k of cfg.kv_namespaces ?? []) rows.push([block, k.binding, "KV", k.id]);
    if (cfg.assets?.binding) rows.push([block, cfg.assets.binding, "Assets", cfg.assets.directory]);
  }
  if (rows.length === 0) return "No bindings yet.";
  return [
    "| Block | Binding | Kind | Resource |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

function schemaSteps(root) {
  const steps = stepFiles(root);
  if (steps.length === 0) return "No schema steps yet.";
  return steps.map((s) => `- \`${s}\``).join("\n");
}

// The install line for the one posthog-js version the Worker serves (D-15),
// read from where scripts/posthog-scripts.mjs keeps it.
function posthogJsInstall(root) {
  const file = "packages/shared/src/posthog.ts";
  const found = readFileSync(path.join(root, file), "utf8").match(
    /export const POSTHOG_JS_VERSION = "([^"]+)";/,
  );
  if (found === null) throw new Error(`${file} holds no POSTHOG_JS_VERSION`);
  return ["```sh", `npm install --save-exact posthog-js@${found[1]}`, "```"].join("\n");
}

export const GENERATORS = {
  layout: (root) => layout(root),
  bindings: () => bindings(),
  "schema-steps": (root) => schemaSteps(root),
  "posthog-js-install": (root) => posthogJsInstall(root),
};

/** The doc with every generated block rendered from the code. Unknown block names are an error. */
export function renderGenerated(text, root = ROOT) {
  const unknown = [];
  const out = text.replace(BLOCK, (_, name) => {
    const gen = GENERATORS[name];
    if (!gen) {
      unknown.push(name);
      return _;
    }
    return `<!-- generated:${name} -->\n${gen(root)}\n<!-- /generated:${name} -->`;
  });
  return { text: out, unknown };
}

export function readDoc(doc) {
  return readFileSync(path.join(ROOT, doc), "utf8");
}
