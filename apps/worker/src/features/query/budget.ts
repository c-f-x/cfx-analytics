import { QUERY } from "@cfanalytics/shared";
import { err, ok, type Result } from "../../platform/result.ts";
import type { CompiledQuery } from "./types.ts";

// The store's own limits, checked before anything runs (query-31). Pure.

/**
 * The query unchanged when every statement binds at most
 * QUERY.boundParameters parameters and its SQL text is at most
 * QUERY.sqlBytes UTF-8 bytes; else the first statement over a limit names
 * which ("too many parameters" before "statement too long").
 */
export function checkBudget(
  query: CompiledQuery,
): Result<CompiledQuery, "too many parameters" | "statement too long"> {
  for (const statement of query.statements) {
    if (statement.params.length > QUERY.boundParameters) return err("too many parameters");
    if (new TextEncoder().encode(statement.sql).length > QUERY.sqlBytes) {
      return err("statement too long");
    }
  }
  return ok(query);
}
