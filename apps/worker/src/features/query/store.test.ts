import { expect, it } from "vitest";
import { inStore, T0 } from "../../../test/helpers/capture.ts";
import { newProjectId } from "../../../test/helpers/registry.ts";
import { seedEvents } from "../../../test/helpers/seed.ts";
import { runCompiled } from "./store.ts";
import type { CompiledQuery, Statement } from "./types.ts";

it("query-12 · runCompiled answers each statement's rows and the sum of their rowsRead", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    { ts: T0 - 3000 },
    { ts: T0 - 2000 },
    { ts: T0 - 1000 },
    { ts: T0 - 500 },
    { ts: T0 - 250 },
  ]);
  const ids: Statement = { sql: "SELECT id FROM events ORDER BY id", params: [] };
  const count: Statement = { sql: "SELECT count(*) AS n FROM events", params: [] };
  const query: CompiledQuery = { statements: [ids, count] };

  const read = await inStore(project, (sql) => {
    const whole = runCompiled(sql, query);
    if (!whole.ok) throw new Error(`runCompiled refused: ${JSON.stringify(whole.error)}`);
    const onlyCount = runCompiled(sql, { statements: [count] });
    if (!onlyCount.ok) throw new Error(`runCompiled refused: ${JSON.stringify(onlyCount.error)}`);
    const onlyIds = runCompiled(sql, { statements: [ids] });
    if (!onlyIds.ok) throw new Error(`runCompiled refused: ${JSON.stringify(onlyIds.error)}`);
    return { whole: whole.value, onlyCount: onlyCount.value, onlyIds: onlyIds.value };
  });

  expect(read.whole.results).toHaveLength(2);
  expect(read.whole.results[0]).toHaveLength(5);
  expect(read.whole.results[1]).toEqual([[5]]);
  if (
    read.whole.rowsRead === null ||
    read.onlyCount.rowsRead === null ||
    read.onlyIds.rowsRead === null
  ) {
    throw new Error("the store reported no rowsRead");
  }
  expect(read.whole.rowsRead).toBe(read.onlyIds.rowsRead + read.onlyCount.rowsRead);
});

it("platform-35 · a statement SQLite refuses is an error value naming its index, never a throw", async () => {
  const project = newProjectId();
  await seedEvents(project, [{ ts: T0 }]);
  const first: Statement = { sql: "SELECT 1 AS one", params: [] };
  const broken: Statement = { sql: "SELECT nope FROM events", params: [] };

  const refused = await inStore(project, (sql) =>
    runCompiled(sql, { statements: [first, broken] }),
  );
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error("expected a refusal");
  expect(refused.error.kind).toBe("query failed");
  expect(refused.error.statement).toBe(1);
  expect(refused.error.message).toContain("nope");

  const atZero = await inStore(project, (sql) => runCompiled(sql, { statements: [broken] }));
  expect(atZero.ok).toBe(false);
  if (atZero.ok) throw new Error("expected a refusal");
  expect(atZero.error.statement).toBe(0);
});

it("query-12 · a store answer holds one row array per statement, each row in SELECT order", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    { ts: T0 - 3000, event: "alpha", distinctId: "user-a" },
    { ts: T0 - 2000, event: "beta", distinctId: "user-b" },
    { ts: T0 - 1000, event: "alpha", distinctId: "user-a" },
  ]);
  const query: CompiledQuery = {
    statements: [
      { sql: "SELECT event, distinct_id FROM events ORDER BY id", params: [] },
      { sql: "SELECT count(*) AS n FROM events WHERE event = ?", params: ["alpha"] },
    ],
  };

  const rows = await inStore(project, (sql) => {
    const result = runCompiled(sql, query);
    if (!result.ok) throw new Error(`runCompiled refused: ${JSON.stringify(result.error)}`);
    return result.value;
  });

  expect(rows.results).toEqual([
    [
      ["alpha", "user-a"],
      ["beta", "user-b"],
      ["alpha", "user-a"],
    ],
    [[2]],
  ]);
  expect(rows.results).toHaveLength(query.statements.length);
  expect(typeof rows.rowsRead).toBe("number");
});
