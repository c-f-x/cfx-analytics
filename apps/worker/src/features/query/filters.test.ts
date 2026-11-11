import type { Dimension, Filter, InternalRule, JsonObject } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import { inStore, newUuid, T0 } from "../../../test/helpers/capture.ts";
import { newProjectId } from "../../../test/helpers/registry.ts";
import { type SeedEvent, seedEvents, seedPerson } from "../../../test/helpers/seed.ts";
import { dimensionSql, exclusionsSql, filterSql, likePattern } from "./filters.ts";
import type { Statement } from "./types.ts";

const eventProperty = (name: string) => ({ of: "event" as const, name });

/** Seeds `rows` and answers their uuids in storage order. */
async function seed(projectId: string, rows: readonly SeedEvent[]): Promise<string[]> {
  const uuids: string[] = [];
  await seedEvents(
    projectId,
    rows.map((row) => {
      const uuid = row.uuid ?? newUuid();
      uuids.push(uuid);
      return { ...row, uuid };
    }),
  );
  return uuids;
}

/** The uuids of the events `fragment` selects, in storage order. */
async function matching(projectId: string, fragment: Statement): Promise<string[]> {
  return inStore(projectId, (sql) =>
    sql
      .exec<{ uuid: string }>(
        `SELECT uuid FROM events e WHERE ${fragment.sql} ORDER BY id`,
        ...fragment.params,
      )
      .toArray()
      .map((row) => row.uuid),
  );
}

/** Each seeded event's dimension value, in storage order. */
async function dimensionValues(projectId: string, dimension: Dimension): Promise<unknown[]> {
  const fragment = dimensionSql(dimension);
  return inStore(projectId, (sql) =>
    sql
      .exec(
        `SELECT ${fragment.value.sql} AS v FROM events e WHERE ${fragment.where.sql} ORDER BY id`,
        ...fragment.value.params,
        ...fragment.where.params,
      )
      .toArray()
      .map((row) => row.v),
  );
}

const propertiesOf = (...names: readonly string[]): JsonObject =>
  Object.fromEntries(names.map((name) => [name, 1]));

it("query-02 · a property name holding quotes, dots, brackets or SQL is bound, never pasted into SQL", async () => {
  const project = newProjectId();
  const names = ["it's", 'say "hi"', "a.b", "list[0]", "x'); DROP TABLE events; --"];
  const uuids = await seed(
    project,
    names.map((name) => ({ ts: T0, properties: { ...propertiesOf(name), a: "other" } })),
  );
  for (const [index, name] of names.entries()) {
    const fragment = filterSql({ op: "eq", property: eventProperty(name), value: 1 });
    expect(fragment.params).toContain(name);
    expect(fragment.sql).not.toContain(name);
    expect(await matching(project, fragment)).toEqual(uuids.slice(index, index + 1));
  }
});

it("query-02 · a dimension's property name is bound too, and reads that one key only", async () => {
  const project = newProjectId();
  const names = ["it's", 'say "hi"', "a.b", "list[0]", "x'); DROP TABLE events; --"];
  await seed(
    project,
    names.map((name) => ({ ts: T0, properties: propertiesOf(name) })),
  );
  for (const [index, name] of names.entries()) {
    const dimension = { property: eventProperty(name) };
    const fragment = dimensionSql(dimension);
    expect(fragment.value.params).toContain(name);
    expect(fragment.value.sql).not.toContain(name);
    const values = await dimensionValues(project, dimension);
    const present = values
      .map((value, at) => (value === null ? null : at))
      .filter((at) => at !== null);
    expect(present).toEqual([index]);
  }
});

it("query-52 · eq and in match the stored JSON type and value exactly", async () => {
  const project = newProjectId();
  const uuids = await seed(project, [
    { ts: T0, properties: { n: 2 } },
    { ts: T0, properties: { n: "2" } },
    { ts: T0, properties: { n: true } },
    { ts: T0, properties: { n: false } },
    { ts: T0, properties: { n: [] } },
  ]);
  const matched = (value: string | number | boolean): Promise<string[]> =>
    matching(project, filterSql({ op: "eq", property: eventProperty("n"), value }));
  expect(await matched(2)).toEqual(uuids.slice(0, 1));
  expect(await matched("2")).toEqual(uuids.slice(1, 2));
  expect(await matched(true)).toEqual(uuids.slice(2, 3));
  expect(await matched(false)).toEqual(uuids.slice(3, 4));
  expect(
    await matching(
      project,
      filterSql({ op: "in", property: eventProperty("n"), values: [2, true] }),
    ),
  ).toEqual([uuids[0], uuids[2]].filter((uuid) => uuid !== undefined));
});

