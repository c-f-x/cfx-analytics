import { expect, it } from "vitest";
import { jsonPointer } from "./errors.ts";

// An issue's path as a JSON pointer (RFC 6901), the one form every 4xx
// answer uses (platform-34, query-18).

it("platform-34 · a path becomes a JSON pointer, with ~ and / escaped in that order", () => {
  expect(jsonPointer(["range", "from"])).toBe("/range/from");
  expect(jsonPointer(["steps", 1, "id"])).toBe("/steps/1/id");
  expect(jsonPointer(["a/b", "c~d", "~1"])).toBe("/a~1b/c~0d/~01");
  expect(jsonPointer([])).toBe("");
});
