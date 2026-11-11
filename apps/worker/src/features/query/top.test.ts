import type { JsonObject, Range, TopResult, TopSpec } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import { EVERY_EVENT, resolved, runStatements } from "../../../test/helpers/query.ts";
import { newProjectId } from "../../../test/helpers/registry.ts";
import { type SeedEvent, seedEvents, seedPerson } from "../../../test/helpers/seed.ts";
import { answerTop, compileTop } from "./top.ts";

// The top kinds through a real ProjectStore (query-46 to query-49, query-64 to
// query-72). Europe/Oslo is UTC+2 until 2026-10-25. The range is one local day,
// so every list has a single bucket and the counts are plain. Every expected
// value is worked out by hand from the contract.

const at = (iso: string): number => Date.parse(iso);

const ONE_DAY: Range = {
  kind: "between",
  from: "2026-10-20T00:00:00+02:00",
  to: "2026-10-21T00:00:00+02:00",
};

function specOf(overrides: Partial<TopSpec> = {}): TopSpec {
  return {
    kind: "top",
    range: ONE_DAY,
    measure: "events",
    dimension: { builtin: "event" },
    ...overrides,
  };
}

/** The top list through the compiled statements and the store's own RPC call. */
async function runTop(project: string, top: TopSpec): Promise<TopResult> {
  const compiled = compileTop(top, resolved(top.range, top.timeZone), EVERY_EVENT);
  if (!compiled.ok) throw new Error(`compileTop refused: ${compiled.error}`);
  return answerTop(top, await runStatements(project, compiled.value));
}

/** `count` events at `iso`, a millisecond apart, all holding `properties`. */
function repeated(count: number, iso: string, properties: JsonObject): SeedEvent[] {
  return Array.from({ length: count }, (_, index) => ({ ts: at(iso) + index, properties }));
}

it("query-46 · a direct visit is DIRECT and a referring domain is compared without case", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    ...repeated(2, "2026-10-20T10:00:00Z", { $referring_domain: "$direct" }),
    { ts: at("2026-10-20T10:02:00Z"), properties: { $referring_domain: "Example.COM" } },
  ]);

  const result = await runTop(project, specOf({ dimension: { builtin: "referring_domain" } }));
  expect(result.rows).toEqual([
    { key: "DIRECT", count: 2 },
    { key: "example.com", count: 1 },
  ]);
});

it("query-46 · a campaign is trimmed, Unknown is its own key and a missing one is null", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    ...repeated(2, "2026-10-20T10:00:00Z", { utm_campaign: "  sale  " }),
    { ts: at("2026-10-20T10:02:00Z"), properties: { utm_campaign: "Unknown" } },
    { ts: at("2026-10-20T10:03:00Z") },
  ]);

  const result = await runTop(project, specOf({ dimension: { builtin: "utm_campaign" } }));
  expect(result.rows).toEqual([
    { key: "sale", count: 2 },
    { key: null, count: 1 },
    { key: "Unknown", count: 1 },
  ]);
});

it("query-47 · a property dimension is read by its exact name, slashes and spaces included", async () => {
  const project = newProjectId();
  const name = "a/b c";
  await seedEvents(project, [
    ...repeated(2, "2026-10-20T10:00:00Z", { [name]: "x" }),
    { ts: at("2026-10-20T10:02:00Z"), properties: { [name]: "y" } },
    { ts: at("2026-10-20T10:03:00Z") },
  ]);

  const result = await runTop(project, specOf({ dimension: { property: { of: "event", name } } }));
  expect(result.rows).toEqual([
    { key: "x", count: 2 },
    { key: null, count: 1 },
    { key: "y", count: 1 },
  ]);
});

