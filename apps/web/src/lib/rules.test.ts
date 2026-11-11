import { expect, it } from "vitest";
import { ruleValueOf } from "./rules.ts";

it("dashboard-11 · a rule's value is read as the type chosen for it", () => {
  expect(ruleValueOf("text", "42")).toBe("42");
  expect(ruleValueOf("text", "localhost")).toBe("localhost");
  expect(ruleValueOf("number", "42")).toBe(42);
  expect(ruleValueOf("number", "-1.5")).toBe(-1.5);
  expect(ruleValueOf("yes/no", "true")).toBe(true);
  expect(ruleValueOf("yes/no", "false")).toBe(false);
});

it("dashboard-11 · a value that is not of its type is no value", () => {
  for (const [type, text] of [
    ["number", "forty"],
    ["number", ""],
    ["number", "1e400"],
    ["yes/no", "maybe"],
    ["text", ""],
  ] as const) {
    expect(ruleValueOf(type, text)).toBeNull();
  }
});
