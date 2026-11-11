import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DAY_MS } from "./alarm.ts";
import { projectStore } from "./project-store-id.ts";
import { applySteps } from "./schema.ts";

// The ProjectStore's promises to its callers (platform-22 to platform-28): a
// real object reached through its stub, with its storage inspected in place
// and evicted where the behaviour needs a fresh start.

type StoreStub = ReturnType<typeof projectStore>;

/** The alarm the store has scheduled, or null when it has none. */
function alarmIn(stub: StoreStub): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

/** A TEXT column's value as text. */
function text(value: SqlStorageValue | undefined): string {
  if (typeof value !== "string") throw new Error(`expected a TEXT column, got ${typeof value}`);
  return value;
}

describe("the ProjectStore", () => {
  it("platform-22 · a store newer than the code fails every request", async () => {
    const stub = projectStore(env, "p_platform22_newer");
    await stub.ready();
    await runInDurableObject(stub, (_instance, state) =>
      applySteps(state.storage, [
        { number: 1, sql: "SELECT 1" },
        { number: 2, sql: "SELECT 1" },
      ]),
    );
    await evictDurableObject(stub);
    // The failure is a value, so it crosses RPC with its fields and every caller answers 503.
    expect(await stub.ready()).toEqual({
      ok: false,
      error: { kind: "store is newer than code", recorded: 2, newest: 1 },
    });
  });

  it("platform-24 · ten concurrent calls on a fresh store run the steps once", async () => {
    const stub = projectStore(env, "p_platform24_concurrent");
    const answers = await Promise.all(Array.from({ length: 10 }, () => stub.ready()));
    expect(answers).toEqual(Array.from({ length: 10 }, () => ({ ok: true, value: { step: 1 } })));
    const tables = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => text(row.name)),
    );
    expect(tables).toContain("events");
  });

  it("platform-25 · an evicted store runs no applied step again and keeps its earlier event", async () => {
    const stub = projectStore(env, "p_platform25_evicted");
    await stub.ready();
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec(
        "INSERT INTO events (uuid, event, distinct_id, ts, received_at, properties) VALUES (?, ?, ?, ?, ?, ?)",
        "00000000-0000-4000-8000-000000000025",
        "$pageview",
        "distinct-25",
        1_800_000_000_000,
        1_800_000_000_001,
        "{}",
      ),
    );
    await evictDurableObject(stub);
    expect(await stub.ready()).toEqual({ ok: true, value: { step: 1 } });
    const events = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec("SELECT event FROM events")
        .toArray()
        .map((row) => text(row.event)),
    );
    expect(events).toEqual(["$pageview"]);
  });

  it("platform-27 · a request on a store with no alarm sets one for the next daily sweep", async () => {
    const stub = projectStore(env, "p_platform27_first_alarm");
    const before = Date.now();
    await stub.ready();
    const after = Date.now();
    const alarm = await alarmIn(stub);
    if (alarm === null) throw new Error("a request on a fresh store left no alarm");
    expect(alarm).toBeGreaterThanOrEqual(before + DAY_MS);
    expect(alarm).toBeLessThanOrEqual(after + DAY_MS);
  });

  it("platform-27 · a request never moves an alarm later", async () => {
    const stub = projectStore(env, "p_platform27_kept");
    await stub.ready();
    const sooner = Date.now() + 60 * 60 * 1000;
    await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(sooner));
    await stub.ready();
    expect(await alarmIn(stub)).toBe(sooner);
  });

  it("platform-28 · a store with nothing to sweep drops its alarm and the next request sets one again", async () => {
    const stub = projectStore(env, "p_platform28_rearmed");
    await stub.ready();
    await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
    expect(await alarmIn(stub)).toBeNull();
    const before = Date.now();
    await stub.ready();
    const after = Date.now();
    const alarm = await alarmIn(stub);
    if (alarm === null) throw new Error("a request after a dropped alarm left none");
    expect(alarm).toBeGreaterThanOrEqual(before + DAY_MS);
    expect(alarm).toBeLessThanOrEqual(after + DAY_MS);
  });
});
