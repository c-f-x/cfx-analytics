import { QUERY } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import { checkBudget } from "./budget.ts";
import type { Statement } from "./types.ts";

// The query budget's limits on one compiled query (query-31). The budget at
// real size is in budget.size.test.ts.

/** A statement with `count` parameters, all "?". */
function parameters(count: number): Statement {
  return {
    sql: `SELECT ${Array.from({ length: count }, () => "?").join(", ")}`,
    params: Array.from({ length: count }, (_, index) => index),
  };
}

/** A statement of `bytes` UTF-8 bytes; each "é" is two bytes. */
function accented(bytes: number): Statement {
  return { sql: "é".repeat(bytes / 2), params: [] };
}

it("query-31 · a statement binding 100 parameters passes and 101 is too many", () => {
  const passing = checkBudget({ statements: [parameters(100)] });
  expect(passing.ok).toBe(true);
  if (!passing.ok) throw new Error(`expected the query to pass, got ${passing.error}`);
  expect(passing.value.statements[0]?.params).toHaveLength(100);
  expect(checkBudget({ statements: [parameters(101)] })).toEqual({
    ok: false,
    error: "too many parameters",
  });
});

it("query-31 · a statement of exactly sqlBytes UTF-8 bytes passes and one byte more is too long", () => {
  const limit = QUERY.sqlBytes;
  const prefix = "SELECT '";
  const suffix = "'";
  const ascii = (size: number): Statement => ({
    sql: `${prefix}${"a".repeat(size - prefix.length - suffix.length)}${suffix}`,
    params: [],
  });
  expect(new TextEncoder().encode(ascii(limit).sql).length).toBe(limit);
  expect(checkBudget({ statements: [ascii(limit)] }).ok).toBe(true);
  expect(checkBudget({ statements: [ascii(limit + 1)] })).toEqual({
    ok: false,
    error: "statement too long",
  });

  expect(checkBudget({ statements: [accented(limit)] }).ok).toBe(true);
  expect(checkBudget({ statements: [accented(limit + 2)] })).toEqual({
    ok: false,
    error: "statement too long",
  });
});

it("query-31 · parameters are checked before length on the same statement", () => {
  const both: Statement = {
    sql: "é".repeat(QUERY.sqlBytes),
    params: Array.from({ length: 101 }, (_, index) => index),
  };
  expect(checkBudget({ statements: [both] })).toEqual({ ok: false, error: "too many parameters" });
});

it("query-31 · a later statement over a limit still refuses the whole query", () => {
  const fine: Statement = { sql: "SELECT 1", params: [] };
  const wide: Statement = { sql: "SELECT ?", params: Array.from({ length: 101 }, () => 1) };
  expect(checkBudget({ statements: [fine, fine] }).ok).toBe(true);
  expect(checkBudget({ statements: [fine, wide] })).toEqual({
    ok: false,
    error: "too many parameters",
  });
});
