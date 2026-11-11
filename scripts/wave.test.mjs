import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { ROOT } from "./lib/source.mjs";
import {
  balancesOf,
  behaviourIds,
  redVerdict,
  testFilesUnder,
  usageOf,
  waveViolations,
} from "./lib/wave.mjs";

test("the wave check flags changes outside the worker's files and unbuilt bodies", () => {
  const own = [
    "apps/worker/src/features/intake/core.ts",
    "apps/worker/src/features/intake/store.ts",
  ];
  const found = waveViolations({
    changed: [...own, "apps/worker/test/intake.test.ts", "docs/architecture.md"],
    own,
    ownSources: [
      { file: path.join(ROOT, own[0]), text: "export const f = () => 1;" },
      { file: path.join(ROOT, own[1]), text: 'export const g = () => unbuilt("intake.g");' },
    ],
  });
  assert.deepEqual(found, [
    "apps/worker/test/intake.test.ts is not yours to change",
    "docs/architecture.md is not yours to change",
    "apps/worker/src/features/intake/store.ts is not built yet",
  ]);
});

const line = (id, usage) => JSON.stringify({ message: { id, usage } });

test("token use counts each answer once, though the transcript repeats it", () => {
  const a = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0 };
  const b = { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 900 };
  const lines = [line("a", a), line("a", a), JSON.stringify({ type: "user" }), line("b", b), ""];
  assert.deepEqual(usageOf(lines), {
    calls: 2,
    input: 105,
    cacheRead: 900,
    cacheWrite: 0,
    output: 13,
  });
});

test("the balance answer is read only in the shape DeepSeek documents", () => {
  const body = { balance_infos: [{ currency: "USD", total_balance: "6.75" }] };
  assert.deepEqual(balancesOf(body), ["6.75 USD"]);
  assert.equal(balancesOf({ balance_infos: [{ currency: "USD" }] }), null);
  assert.equal(balancesOf("nope"), null);
});

const SPEC = `## intake

- \`intake-01\` · given a batch · ours · keep
- \`intake-02\` · given a gzip body · ours · adapt: why

### Rejected

- \`intake-50\` · given a thing · reject: why
`;

test("behaviour IDs are read from the spec, with rejected ones apart", () => {
  const ids = behaviourIds(SPEC);
  assert.deepEqual([...ids.kept], ["intake-01", "intake-02"]);
  assert.deepEqual([...ids.rejected], ["intake-50"]);
});

const result = (title, status, failureMessages = []) => ({ title, status, failureMessages });
const report = (testResults) => ({ testResults });

test("a red run passes when every test names a kept behaviour and fails on a marker", () => {
  const { violations, passed } = redVerdict(
    report([
      {
        name: "/repo/apps/worker/src/features/intake/core.test.ts",
        status: "failed",
        message: "",
        assertionResults: [
          result("intake-01 · a batch is stored", "failed", [
            "Error: unbuilt: intake.decode\n at x",
          ]),
          result("intake-02 · a gzip body is read", "passed"),
        ],
      },
    ]),
    behaviourIds(SPEC),
  );
  assert.deepEqual(violations, []);
  assert.deepEqual(passed, ["intake-02 · a gzip body is read"]);
});

test("a red run flags tests that fail for other reasons, name no kept ID, or never load", () => {
  const { violations } = redVerdict(
    report([
      {
        name: path.join(ROOT, "apps/worker/src/features/intake/core.test.ts"),
        status: "failed",
        message: "",
        assertionResults: [
          result("intake-01 · a typo", "failed", ["TypeError: x is not a function\n at y"]),
          result("a batch is stored", "failed", ["Error: unbuilt: intake.decode"]),
          result("intake-50 · a rejected thing", "failed", ["Error: unbuilt: intake.decode"]),
          result("intake-99 · an unknown thing", "failed", ["Error: unbuilt: intake.decode"]),
        ],
      },
      {
        name: path.join(ROOT, "apps/worker/src/features/intake/http.test.ts"),
        status: "failed",
        message: "Failed to load url ./missing.ts\nmore",
        assertionResults: [],
      },
    ]),
    behaviourIds(SPEC),
  );
  assert.deepEqual(violations, [
    'apps/worker/src/features/intake/core.test.ts: "intake-01 · a typo" fails on something other than a marker: TypeError: x is not a function',
    'apps/worker/src/features/intake/core.test.ts: "a batch is stored" names no behaviour ID',
    'apps/worker/src/features/intake/core.test.ts: "intake-50 · a rejected thing" proves rejected behaviour intake-50',
    'apps/worker/src/features/intake/core.test.ts: "intake-99 · an unknown thing" names unknown behaviour intake-99',
    "apps/worker/src/features/intake/http.test.ts did not load: Failed to load url ./missing.ts",
  ]);
});

test("a red run with no tests at all is a violation", () => {
  assert.deepEqual(redVerdict(report([]), behaviourIds(SPEC)).violations, ["no tests ran"]);
});

test("a test round's files are the test files under each folder it names, and named files as given", () => {
  const all = [
    "apps/worker/src/features/intake/core.ts",
    "apps/worker/src/features/intake/core.test.ts",
    "apps/worker/src/features/intake/http.test.ts",
    "apps/worker/src/features/identity/core.test.ts",
    "apps/worker/src/features/intaker/x.test.ts",
  ];
  assert.deepEqual(
    testFilesUnder(["apps/worker/src/features/intake", "apps/worker/test/helpers/capture.ts"], all),
    [
      "apps/worker/src/features/intake/core.test.ts",
      "apps/worker/src/features/intake/http.test.ts",
      "apps/worker/test/helpers/capture.ts",
    ],
  );
});
