import { err, messageOf, ok, type Result } from "./result.ts";

// Runs a ProjectStore's schema steps when the object starts (data-model.md,
// "Schema steps"). The runner keeps its own record in a `store_meta` table it
// creates itself: the key "step" holds the last step applied, and the key
// "project_id" the project this object belongs to.

export interface SchemaStep {
  number: number;
  sql: string;
}

export type SchemaError =
  | { kind: "bad step list"; numbers: number[] }
  | { kind: "store is newer than code"; recorded: number; newest: number }
  | { kind: "step failed"; number: number; message: string };

const META_TABLE =
  "CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)";
const RECORD_STEP =
  "INSERT INTO store_meta (key, value) VALUES ('step', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value";

/** True when the step runner has made its own table. */
function hasMetaTable(sql: SqlStorage): boolean {
  return (
    sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'store_meta'")
      .toArray().length > 0
  );
}

/** The step store_meta records as applied, or 0 before the first one ran. */
function recordedStep(sql: SqlStorage): number {
  if (!hasMetaTable(sql)) return 0;
  const value = sql.exec("SELECT value FROM store_meta WHERE key = 'step'").toArray()[0]?.value;
  return value === undefined ? 0 : Number(value);
}

/**
 * The steps still to run, in order (platform-20). The step list must be
 * 1, 2, 3 ... with no gap and no repeat, else "bad step list" naming the
 * numbers (platform-21). A recorded step newer than the newest known is
 * "store is newer than code" (platform-22). Pure.
 */
export function stepsToRun(
  recorded: number,
  steps: readonly SchemaStep[],
): Result<SchemaStep[], SchemaError> {
  const numbers: number[] = [];
  steps.forEach((step, index) => {
    if (step.number !== index + 1 && !numbers.includes(step.number)) {
      numbers.push(step.number);
    }
  });
  if (numbers.length > 0) return err({ kind: "bad step list", numbers });

  const newest = steps.at(-1)?.number ?? 0;
  if (recorded > newest) return err({ kind: "store is newer than code", recorded, newest });

  return ok(steps.filter((step) => step.number > recorded));
}

/**
 * Creates `store_meta` if needed, reads the recorded step, and runs each step
 * still to run in its own transactionSync, recording it in the same
 * transaction, so a step that fails halfway leaves nothing behind, answers
 * "step failed" with its number and SQLite's message, and is run again on the
 * next start (platform-23). Called inside blockConcurrencyWhile,
 * so concurrent calls see one finished schema (platform-24). Returns the
 * recorded step afterwards; on a SchemaError it changes nothing.
 */
export function applySteps(
  storage: DurableObjectStorage,
  steps: readonly SchemaStep[],
): Result<number, SchemaError> {
  const sql = storage.sql;
  const recorded = recordedStep(sql);
  const planned = stepsToRun(recorded, steps);
  if (!planned.ok) return planned;

  // A store with nothing to run keeps the step record it already has, and a
  // fresh one gets its table with its first step, so a bad step list leaves
  // the store as it found it.
  if (planned.value.length === 0) return ok(recorded);
  sql.exec(META_TABLE);

  let applied = recorded;
  for (const step of planned.value) {
    try {
      storage.transactionSync(() => {
        sql.exec(step.sql);
        sql.exec(RECORD_STEP, String(step.number));
      });
    } catch (error) {
      return err({ kind: "step failed", number: step.number, message: messageOf(error) });
    }
    applied = step.number;
  }
  return ok(applied);
}

/** The project id recorded in `store_meta`, or null before the first call that brings one. */
export function readProjectId(sql: SqlStorage): string | null {
  if (!hasMetaTable(sql)) return null;
  const rows = sql.exec("SELECT value FROM store_meta WHERE key = 'project_id'").toArray();
  const value = rows[0]?.value;
  return typeof value === "string" ? value : null;
}

/** Records the project id once. A second, different id is a broken invariant and throws. */
export function recordProjectId(sql: SqlStorage, projectId: string): void {
  const existing = readProjectId(sql);
  if (existing === projectId) return;
  if (existing !== null) {
    throw new Error(`the store belongs to project ${existing}, not ${projectId}`);
  }
  sql.exec(META_TABLE);
  sql.exec("INSERT INTO store_meta (key, value) VALUES ('project_id', ?)", projectId);
}

/** The store's own tables, without SQLite's and Cloudflare's bookkeeping tables. */
function storeTables(sql: SqlStorage): string[] {
  return sql
    .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
    .toArray()
    .flatMap((row) => (typeof row.name === "string" ? [row.name] : []))
    .filter((name) => !name.startsWith("sqlite_") && !name.startsWith("_cf_"));
}

/** Whether any table but store_meta holds a row, so the sweep keeps its alarm (platform-28). */
export function holdsRows(sql: SqlStorage): boolean {
  return storeTables(sql)
    .filter((name) => name !== "store_meta")
    .some((table) => sql.exec(`SELECT 1 FROM "${table}" LIMIT 1`).toArray().length > 0);
}

/**
 * The tables a purge wipes, children before parents, so a foreign key never
 * blocks a delete. A table not named here goes after them.
 */
const WIPE_ORDER: readonly string[] = [
  "recording_chunks",
  "recordings",
  "person_distinct_ids",
  "events",
  "heatmap_points",
  "cookieless_sessions",
  "salts",
  "counters",
  "persons",
];

/**
 * Deletes every row of every table but store_meta, which keeps the project
 * id so a stopped purge resumes (privacy-03, privacy-21). The caller runs it
 * inside its transaction.
 */
export function wipeRows(sql: SqlStorage): void {
  const present = storeTables(sql).filter((name) => name !== "store_meta");
  const ordered = [
    ...WIPE_ORDER.filter((table) => present.includes(table)),
    ...present.filter((table) => !WIPE_ORDER.includes(table)),
  ];
  for (const table of ordered) sql.exec(`DELETE FROM "${table}"`);
}

/**
 * Inserts import rows into `shape.table`, skipping any whose key is already
 * stored, so a restore can run again (privacy-30). The caller runs it inside
 * its transaction. Answers how many rows were added.
 */
export function insertImportRows(
  sql: SqlStorage,
  shape: { table: string; columns: readonly string[] },
  rows: readonly SqlStorageValue[][],
): number {
  const marks = shape.columns.map(() => "?").join(", ");
  const statement = `INSERT OR IGNORE INTO "${shape.table}" (${shape.columns.join(", ")}) VALUES (${marks}) RETURNING 1`;
  let added = 0;
  for (const row of rows) added += sql.exec(statement, ...row).toArray().length;
  return added;
}