it("query-53 · neq and notIn never match an event whose property is missing", async () => {
  const project = newProjectId();
  const uuids = await seed(project, [
    { ts: T0, properties: { n: 1 } },
    { ts: T0, properties: { n: 2 } },
    { ts: T0, properties: {} },
  ]);
  expect(
    await matching(project, filterSql({ op: "neq", property: eventProperty("n"), value: 1 })),
  ).toEqual(uuids.slice(1, 2));
  expect(
    await matching(project, filterSql({ op: "notIn", property: eventProperty("n"), values: [1] })),
  ).toEqual(uuids.slice(1, 2));
});

it("query-54 · exists counts JSON null and an empty array as present, one meaning per operator", async () => {
  const project = newProjectId();
  const uuids = await seed(project, [
    { ts: T0, properties: {} },
    { ts: T0, properties: { v: null } },
    { ts: T0, properties: { v: "" } },
    { ts: T0, properties: { v: [] } },
    { ts: T0, properties: { v: {} } },
    { ts: T0, properties: { v: "x" } },
  ]);
  const property = eventProperty("v");
  const matched = (filter: Filter): Promise<string[]> => matching(project, filterSql(filter));
  expect(await matched({ op: "exists", property })).toEqual(uuids.slice(1));
  expect(await matched({ op: "notExists", property })).toEqual(uuids.slice(0, 1));
  expect(await matched({ op: "isNull", property })).toEqual(uuids.slice(1, 2));
  expect(await matched({ op: "notNull", property })).toEqual(uuids.slice(2));
  expect(await matched({ op: "isEmpty", property })).toEqual(uuids.slice(2, 5));
});

it("query-55 · contains, startsWith and endsWith match strings and never a number", async () => {
  const project = newProjectId();
  const uuids = await seed(project, [
    { ts: T0, properties: { v: "abc123" } },
    { ts: T0, properties: { v: 123 } },
  ]);
  const property = eventProperty("v");
  expect(await matching(project, filterSql({ op: "contains", property, value: "123" }))).toEqual(
    uuids.slice(0, 1),
  );
  expect(await matching(project, filterSql({ op: "startsWith", property, value: "abc" }))).toEqual(
    uuids.slice(0, 1),
  );
  expect(await matching(project, filterSql({ op: "endsWith", property, value: "123" }))).toEqual(
    uuids.slice(0, 1),
  );
});

it("query-56 · between includes both ends, and number operators never match a string", async () => {
  const project = newProjectId();
  const uuids = await seed(project, [
    { ts: T0, properties: { n: 1 } },
    { ts: T0, properties: { n: 5 } },
    { ts: T0, properties: { n: 10 } },
    { ts: T0, properties: { n: "5" } },
  ]);
  const property = eventProperty("n");
  expect(await matching(project, filterSql({ op: "between", property, low: 5, high: 10 }))).toEqual(
    uuids.slice(1, 3),
  );
  expect(await matching(project, filterSql({ op: "gt", property, value: 1 }))).toEqual(
    uuids.slice(1, 3),
  );
  expect(await matching(project, filterSql({ op: "gte", property, value: 5 }))).toEqual(
    uuids.slice(1, 3),
  );
  expect(await matching(project, filterSql({ op: "lt", property, value: 10 }))).toEqual(
    uuids.slice(0, 2),
  );
  expect(await matching(project, filterSql({ op: "lte", property, value: 5 }))).toEqual(
    uuids.slice(0, 2),
  );
});

it("query-57 · a property name is matched case-sensitively", async () => {
  const project = newProjectId();
  const uuids = await seed(project, [
    { ts: T0, properties: { Plan: "pro" } },
    { ts: T0, properties: { plan: "pro" } },
  ]);
  expect(
    await matching(project, filterSql({ op: "eq", property: eventProperty("plan"), value: "pro" })),
  ).toEqual(uuids.slice(1, 2));
  expect(
    await matching(project, filterSql({ op: "eq", property: eventProperty("Plan"), value: "pro" })),
  ).toEqual(uuids.slice(0, 1));
});

it("query-57 · referring_domain is lower-cased with $direct as DIRECT, and utm_campaign is trimmed", async () => {
  const project = newProjectId();
  await seed(project, [
    { ts: T0, properties: { $referring_domain: "$direct" } },
    { ts: T0, properties: { $referring_domain: "Example.COM" } },
    { ts: T0, properties: { utm_campaign: "  spring  " } },
  ]);
  expect(await dimensionValues(project, { builtin: "referring_domain" })).toEqual([
    "DIRECT",
    "example.com",
    null,
  ]);
  expect(await dimensionValues(project, { builtin: "utm_campaign" })).toEqual([
    null,
    null,
    "spring",
  ]);
});

