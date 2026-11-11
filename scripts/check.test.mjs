import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runSteps } from "./lib/run-steps.mjs";

const node = (code) => ({ command: process.execPath, args: ["-e", code] });

test("a step made to fail stops the run before anything after it runs", async () => {
  // This test's own marker file: it exists only if the step after the failure ran.
  const marker = path.join(os.tmpdir(), `cfanalytics-check-test-${randomUUID()}`);
  try {
    const result = await runSteps(
      [
        { name: "passes", ...node("process.exit(0)") },
        { name: "fails", ...node("process.exit(3)") },
        {
          name: "must not run",
          ...node(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`),
        },
      ],
      { log: () => {} },
    );
    assert.deepEqual(result, {
      ok: false,
      failed: { name: "fails", code: 3 },
      skipped: ["must not run"],
    });
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(marker, { force: true });
  }
});

test("a run where every step passes reports ok", async () => {
  const result = await runSteps([{ name: "passes", ...node("process.exit(0)") }], {
    log: () => {},
  });
  assert.deepEqual(result, { ok: true });
});

test("a command that cannot start counts as a failure", async () => {
  const result = await runSteps(
    [{ name: "missing", command: `no-such-command-${randomUUID()}`, args: [] }],
    {
      log: () => {},
    },
  );
  if (result.ok) assert.fail("a command that cannot start passed");
  assert.equal(result.failed.name, "missing");
});
