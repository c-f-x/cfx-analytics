import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SETTINGS_COLUMNS } from "../features/projects/core.ts";
import { projectStore } from "./project-store-id.ts";
import { applySteps, type SchemaStep, stepsToRun } from "./schema.ts";
import { PROJECT_STORE_STEPS } from "./steps.ts";

// The step runner (platform-19 to platform-26) against a real ProjectStore's
// storage. A failing step and a bad step list need a step list the code does
// not ship, so those call applySteps with a synthetic list on a real object.

/** A step of a synthetic list. Its SQL runs only where stepsToRun selects it. */
const step = (number: number, sql = "SELECT 1"): SchemaStep => ({ number, sql });

/** The steps 1 to `count`, with no work of their own. */
const stepsTo = (count: number): SchemaStep[] =>
  Array.from({ length: count }, (_value, index) => step(index + 1));

/** A TEXT column's value as text. */
function text(value: SqlStorageValue | undefined): string {
  if (typeof value !== "string") throw new Error(`expected a TEXT column, got ${typeof value}`);
  return value;
}

/** The store's own tables, without SQLite's and workerd's internal ones. */
function tableNamesIn(storage: DurableObjectStorage): string[] {
  return storage.sql
    .exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .toArray()
    .map((row) => text(row.name))
    .filter((name) => !/^(sqlite_|_cf_|__miniflare_)/.test(name));
}

/** The step store_meta records as applied. */
function recordedStepIn(storage: DurableObjectStorage): number {
  return Number(storage.sql.exec("SELECT value FROM store_meta WHERE key = 'step'").one().value);
}

/** The columns of any table that carry a project setting's name. */
function settingsColumnsIn(storage: DurableObjectStorage): string[] {
  const settings: readonly string[] = SETTINGS_COLUMNS;
  const found: string[] = [];
  for (const table of tableNamesIn(storage)) {
    const columns = storage.sql.exec(`PRAGMA table_info(${table})`).toArray();
    for (const column of columns) {
      if (settings.includes(text(column.name))) found.push(`${table}.${text(column.name)}`);
    }
  }
  return found;
}

const OWN_TABLES = [
  "cookieless_sessions",
  "counters",
  "events",
  "heatmap_points",
  "person_distinct_ids",
  "persons",
  "recording_chunks",
  "recordings",
  "salts",
  "store_meta",
];