it("query-58 · eq false does not match 0, and eq 0 does not match false", async () => {
  const project = newProjectId();
  const uuids = await seed(project, [
    { ts: T0, properties: { v: false } },
    { ts: T0, properties: { v: 0 } },
    { ts: T0, properties: { v: "false" } },
  ]);
  const property = eventProperty("v");
  expect(await matching(project, filterSql({ op: "eq", property, value: false }))).toEqual(
    uuids.slice(0, 1),
  );
  expect(await matching(project, filterSql({ op: "eq", property, value: 0 }))).toEqual(
    uuids.slice(1, 2),
  );
  expect(await matching(project, filterSql({ op: "in", property, values: [false, 0] }))).toEqual(
    uuids.slice(0, 2),
  );
});

it("query-07 · the default exclusion is e.bot = 0, so includeBots lets a bot through", async () => {
  const project = newProjectId();
  const uuids = await seed(project, [
    { ts: T0, bot: false },
    { ts: T0, bot: true },
  ]);
  const quiet = exclusionsSql([], { includeBots: false, includeInternal: false });
  expect(quiet.applied).toEqual([]);
  expect(await matching(project, quiet.where)).toEqual(uuids.slice(0, 1));
  const loud = exclusionsSql([], { includeBots: true, includeInternal: false });
  expect(await matching(project, loud.where)).toEqual(uuids);
});

it("query-08 · an event-property rule and a person-property rule leave out their matches only", async () => {
  const project = newProjectId();
  const owner = await seedPerson(project, ["owner"], { email: "owner@example.test" });
  const uuids = await seed(project, [
    { ts: T0 - 4000, personId: owner, properties: { internal: true } },
    { ts: T0 - 3000, personId: owner, properties: {} },
    { ts: T0 - 2000, properties: { internal: true } },
    { ts: T0 - 1000, properties: {} },
  ]);
  const rules: InternalRule[] = [
    { kind: "event_property", property: "internal", value: true },
    { kind: "person_property", property: "email", value: "owner@example.test" },
  ];
  const quiet = exclusionsSql(rules, { includeBots: false, includeInternal: false });
  expect(quiet.applied).toEqual([0, 1]);
  // The event rule leaves out events 0 and 2, the person rule 0 and 1: only 3 stays.
  expect(await matching(project, quiet.where)).toEqual(uuids.slice(3));
  const included = exclusionsSql(rules, { includeBots: false, includeInternal: true });
  expect(included.applied).toEqual([]);
  expect(await matching(project, included.where)).toEqual(uuids);
});

it("query-60 · with no filter the exclusions still leave out bots and internal traffic", async () => {
  const project = newProjectId();
  const uuids = await seed(project, [
    { ts: T0, bot: false, properties: { user: "owner" } },
    { ts: T0, bot: true, properties: {} },
    { ts: T0, bot: false, properties: { internal: true } },
  ]);
  const quiet = exclusionsSql([{ kind: "event_property", property: "internal", value: true }], {
    includeBots: false,
    includeInternal: false,
  });
  expect(quiet.applied).toEqual([0]);
  expect(await matching(project, quiet.where)).toEqual(uuids.slice(0, 1));
  const everything = exclusionsSql([], { includeBots: true, includeInternal: true });
  expect(everything.applied).toEqual([]);
  expect(await matching(project, everything.where)).toEqual(uuids);
});

it("query-50 · a search term's %, _ and \\ are escaped, and contains matches them literally", async () => {
  const pattern = likePattern("50%_off\\", "contains");
  expect(pattern).toContain("50\\%\\_off\\\\");
  const project = newProjectId();
  const uuids = await seed(project, [
    { ts: T0 - 5000, properties: { code: "50% off" } },
    { ts: T0 - 4000, properties: { code: "500 off" } },
    { ts: T0 - 3000, properties: { code: "a_b" } },
    { ts: T0 - 2000, properties: { code: "axb" } },
    { ts: T0 - 1000, properties: { code: "back\\slash" } },
  ]);
  const containing = (term: string) =>
    matching(project, filterSql({ op: "contains", property: eventProperty("code"), value: term }));
  expect(await containing("50%")).toEqual([uuids[0]]);
  expect(await containing("a_b")).toEqual([uuids[2]]);
  expect(await containing("back\\")).toEqual([uuids[4]]);
});
