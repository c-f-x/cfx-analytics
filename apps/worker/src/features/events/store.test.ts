import { expect, it } from "vitest";
import { counterValue, inStore, newUuid, storedEvents, T0 } from "../../../test/helpers/capture.ts";
import { newProjectId } from "../../../test/helpers/registry.ts";
import { type EventInsert, insertEvents, pruneCounters, takeFromCap } from "./store.ts";

// The events slice's own tables, reached through `inStore` in a real
// ProjectStore (events-01, events-06, events-09, events-10, events-13,
// events-15). Each test takes a fresh project, so no two tests share rows.

const DAY = "2026-10-21";
const YESTERDAY = "2026-10-20";

/** One row as ingest hands it to the table. */
function row(overrides: Partial<EventInsert> = {}): EventInsert {
  return {
    uuid: newUuid(),
    event: "$pageview",
    distinctId: "user-events",
    personId: null,
    sessionId: null,
    ts: T0,
    receivedAt: T0,
    bot: false,
    page: null,
    properties: {},
    ...overrides,
  };
}

it("events-01 · takeFromCap makes the day's counter and grants what fits under the cap", async () => {
  const project = newProjectId();

  const first = await inStore(project, (sql) => takeFromCap(sql, DAY, "events", 5, 3));
  expect(first).toBe(3);
  expect(await counterValue(project, DAY)).toBe(3);

  const second = await inStore(project, (sql) => takeFromCap(sql, DAY, "events", 5, 3));
  expect(second).toBe(2);
  expect(await counterValue(project, DAY)).toBe(5);

  const third = await inStore(project, (sql) => takeFromCap(sql, DAY, "events", 5, 1));
  expect(third).toBe(0);
  expect(await counterValue(project, DAY)).toBe(5);
});

it("events-06 · insertEvents answers only the rows whose uuid was new", async () => {
  const project = newProjectId();
  const already = row();

  const first = await inStore(project, (sql) => insertEvents(sql, [already, row()]));
  expect(first).toEqual({ ok: true, value: 2 });

  const second = await inStore(project, (sql) => insertEvents(sql, [already, row(), row()]));
  expect(second).toEqual({ ok: true, value: 2 });
  expect(await storedEvents(project)).toHaveLength(4);
});

it("events-09 · with yesterday's counter row today starts at zero and pruning keeps yesterday's", async () => {
  const project = newProjectId();
  await inStore(project, (sql) => {
    sql.exec("INSERT INTO counters (day, name, value) VALUES (?, 'events', ?)", YESTERDAY, 5);
    return null;
  });

  const granted = await inStore(project, (sql) => takeFromCap(sql, DAY, "events", 5, 3));
  expect(granted).toBe(3);
  expect(await counterValue(project, DAY)).toBe(3);
  expect(await counterValue(project, YESTERDAY)).toBe(5);

  await inStore(project, (sql) => {
    sql.exec("INSERT INTO counters (day, name, value) VALUES ('2026-10-19', 'events', 4)");
    return null;
  });
  const pruned = await inStore(project, (sql) => pruneCounters(sql, YESTERDAY));
  expect(pruned).toBe(1);
  expect(await counterValue(project, YESTERDAY)).toBe(5);
  expect(await counterValue(project, DAY)).toBe(3);
  expect(await counterValue(project, "2026-10-19")).toBeNull();
});

it("events-10 · the same uuid twice in one batch stores one row with the first copy's properties", async () => {
  const project = newProjectId();
  const uuid = newUuid();

  const answer = await inStore(project, (sql) =>
    insertEvents(sql, [
      row({ uuid, properties: { copy: "first" } }),
      row({ uuid, properties: { copy: "second" } }),
    ]),
  );
  expect(answer).toEqual({ ok: true, value: 1 });

  const [stored] = await storedEvents(project);
  if (stored === undefined) throw new Error("the batch stored no row");
  expect(stored.properties).toEqual({ copy: "first" });
});

it("events-10 · a later batch with the same uuid changes nothing and a plain INSERT fails", async () => {
  const project = newProjectId();
  const uuid = newUuid();
  await inStore(project, (sql) =>
    insertEvents(sql, [row({ uuid, properties: { copy: "first" } })]),
  );

  const later = await inStore(project, (sql) =>
    insertEvents(sql, [row({ uuid, properties: { copy: "third" } })]),
  );
  expect(later).toEqual({ ok: true, value: 0 });

  const [stored] = await storedEvents(project);
  if (stored === undefined) throw new Error("the row is gone");
  expect(stored.properties).toEqual({ copy: "first" });

  await expect(
    inStore(project, (sql) => {
      sql.exec(
        `INSERT INTO events (uuid, event, distinct_id, ts, received_at, properties)
         VALUES (?, ?, ?, ?, ?, ?)`,
        uuid,
        "$pageview",
        "user-events",
        T0,
        T0,
        "{}",
      );
      return null;
    }),
  ).rejects.toThrow(/unique/i);
});

it("events-13 · insertEvents answers row refused for a row the table's NOT NULL refuses", async () => {
  const project = newProjectId();
  // The table is the last guard: a caller can hand it a row with no uuid, which
  // intake-31 would have replaced before the store sees it. Object.assign puts
  // the null there where a cast would, and the type checker allows it.
  const refused = Object.assign(row(), { uuid: null });

  const answer = await inStore(project, (sql) => insertEvents(sql, [refused]));
  if (answer.ok) throw new Error("a row with no uuid was accepted");
  expect(answer.error.kind).toBe("row refused");
  expect(await storedEvents(project)).toEqual([]);
});

it("events-15 · properties keep their JSON types, values and names through the store", async () => {
  const project = newProjectId();
  // Beyond 2^53: JSON.parse rounds it before the store sees it, so the value
  // JavaScript holds is the one that must come back (map, question 2).
  const properties = {
    nothing: null,
    empty: {},
    big: 2 ** 60,
    "a/b": "slash",
    "a~b": "tilde",
  };
  await inStore(project, (sql) => insertEvents(sql, [row({ properties })]));

  const [stored] = await storedEvents(project);
  if (stored === undefined) throw new Error("the row was not stored");
  expect(stored.properties).toEqual({
    nothing: null,
    empty: {},
    big: 2 ** 60,
    "a/b": "slash",
    "a~b": "tilde",
  });
  expect("nothing" in stored.properties).toBe(true);
  expect(stored.properties.nothing).toBeNull();
  expect(stored.properties.empty).toEqual({});
  expect(JSON.parse(stored.propertiesText)).toEqual(stored.properties);
});

it("events-13 · a row the STRICT table refuses on type answers row refused instead of throwing", async () => {
  const project = newProjectId();
  // OR IGNORE does not cover a STRICT datatype violation: SQLite throws, and
  // the store must still answer a value, so the batch is a 503 and not a crash.
  const answer = await inStore(project, (sql) => insertEvents(sql, [row({ ts: T0 + 0.5 })]));
  if (answer.ok) throw new Error("a row with a fractional ts was accepted");
  expect(answer.error.kind).toBe("row refused");
  expect(await storedEvents(project)).toEqual([]);
});
