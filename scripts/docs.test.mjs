import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { POSTHOG_JS_VERSION } from "../apps/worker/src/features/config/core.ts";
import {
  BRIEF,
  BRIEF_MAX_LINES,
  CHECKED_DOCS,
  pathViolations,
  readDoc,
  renderGenerated,
} from "./lib/docs.mjs";
import { openRunScope } from "./lib/run-scope.mjs";

let scope;

before(() => {
  scope = openRunScope({ installExitHandlers: true });
});

after(async () => {
  const { leftovers } = await scope.close();
  assert.deepEqual(leftovers, []);
});

test("the path check flags missing paths and stale planned marks", () => {
  const text = [
    "See `docs/architecture.md` and `apps/worker/src/gone.ts`.",
    "Later: `apps/web/src/features/` (planned), and again `apps/web/src/features/`.",
    "Stale: `docs/design.md` (planned).",
    "Not paths: `/healthz`, `features/<slice>/`, `donor:core/x.ts`, `$set`, `wrangler.jsonc`, `Europe/Oslo`, `@scope/pkg`, `typescript/no-floating-promises`.",
    "With a line number: `docs/data-model.md:12`.",
  ].join("\n");
  const existing = new Set(["docs/architecture.md", "docs/design.md", "docs/data-model.md"]);
  assert.deepEqual(
    pathViolations("sample.md", text, (p) => existing.has(p)),
    [
      'sample.md: docs/design.md exists, so drop its "(planned)"',
      "sample.md: apps/worker/src/gone.ts does not exist",
    ],
  );
});

for (const doc of CHECKED_DOCS) {
  test(`${doc} names only paths that exist or are marked planned`, () => {
    assert.deepEqual(pathViolations(doc, readDoc(doc)), []);
  });
}

test("the folder table leaves out folders git ignores, such as a build's output", () => {
  const root = path.join(scope.dir, "repo");
  for (const dir of ["apps/web/src", "apps/worker/assets/app/assets", "apps/worker/src"]) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  writeFileSync(path.join(root, ".gitignore"), "apps/worker/assets/app/\n");
  writeFileSync(path.join(root, "apps/worker/assets/robots.txt"), "");
  writeFileSync(path.join(root, "apps/worker/assets/app/assets/index.js"), "");
  execFileSync("git", ["init", "--quiet", root]);
  const block = "<!-- generated:layout -->\n<!-- /generated:layout -->";
  const { text } = renderGenerated(block, root);
  assert.match(text, /worker\/\n {4}assets\/\n {4}src\//);
  assert.doesNotMatch(text, / app\//);
});

test("the generated-block check flags a stale block and an unknown one", () => {
  const stale = "<!-- generated:schema-steps -->\nold\n<!-- /generated:schema-steps -->";
  const { text } = renderGenerated(stale);
  assert.notEqual(text, stale);
  const { unknown } = renderGenerated("<!-- generated:nothing -->\n<!-- /generated:nothing -->");
  assert.deepEqual(unknown, ["nothing"]);
});

test("the onboarding guide installs the posthog-js version the Worker serves (D-15)", () => {
  assert.ok(CHECKED_DOCS.includes("docs/onboarding.md"));
  const block = "<!-- generated:posthog-js-install -->\n<!-- /generated:posthog-js-install -->";
  const { text, unknown } = renderGenerated(block);
  assert.deepEqual(unknown, []);
  assert.match(
    text,
    new RegExp(
      `npm install --save-exact posthog-js@${POSTHOG_JS_VERSION.replaceAll(".", "\\.")}\n`,
    ),
  );
  assert.match(readDoc("docs/onboarding.md"), /<!-- generated:posthog-js-install -->/);
});

for (const doc of CHECKED_DOCS) {
  test(`${doc}'s generated tables match the code (run pnpm docs:gen)`, () => {
    const written = readDoc(doc);
    const { text, unknown } = renderGenerated(written);
    assert.deepEqual(unknown, []);
    assert.equal(text, written);
  });
}

test(`${BRIEF} stays under ${BRIEF_MAX_LINES} lines`, () => {
  const lines = readDoc(BRIEF).split("\n").length;
  assert.ok(lines <= BRIEF_MAX_LINES, `${BRIEF} has ${lines} lines`);
});