describe("the ProjectStore's schema", () => {
  it("platform-19 · a new store holds the nine tables and the step record", async () => {
    const stub = projectStore(env, "p_platform19_tables");
    await stub.ready();
    expect(
      await runInDurableObject(stub, (_instance, state) => tableNamesIn(state.storage)),
    ).toEqual(OWN_TABLES);
    expect(
      await runInDurableObject(stub, (_instance, state) => recordedStepIn(state.storage)),
    ).toBe(1);
  });

  it("platform-19 · a new store holds no copy of the project's settings", async () => {
    const stub = projectStore(env, "p_platform19_settings");
    await stub.ready();
    const strays = await runInDurableObject(stub, (_instance, state) => {
      const metaKeys = state.storage.sql
        .exec("SELECT key FROM store_meta")
        .toArray()
        .map((row) => text(row.key))
        .filter((key) => key !== "step" && key !== "project_id");
      return [...settingsColumnsIn(state.storage), ...metaKeys.map((key) => `store_meta.${key}`)];
    });
    expect(strays).toEqual([]);
  });

  it("platform-20 · only the steps after the recorded one are left to run, in order", () => {
    const steps = stepsTo(5);
    expect(stepsToRun(3, steps)).toEqual({ ok: true, value: steps.slice(3) });
  });

  it("platform-20 · a store at step 3 runs steps 4 and 5 in order and records 5", async () => {
    const stub = projectStore(env, "p_platform20_runner");
    await stub.ready();
    const steps = [
      step(1),
      step(2, "CREATE TABLE platform20_order (mark TEXT NOT NULL) STRICT"),
      step(3),
      step(4, "INSERT INTO platform20_order (mark) VALUES ('four')"),
      step(5, "INSERT INTO platform20_order (mark) VALUES ('five')"),
    ];
    const advanced = await runInDurableObject(stub, (_instance, state) =>
      applySteps(state.storage, steps.slice(0, 3)),
    );
    expect(advanced).toEqual({ ok: true, value: 3 });
    const applied = await runInDurableObject(stub, (_instance, state) =>
      applySteps(state.storage, steps),
    );
    expect(applied).toEqual({ ok: true, value: 5 });
    const marks = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec("SELECT mark FROM platform20_order ORDER BY rowid")
        .toArray()
        .map((row) => text(row.mark)),
    );
    expect(marks).toEqual(["four", "five"]);
    expect(
      await runInDurableObject(stub, (_instance, state) => recordedStepIn(state.storage)),
    ).toBe(5);
  });

  it("platform-21 · a gap in the step list names the number that breaks the sequence", () => {
    expect(stepsToRun(3, [step(1), step(2), step(4)])).toEqual({
      ok: false,
      error: { kind: "bad step list", numbers: [4] },
    });
  });

  it("platform-21 · a repeated number in the step list is named", () => {
    expect(stepsToRun(3, [step(1), step(2), step(3), step(3)])).toEqual({
      ok: false,
      error: { kind: "bad step list", numbers: [3] },
    });
  });

  it("platform-21 · a store at step 3 with a gap in the step list runs nothing", async () => {
    const stub = projectStore(env, "p_platform21_nothing");
    await stub.ready();
    await runInDurableObject(stub, (_instance, state) => applySteps(state.storage, stepsTo(3)));
    const result = await runInDurableObject(stub, (_instance, state) =>
      applySteps(state.storage, [
        step(1),
        step(2),
        step(4, "CREATE TABLE platform21_ran (x INTEGER) STRICT"),
      ]),
    );
    expect(result).toEqual({ ok: false, error: { kind: "bad step list", numbers: [4] } });
    const tables = await runInDurableObject(stub, (_instance, state) =>
      tableNamesIn(state.storage),
    );
    expect(tables).not.toContain("platform21_ran");
    expect(
      await runInDurableObject(stub, (_instance, state) => recordedStepIn(state.storage)),
    ).toBe(3);
  });

  it("platform-22 · a store newer than the code changes nothing when its steps run again", async () => {
    const stub = projectStore(env, "p_platform22_unchanged");
    await stub.ready();
    await runInDurableObject(stub, (_instance, state) =>
      applySteps(state.storage, [step(1), step(2)]),
    );
    const result = await runInDurableObject(stub, (_instance, state) =>
      applySteps(state.storage, PROJECT_STORE_STEPS),
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: "store is newer than code", recorded: 2, newest: 1 },
    });
    expect(
      await runInDurableObject(stub, (_instance, state) => recordedStepIn(state.storage)),
    ).toBe(2);
  });

  it("platform-23 · a step that fails halfway is rolled back and runs again on the next start", async () => {
    const stub = projectStore(env, "p_platform23_rollback");
    await stub.ready();
    const failing = [
      step(1),
      step(
        2,
        "CREATE TABLE platform23_scratch (x INTEGER) STRICT; INSERT INTO platform23_scratch (x) VALUES ('text')",
      ),
    ];
    const failure = await runInDurableObject(stub, (_instance, state) =>
      applySteps(state.storage, failing),
    );
    expect(failure).toEqual({
      ok: false,
      error: { kind: "step failed", number: 2, message: expect.any(String) },
    });
    const tables = await runInDurableObject(stub, (_instance, state) =>
      tableNamesIn(state.storage),
    );
    expect(tables).not.toContain("platform23_scratch");
    expect(
      await runInDurableObject(stub, (_instance, state) => recordedStepIn(state.storage)),
    ).toBe(1);

    const retried = await runInDurableObject(stub, (_instance, state) =>
      applySteps(state.storage, [
        step(1),
        step(2, "CREATE TABLE platform23_scratch (x INTEGER) STRICT"),
      ]),
    );
    expect(retried).toEqual({ ok: true, value: 2 });
    const retriedTables = await runInDurableObject(stub, (_instance, state) =>
      tableNamesIn(state.storage),
    );
    expect(retriedTables).toContain("platform23_scratch");
    expect(
      await runInDurableObject(stub, (_instance, state) => recordedStepIn(state.storage)),
    ).toBe(2);
  });

  it("platform-26 · a new version keeps the store's rows and adds its columns", async () => {
    const stub = projectStore(env, "p_platform26_upgrade");
    await stub.ready();
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec(
        "INSERT INTO events (uuid, event, distinct_id, ts, received_at, properties) VALUES (?, ?, ?, ?, ?, ?)",
        "00000000-0000-4000-8000-000000000026",
        "$pageview",
        "distinct-26",
        1_800_000_000_000,
        1_800_000_000_001,
        "{}",
      ),
    );
    const upgraded = await runInDurableObject(stub, (_instance, state) =>
      applySteps(state.storage, [
        ...PROJECT_STORE_STEPS,
        step(2, "ALTER TABLE events ADD COLUMN platform26_note TEXT"),
      ]),
    );
    expect(upgraded).toEqual({ ok: true, value: 2 });
    const events = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec("SELECT event, distinct_id FROM events")
        .toArray()
        .map((row) => `${text(row.event)} ${text(row.distinct_id)}`),
    );
    expect(events).toEqual(["$pageview distinct-26"]);
    const columns = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec("PRAGMA table_info(events)")
        .toArray()
        .map((row) => text(row.name)),
    );
    expect(columns).toContain("platform26_note");
  });
});
