import { err, messageOf, ok, type Result } from "../../platform/result.ts";
import { funnelFolder } from "./funnel.ts";
import { retentionFolder } from "./retention.ts";
import { trendFolder } from "./trend.ts";
import type { CompiledQuery, Fold, Folder, RunError, SqlValue, StoreRows } from "./types.ts";

// Runs compiled statements against a ProjectStore's SQLite (D-18). Read only:
// the ProjectStore calls it from runQuery and nothing else does.

/**
 * Runs each statement in order with its bound parameters and answers its
 * rows as arrays of column values, in SELECT order, and the sum of the
 * cursors' rowsRead (query-12). With a fold, the last statement's rows go
 * through it one at a time, and its result sets stand in that statement's
 * place (D-26). A statement SQLite refuses is "query failed" with its index
 * and message, never a throw (platform-35, D-22).
 */
export function runCompiled(sql: SqlStorage, query: CompiledQuery): Result<StoreRows, RunError> {
  const results: SqlValue[][][] = [];
  let rowsRead = 0;
  const last = query.statements.length - 1;
  for (const [index, statement] of query.statements.entries()) {
    const folder = index === last && query.fold !== undefined ? folderOf(query.fold) : null;
    const rows: SqlValue[][] = [];
    let read = 0;
    try {
      const cursor = sql.exec(statement.sql, ...statement.params);
      for (const row of cursor.raw()) {
        if (folder === null) rows.push(valuesOf(row));
        else folder.add(valuesOf(row));
      }
      read = cursor.rowsRead;
    } catch (cause) {
      return err({ kind: "query failed", statement: index, message: messageOf(cause) });
    }
    if (folder === null) results.push(rows);
    else results.push(...folder.finish());
    rowsRead += read;
  }
  return ok({ results, rowsRead });
}

/** The running state of a fold (D-26). */
function folderOf(fold: Fold): Folder {
  if (fold.kind === "funnel") return funnelFolder(fold);
  if (fold.kind === "retention") return retentionFolder(fold);
  return trendFolder(fold);
}

/**
 * One row's values in SELECT order. The compiler selects no BLOB, so one
 * answered here fails its statement rather than inventing a value.
 */
function valuesOf(row: readonly SqlStorageValue[]): SqlValue[] {
  return row.map((value) => {
    if (typeof value === "string" || typeof value === "number" || value === null) return value;
    throw new Error("a query statement selected a BLOB");
  });
}
