import { expect, it } from "vitest";
import { base64url } from "../../../test/helpers/registry.ts";
import { type CursorKey, decodeCursor, encodeCursor, fingerprint } from "./cursor.ts";

const asCursor = (value: unknown): string =>
  base64url(new TextEncoder().encode(JSON.stringify(value)));

it("query-48 · a top key and an events key survive encode then decode", () => {
  const topSpec = { kind: "top", dimension: { builtin: "page" }, limit: 10 };
  const top: CursorKey = { kind: "top", count: 7, key: "page-1" };
  expect(decodeCursor(encodeCursor(top, fingerprint(topSpec)), fingerprint(topSpec))).toEqual({
    ok: true,
    value: top,
  });

  const eventsSpec = { kind: "events", limit: 50 };
  const lastSeen: CursorKey = { kind: "events", ts: 1_790_000_000_000, id: 1_234 };
  expect(
    decodeCursor(encodeCursor(lastSeen, fingerprint(eventsSpec)), fingerprint(eventsSpec)),
  ).toEqual({ ok: true, value: lastSeen });
});

it("query-48 · the fingerprint ignores key order and the cursor, and differs for another limit", () => {
  const spec = { kind: "top", dimension: { builtin: "page" }, limit: 10 };
  const reordered = { limit: 10, dimension: { builtin: "page" }, kind: "top" };
  expect(fingerprint(reordered)).toBe(fingerprint(spec));
  expect(fingerprint({ ...spec, cursor: "abc" })).toBe(fingerprint(spec));
  expect(fingerprint({ ...spec, limit: 11 })).not.toBe(fingerprint(spec));
});

it("query-49 · text that is not base64url JSON, or not a CursorKey, is an invalid cursor", () => {
  const print = fingerprint({ kind: "events", limit: 50 });
  const cursors = [
    "not base64url!",
    asCursor({ hello: "world" }),
    asCursor({ kind: "top", count: "seven", key: "page" }),
    asCursor([1, 2, 3]),
  ];
  for (const cursor of cursors) {
    expect(decodeCursor(cursor, print)).toEqual({ ok: false, error: "invalid cursor" });
  }
});

it("query-49 · a well-formed cursor made for another spec is an invalid cursor", () => {
  const eventsSpec = { kind: "events", limit: 50 };
  const otherSpec = { kind: "events", limit: 10 };
  const cursor = encodeCursor({ kind: "events", ts: 1, id: 2 }, fingerprint(eventsSpec));
  expect(decodeCursor(cursor, fingerprint(eventsSpec))).toEqual({
    ok: true,
    value: { kind: "events", ts: 1, id: 2 },
  });
  expect(decodeCursor(cursor, fingerprint(otherSpec))).toEqual({
    ok: false,
    error: "invalid cursor",
  });
});
