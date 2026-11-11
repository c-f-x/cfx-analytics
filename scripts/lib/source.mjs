import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const rel = (file) => path.relative(ROOT, file);

/** Source files under `dir`, without type declarations and tests. Empty when `dir` does not exist yet. */
export function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.(ts|tsx|js|mjs)$/.test(entry.name)) continue;
    const file = path.join(entry.parentPath, entry.name);
    if (
      /\.d\.ts$|\.test\.tsx?$|\.gen\.ts$/.test(file) ||
      file.includes(`${path.sep}node_modules${path.sep}`)
    )
      continue;
    out.push(file);
  }
  return out.toSorted(byText);
}

export function readSources(files) {
  return files.map((file) => ({ file, text: readFileSync(file, "utf8") }));
}

/** The text without comments, so a rule that reads calls is not fooled by prose. */
export function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/**
 * Every module specifier a file imports or re-exports, and whether the whole
 * statement is type-only. Statements end with ";" (Biome enforces it), so a
 * lazy match up to `from "x"` spans multi-line import lists.
 */
export function importsOf(text) {
  const out = [];
  const statement = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^;]*?\sfrom\s+)?["']([^"']+)["']/g;
  for (const m of text.matchAll(statement)) out.push({ spec: m[3], typeOnly: Boolean(m[2]) });
  for (const m of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g))
    out.push({ spec: m[1], typeOnly: false });
  return out;
}
