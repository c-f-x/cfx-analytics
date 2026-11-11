import type { EventsResult, EventsSpec, Range } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import { EVERY_EVENT, resolved, runStatements } from "../../../test/helpers/query.ts";
import { newProjectId } from "../../../test/helpers/registry.ts";
import { seedEvents } from "../../../test/helpers/seed.ts";
import { answerEvents, compileEvents } from "./events-list.ts";

// The event list through a real ProjectStore (query-48 to query-49, query-70,
// events-15). The range is one Oslo day. Every expected row is worked out by
// hand from the contract.

const at = (iso: string): number => Date.parse(iso);

const ONE_DAY: Range = {
  kind: "between",
  from: "2026-10-20T00:00:00+02:00",
  to: "2026-10-21T00:00:00+02:00",
};

function specOf(overrides: Partial<EventsSpec> = {}): EventsSpec {
  return { kind: "events", range: ONE_DAY, ...overrides };
}

/** The event list through the compiled statements and the store's own RPC call. */
async function runEvents(project: string, events: EventsSpec): Promise<EventsResult> {
  const compiled = compileEvents(events, resolved(events.range), EVERY_EVENT);
  if (!compiled.ok) throw new Error(`compileEvents refused: ${compiled.error}`);
  return answerEvents(events, await runStatements(project, compiled.value));
}

it("events-15 · a row carries its properties with their JSON types unchanged", async () => {
  const project = newProjectId();
  const properties = {
    nothing: null,
    empty: {},
    big: 2 ** 60,
    "a/b": "slash",
    "a~b": "tilde",
    flag: false,
    list: [1, "x"],
  };
  await seedEvents(project, [{ ts: at("2026-10-20T10:00:00Z"), event: "custom", properties }]);

  const result = await runEvents(project, specOf());
  expect(result.rows).toHaveLength(1);
  const row = result.rows[0];
  if (row === undefined) throw new Error("the list has no row");
  expect(row.event).toBe("custom");
  expect(row.ts).toBe("2026-10-20T10:00:00.000Z");
  expect(row.properties).toEqual(properties);
  expect("nothing" in row.properties).toBe(true);
  expect(row.properties.nothing).toBeNull();
  expect(row.properties.empty).toEqual({});
  expect(row.properties.flag).toBe(false);
  expect(row.properties.list).toEqual([1, "x"]);
});

it("query-48 · the newest row comes first, ties by greatest id, and no OFFSET is used", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), event: "first" },
    { ts: at("2026-10-20T10:00:00Z"), event: "second" },
    { ts: at("2026-10-20T11:00:00Z"), event: "latest" },
  ]);

  const events = specOf();
  const compiled = compileEvents(events, resolved(ONE_DAY), EVERY_EVENT);
  if (!compiled.ok) throw new Error(`compileEvents refused: ${compiled.error}`);
  for (const statement of compiled.value.statements) {
    expect(statement.sql.toUpperCase()).not.toContain("OFFSET");
  }

  const result = await runEvents(project, events);
  expect(result.rows.map((row) => row.event)).toEqual(["latest", "second", "first"]);
});

it("query-49 · a cursor made for another spec is an invalid cursor", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), event: "one" },
    { ts: at("2026-10-20T11:00:00Z"), event: "two" },
  ]);

  const first = await runEvents(project, specOf({ limit: 1 }));
  const cursor = first.nextCursor;
  if (cursor === undefined) throw new Error("the first page had no nextCursor");

  const other = compileEvents(
    specOf({ limit: 1, event: "$pageview", cursor }),
    resolved(ONE_DAY),
    EVERY_EVENT,
  );
  expect(other).toEqual({ ok: false, error: "invalid cursor" });
});

it("query-70 · limit 2 pages through the rows and the last page has no cursor", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), event: "oldest" },
    { ts: at("2026-10-20T11:00:00Z"), event: "middle" },
    { ts: at("2026-10-20T12:00:00Z"), event: "newest" },
  ]);

  const first = await runEvents(project, specOf({ limit: 2 }));
  expect(first.rows.map((row) => row.event)).toEqual(["newest", "middle"]);
  const cursor = first.nextCursor;
  if (cursor === undefined) throw new Error("the first page had no nextCursor");

  const second = await runEvents(project, specOf({ limit: 2, cursor }));
  expect(second.rows.map((row) => row.event)).toEqual(["oldest"]);
  expect(second.nextCursor).toBeUndefined();
});
