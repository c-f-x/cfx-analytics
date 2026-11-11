import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  buildDigest,
  deploySteps,
  healthVerdict,
  planText,
  REGISTRY_TABLES,
  sessionToken,
} from "./lib/ops.mjs";
import { openRunScope } from "./lib/run-scope.mjs";

let scope;

before(() => {
  scope = openRunScope({ installExitHandlers: true });
});

after(async () => {
  const { leftovers } = await scope.close();
  assert.deepEqual(leftovers, []);
});

/** A deployment as the site file gives it (scripts/lib/site.mjs); every value an example. */
const DEPLOYMENT = {
  env: "production",
  worker: "analytics",
  accountId: "0".repeat(32),
  database: "analytics-registry",
  bucket: "analytics-recordings",
  origin: "https://analytics.example.com",
  adminEmail: "owner@example.com",
};

test("every deploy step says how to undo it, with the bookmark and version taken before", () => {
  const input = {
    deployment: DEPLOYMENT,
    config: "/run/wrangler.jsonc",
    bookmark: "0000001a-bookmark",
    previousVersion: "a1b2c3",
    checkedDir: "/run/checked",
    shippedDir: "/run/shipped",
  };
  const steps = deploySteps(input);
  assert.deepEqual(
    steps.map((step) => step.name),
    [
      "check",
      "build the dashboard",
      "bundle the Worker once",
      "apply the registry migrations",
      "deploy the Worker",
      "the shipped bundle is the checked one",
      "the deployment answers /healthz",
    ],
  );
  for (const step of steps) assert.notEqual(step.undo, "");
  const migrate = steps[3];
  assert.match(
    migrate.undo,
    /^pnpm ops wrangler production -- d1 time-travel restore analytics-registry --bookmark 0000001a-bookmark /,
  );
  assert.equal(steps[4].undo, "pnpm ops wrangler production -- rollback a1b2c3");
  // Every wrangler step runs against the config joined from the site file (D-32).
  assert.deepEqual(argsOf(steps[2]).slice(-7), [
    "--dry-run",
    "--env",
    "production",
    "--outdir",
    "/run/checked",
    "--config",
    "/run/wrangler.jsonc",
  ]);
  assert.deepEqual(argsOf(steps[3]).slice(-2), ["--config", "/run/wrangler.jsonc"]);
  assert.deepEqual(argsOf(steps[4]).slice(-6), [
    "--env",
    "production",
    "--outdir",
    "/run/shipped",
    "--config",
    "/run/wrangler.jsonc",
  ]);

  const first = deploySteps({ ...input, previousVersion: null });
  assert.match(first[4].undo, /first deploy: pnpm ops wrangler production -- delete removes it/);
  assert.match(planText(first), /^1\. check\n {3}runs: pnpm check\n {3}undo: /);
});

/** The digest of a folder made in the run scope from `files`. */
function make(name, files) {
  const dir = path.join(scope.dir, name);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return buildDigest(dir);
}

/** A command step's arguments; a check step has none. */
function argsOf(step) {
  assert.ok("args" in step, `${step.name} runs no command`);
  return step.args;
}

test("two builds are the same only when every file and name matches", () => {
  const checked = make("checked", { "index.js": "a", "sub/x.sql": "b" });
  assert.equal(make("same", { "sub/x.sql": "b", "index.js": "a" }), checked);
  assert.notEqual(make("changed", { "index.js": "a!", "sub/x.sql": "b" }), checked);
  assert.notEqual(make("renamed", { "main.js": "a", "sub/x.sql": "b" }), checked);
  assert.notEqual(make("extra", { "index.js": "a", "sub/x.sql": "b", y: "" }), checked);
  // wrangler writes the output folder's own path into these, and uploads neither.
  assert.equal(
    make("notes", { "index.js": "a", "sub/x.sql": "b", "README.md": "/x", "index.js.map": "/x" }),
    checked,
  );
});

test("only a 200 from /healthz is healthy", () => {
  assert.equal(healthVerdict(200).healthy, true);
  for (const status of [503, 500, 404, null]) assert.equal(healthVerdict(status).healthy, false);
  assert.match(healthVerdict(503).message, /registry/);
});

test("a session token verifies with WebCrypto under the same secret, and not under another", async () => {
  const token = sessionToken("the-secret", { email: "owner@example.com", exp: 1 });
  const [body = "", signature = ""] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(body, "base64url").toString()), {
    email: "owner@example.com",
    exp: 1,
  });
  const verify = async (secret) => {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "HMAC",
      key,
      Buffer.from(signature, "base64url"),
      new TextEncoder().encode(body),
    );
  };
  assert.equal(await verify("the-secret"), true);
  assert.equal(await verify("another"), false);
});

test("the backup's registry tables are the ones the migrations make, products first", () => {
  const migrations = path.join(import.meta.dirname, "../apps/worker/migrations");
  const made = readdirSync(migrations)
    .filter((file) => file.endsWith(".sql"))
    .flatMap((file) => [
      ...readFileSync(path.join(migrations, file), "utf8").matchAll(/CREATE TABLE (\w+)/g),
    ])
    .map((match) => match[1]);
  assert.deepEqual([...REGISTRY_TABLES].toSorted(), made.toSorted());
  assert.equal(REGISTRY_TABLES[0], "projects");
});
