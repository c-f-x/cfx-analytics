// The lifetimes table (D-9, c-f-x conventions section 5): every store the
// deployment binds and every table the schema steps make has a row under
// `## Lifetimes` in docs/data-model.md, saying what it holds, how long, and
// what removes the rest. Pure: callers read the files and pass the text in.

/** The first table's header, exactly as the family's convention fixes it. */
export const COLUMNS = ["Store", "Holds", "Lifetime", "Removed by"];

/** @param {string} line */
const cellsOf = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

/**
 * The rows of the first table under `## Lifetimes`, by store name, and what
 * is wrong with its shape.
 * @param {string} markdown
 * @returns {{ stores: string[], problems: string[] }}
 */
export function lifetimesTable(markdown) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## Lifetimes");
  if (start === -1) return { stores: [], problems: ["there is no ## Lifetimes heading"] };
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  const section = lines.slice(start + 1, end === -1 ? undefined : end);
  const first = section.findIndex((line) => line.trim().startsWith("|"));
  if (first === -1) return { stores: [], problems: ["## Lifetimes has no table"] };
  const rows = [];
  for (const line of section.slice(first)) {
    if (!line.trim().startsWith("|")) break;
    rows.push(cellsOf(line));
  }
  const [header = [], , ...body] = rows;
  const problems = [];
  if (header.join(" | ") !== COLUMNS.join(" | ")) {
    problems.push(`the table's columns are "${header.join(" | ")}", not "${COLUMNS.join(" | ")}"`);
  }
  const stores = [];
  for (const [index, cells] of body.entries()) {
    const at = `row ${String(index + 1)}`;
    if (cells.length !== COLUMNS.length || cells.some((cell) => cell === "")) {
      problems.push(`${at} has an empty or missing cell`);
    }
    const name = /^`([^`]+)`$/.exec(cells[0] ?? "");
    if (name === null) problems.push(`${at}'s Store cell is not one name in backticks`);
    else stores.push(name[1] ?? "");
  }
  return { stores, problems };
}

/**
 * The stores a Wrangler config binds: D1, R2 and KV by binding name, and
 * Durable Objects by class, unless another Worker's script holds them.
 * Every environment block counts.
 * @param {Record<string, any>} config
 * @returns {string[]}
 */
export function boundStores(config) {
  const blocks = [config, ...Object.values(config.env ?? {})];
  const names = new Set();
  for (const block of blocks) {
    for (const db of block.d1_databases ?? []) names.add(db.binding);
    for (const bucket of block.r2_buckets ?? []) names.add(bucket.binding);
    for (const kv of block.kv_namespaces ?? []) names.add(kv.binding);
    for (const object of block.durable_objects?.bindings ?? []) {
      if (object.script_name === undefined) names.add(object.class_name);
    }
  }
  return [...names];
}

/**
 * The tables a set of SQL texts leaves standing, read in order: each
 * `CREATE TABLE` adds one, and `DROP TABLE` or a rename takes it away.
 * @param {string[]} texts
 * @returns {string[]}
 */
export function tablesOf(texts) {
  const tables = new Set();
  const statement =
    /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)|\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?(\w+)|\bALTER\s+TABLE\s+["`]?(\w+)["`]?\s+RENAME\s+TO\s+["`]?(\w+)/gi;
  for (const text of texts) {
    for (const [, created, dropped, from, to] of text.matchAll(statement)) {
      if (created !== undefined) tables.add(created);
      if (dropped !== undefined) tables.delete(dropped);
      if (from !== undefined && to !== undefined) {
        tables.delete(from);
        tables.add(to);
      }
    }
  }
  return [...tables];
}

/**
 * What the lifetimes table lacks or holds in excess.
 * @param {string[]} stores the deployment's stores and tables
 * @param {string[]} rows the table's Store names
 * @returns {string[]}
 */
export function lifetimeViolations(stores, rows) {
  const known = new Set(stores);
  const listed = new Set(rows);
  return [
    ...[...known]
      .filter((s) => !listed.has(s))
      .map((s) => `${s} has no row in the lifetimes table`),
    ...rows.filter((s) => !known.has(s)).map((s) => `the row ${s} names no store`),
  ];
}