it("query-48 · a top list pages by keyset with no OFFSET and a stable key order on ties", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    ...repeated(3, "2026-10-20T10:00:00Z", { plan: "c" }),
    { ts: at("2026-10-20T11:00:00Z"), properties: { plan: "b" } },
    { ts: at("2026-10-20T12:00:00Z"), properties: { plan: "a" } },
  ]);

  const top = specOf({ dimension: { property: { of: "event", name: "plan" } } });
  const compiled = compileTop(top, resolved(top.range), EVERY_EVENT);
  if (!compiled.ok) throw new Error(`compileTop refused: ${compiled.error}`);
  for (const statement of compiled.value.statements) {
    expect(statement.sql.toUpperCase()).not.toContain("OFFSET");
  }

  expect((await runTop(project, top)).rows).toEqual([
    { key: "c", count: 3 },
    { key: "a", count: 1 },
    { key: "b", count: 1 },
  ]);
});

it("query-49 · a cursor made for another spec is an invalid cursor", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), page: "www.example.com/a" },
    { ts: at("2026-10-20T11:00:00Z"), page: "www.example.com/b" },
  ]);

  const first = await runTop(project, specOf({ dimension: { builtin: "page" }, limit: 1 }));
  const cursor = first.nextCursor;
  if (cursor === undefined) throw new Error("the first page had no nextCursor");

  const other = compileTop(
    specOf({ dimension: { builtin: "event" }, limit: 1, cursor }),
    resolved(ONE_DAY),
    EVERY_EVENT,
  );
  expect(other).toEqual({ ok: false, error: "invalid cursor" });
});

it("query-64 · a page list counts the events of each page path", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), page: "www.example.com/a" },
    { ts: at("2026-10-20T10:01:00Z"), page: "www.example.com/a" },
    { ts: at("2026-10-20T11:00:00Z"), page: "www.example.com/b" },
  ]);

  const result = await runTop(project, specOf({ dimension: { builtin: "page" } }));
  expect(result.rows).toEqual([
    { key: "www.example.com/a", count: 2 },
    { key: "www.example.com/b", count: 1 },
  ]);
});

it("query-65 · referring domains with equal counts come out in key order", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), properties: { $referring_domain: "c.example" } },
    { ts: at("2026-10-20T11:00:00Z"), properties: { $referring_domain: "a.example" } },
    { ts: at("2026-10-20T12:00:00Z"), properties: { $referring_domain: "b.example" } },
  ]);

  const result = await runTop(project, specOf({ dimension: { builtin: "referring_domain" } }));
  expect(result.rows).toEqual([
    { key: "a.example", count: 1 },
    { key: "b.example", count: 1 },
    { key: "c.example", count: 1 },
  ]);
});

it("query-66 · a country code is trimmed and upper-cased before it is grouped", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), properties: { $geoip_country_code: "no" } },
    { ts: at("2026-10-20T11:00:00Z"), properties: { $geoip_country_code: " NO " } },
    { ts: at("2026-10-20T12:00:00Z"), properties: { $geoip_country_code: "se" } },
  ]);

  const result = await runTop(project, specOf({ dimension: { builtin: "country" } }));
  expect(result.rows).toEqual([
    { key: "NO", count: 2 },
    { key: "SE", count: 1 },
  ]);
});

it("query-67 · a device type is Desktop, Mobile or Tablet, in key order on a tie", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), properties: { $device_type: "Mobile" } },
    { ts: at("2026-10-20T11:00:00Z"), properties: { $device_type: "Desktop" } },
    { ts: at("2026-10-20T12:00:00Z"), properties: { $device_type: "Tablet" } },
  ]);

  const result = await runTop(project, specOf({ dimension: { builtin: "device_type" } }));
  expect(result.rows).toEqual([
    { key: "Desktop", count: 1 },
    { key: "Mobile", count: 1 },
    { key: "Tablet", count: 1 },
  ]);
});

it("query-68 · a browser version is the major number, only for the named browser", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    {
      ts: at("2026-10-20T10:00:00Z"),
      properties: { $browser: "Chrome", $browser_version: "141.0.7390.55" },
    },
    {
      ts: at("2026-10-20T10:01:00Z"),
      properties: { $browser: "Chrome", $browser_version: "141.0.1" },
    },
    {
      ts: at("2026-10-20T10:02:00Z"),
      properties: { $browser: "Chrome", $browser_version: "140.2" },
    },
    {
      ts: at("2026-10-20T10:03:00Z"),
      properties: { $browser: "Safari", $browser_version: "605.1.15" },
    },
  ]);

  const result = await runTop(
    project,
    specOf({ dimension: { builtin: "browser_version", browser: "Chrome" } }),
  );
  expect(result.rows).toEqual([
    { key: "141", count: 2 },
    { key: "140", count: 1 },
  ]);
});

