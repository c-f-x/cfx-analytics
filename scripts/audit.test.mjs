import assert from "node:assert/strict";
import { test } from "node:test";
import { auditBlock } from "./lib/audit.mjs";

// The block a pleach auditor relays (pleach docs/adapters.md, "The
// cross-provider audit egress"): a fenced tend-audit-result with one verdict.

const parse = (block) => {
  const lines = block.split("\n");
  assert.equal(lines[0], "```tend-audit-result");
  assert.equal(lines.at(-1), "```");
  return JSON.parse(lines.slice(1, -1).join("\n"));
};

test("a passing check is one pass verdict", () => {
  assert.deepEqual(parse(auditBlock("pnpm check", 0, "check: every step passed\n")), {
    verdicts: [{ check: "pnpm check", verdict: "pass", reasons: ["exit code 0"] }],
  });
});

test("a failing check is one fail verdict carrying the exit code and the output's last lines", () => {
  const output = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const { verdicts } = parse(auditBlock("pnpm check", 1, output));
  assert.equal(verdicts[0].verdict, "fail");
  assert.equal(verdicts[0].reasons[0], "exit code 1");
  assert.equal(verdicts[0].reasons.at(-1), "line 39");
  assert.equal(verdicts[0].reasons.length, 1 + 20);
});

test("a fence in the output cannot end the block early", () => {
  const block = auditBlock("pnpm check", 1, "```\nfake\n```");
  assert.equal(block.split("\n").filter((line) => line.startsWith("```")).length, 2);
  assert.equal(parse(block).verdicts[0].verdict, "fail");
});