it("query-69 · a campaign list counts sale events and a null key for the events without one", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    ...repeated(2, "2026-10-20T10:00:00Z", { utm_campaign: "sale" }),
    { ts: at("2026-10-20T10:02:00Z") },
  ]);

  const result = await runTop(project, specOf({ dimension: { builtin: "utm_campaign" } }));
  expect(result.rows).toEqual([
    { key: "sale", count: 2 },
    { key: null, count: 1 },
  ]);
});

it("query-70 · limit 2 pages through three pages without repeats and ends without a cursor", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), page: "www.example.com/a" },
    { ts: at("2026-10-20T10:01:00Z"), page: "www.example.com/a" },
    { ts: at("2026-10-20T10:02:00Z"), page: "www.example.com/a" },
    { ts: at("2026-10-20T11:00:00Z"), page: "www.example.com/b" },
    { ts: at("2026-10-20T11:01:00Z"), page: "www.example.com/b" },
    { ts: at("2026-10-20T12:00:00Z"), page: "www.example.com/c" },
  ]);

  const first = await runTop(project, specOf({ dimension: { builtin: "page" }, limit: 2 }));
  expect(first.rows).toEqual([
    { key: "www.example.com/a", count: 3 },
    { key: "www.example.com/b", count: 2 },
  ]);
  const cursor = first.nextCursor;
  if (cursor === undefined) throw new Error("the first page had no nextCursor");

  const second = await runTop(
    project,
    specOf({ dimension: { builtin: "page" }, limit: 2, cursor }),
  );
  expect(second.rows).toEqual([{ key: "www.example.com/c", count: 1 }]);
  expect(second.nextCursor).toBeUndefined();
});

it("query-71 · a missing page and an empty one share one null key", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z") },
    { ts: at("2026-10-20T11:00:00Z"), page: "" },
    { ts: at("2026-10-20T12:00:00Z"), page: "/x" },
  ]);

  const result = await runTop(project, specOf({ dimension: { builtin: "page" } }));
  expect(result.rows).toEqual([
    { key: null, count: 2 },
    { key: "/x", count: 1 },
  ]);
  expect(result.rows.map((row) => row.key)).not.toContain("");
});

it("query-72 · a visitor counts once per page, however many ids they used", async () => {
  const project = newProjectId();
  const person = await seedPerson(project, ["user-a", "user-b"]);
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), personId: person, distinctId: "user-a", page: "/a" },
    { ts: at("2026-10-20T10:01:00Z"), personId: person, distinctId: "user-b", page: "/b" },
    { ts: at("2026-10-20T10:02:00Z"), distinctId: "cookieless_9f8e7d6c5b4a3210", page: "/a" },
    { ts: at("2026-10-20T10:03:00Z"), distinctId: "cookieless_9f8e7d6c5b4a3210", page: "/a" },
  ]);

  const result = await runTop(
    project,
    specOf({ dimension: { builtin: "page" }, measure: "visitors" }),
  );
  expect(result.rows).toEqual([
    { key: "/a", count: 2 },
    { key: "/b", count: 1 },
  ]);
});

it("query-127 · the channel dimension groups by the stored $channel", async () => {
  const project = newProjectId();
  await seedEvents(project, [
    { ts: at("2026-10-20T10:00:00Z"), properties: { $channel: "organic_search" } },
    { ts: at("2026-10-20T11:00:00Z"), properties: { $channel: "organic_search" } },
    { ts: at("2026-10-20T12:00:00Z"), properties: { $channel: "referral" } },
    { ts: at("2026-10-20T13:00:00Z"), properties: {} },
  ]);

  const result = await runTop(project, specOf({ dimension: { builtin: "channel" } }));
  expect(result.rows).toEqual([
    { key: "organic_search", count: 2 },
    { key: null, count: 1 },
    { key: "referral", count: 1 },
  ]);
});
