import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { parse } from "jsonc-parser";
import { openRunScope } from "./lib/run-scope.mjs";
import {
  deploymentOfSite,
  joinWatch,
  joinWorker,
  readSite,
  SITE_FILE,
  siteOf,
} from "./lib/site.mjs";

// The site file (D-32, c-f-x conventions section 4): the deployment's values
// live outside the repository, and the deploy joins them with the template
// config. Every value here is a documentation example.

let scope;

before(() => {
  scope = openRunScope({ installExitHandlers: true });
});

after(async () => {
  const { leftovers } = await scope.close();
  assert.deepEqual(leftovers, []);
});

const SITE = {
  account_id: "0".repeat(32),
  admin_email: "owner@example.com",
  worker: {
    name: "analytics",
    dashboard_host: "analytics.example.com",
    intake_hosts: ["e.shop.example.com"],
    d1: { name: "analytics-registry", id: "00000000-0000-4000-8000-000000000000" },
    r2_bucket: "analytics-recordings",
  },
  watch: {
    name: "analytics-watch",
    kv_id: "1".repeat(32),
    from: "alerts@example.com",
    to: "owner@example.com",
  },
};

const TEMPLATE = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: "cfanalytics-local",
  main: "src/index.ts",
  compatibility_date: "2026-10-01",
  rules: [{ type: "Text", globs: ["**/*.sql"], fallthrough: true }],
  d1_databases: [
    {
      binding: "REGISTRY",
      database_name: "local",
      database_id: "local",
      migrations_dir: "migrations",
    },
  ],
  durable_objects: { bindings: [{ name: "PROJECT_STORE", class_name: "ProjectStore" }] },
  migrations: [{ tag: "v1", new_sqlite_classes: ["ProjectStore"] }],
  r2_buckets: [{ binding: "RECORDINGS", bucket_name: "local", jurisdiction: "eu" }],
  assets: { directory: "assets", binding: "ASSETS", run_worker_first: true },
};

test("a whole site file is read as the deployment's values", () => {
  const read = siteOf(SITE);
  assert.ok(read.ok);
  assert.deepEqual(deploymentOfSite(read.value), {
    env: "production",
    worker: "analytics",
    accountId: "0".repeat(32),
    database: "analytics-registry",
    bucket: "analytics-recordings",
    origin: "https://analytics.example.com",
    adminEmail: "owner@example.com",
  });
});

test("a site file missing or misspelling a value names each problem", () => {
  const broken = {
    ...SITE,
    account_id: "not-an-id",
    admin_email: "nobody",
    extra: true,
    worker: { ...SITE.worker, dashboard_host: "https://analytics.example.com", intake_hosts: "x" },
  };
  const read = siteOf(broken);
  assert.equal(read.ok, false);
  assert.deepEqual(read.errors, [
    "account_id is not a 32-character hex account id",
    "admin_email is not an email address",
    "extra is not a known key",
    "worker.dashboard_host is not a bare hostname",
    "worker.intake_hosts is not a list of bare hostnames",
  ]);
  assert.deepEqual(siteOf(null), { ok: false, errors: ["the site file is not a JSON object"] });
});

test("the worker's config is the template's, with production built from the site file", () => {
  const read = siteOf(SITE);
  assert.ok(read.ok);
  const joined = joinWorker(TEMPLATE, read.value, "/repo/apps/worker");
  assert.equal(joined.$schema, undefined);
  assert.equal(joined.main, "/repo/apps/worker/src/index.ts");
  assert.equal(joined.assets.directory, "/repo/apps/worker/assets");
  assert.equal(joined.d1_databases[0].migrations_dir, "/repo/apps/worker/migrations");
  assert.deepEqual(joined.env.production, {
    name: "analytics",
    account_id: "0".repeat(32),
    workers_dev: false,
    routes: [
      { pattern: "analytics.example.com", custom_domain: true },
      { pattern: "e.shop.example.com", custom_domain: true },
    ],
    d1_databases: [
      {
        binding: "REGISTRY",
        database_name: "analytics-registry",
        database_id: "00000000-0000-4000-8000-000000000000",
        migrations_dir: "/repo/apps/worker/migrations",
      },
    ],
    durable_objects: TEMPLATE.durable_objects,
    migrations: TEMPLATE.migrations,
    r2_buckets: [{ binding: "RECORDINGS", bucket_name: "analytics-recordings" }],
    assets: { directory: "/repo/apps/worker/assets", binding: "ASSETS", run_worker_first: true },
  });
  // The template itself is left as it was.
  assert.equal(TEMPLATE.main, "src/index.ts");
});

test("ops-04 · a site in the eu binds its bucket there and tells the Worker where its stores are", () => {
  const read = siteOf({ ...SITE, jurisdiction: "eu" });
  assert.ok(read.ok);
  const production = joinWorker(TEMPLATE, read.value, "/repo/apps/worker").env.production;
  assert.deepEqual(production.r2_buckets, [
    { binding: "RECORDINGS", bucket_name: "analytics-recordings", jurisdiction: "eu" },
  ]);
  assert.deepEqual(production.vars, { STORE_JURISDICTION: "eu" });
  // With no region, the Worker gets no variable, and its stores take the default placement.
  const plain = siteOf(SITE);
  assert.ok(plain.ok);
  assert.equal(
    joinWorker(TEMPLATE, plain.value, "/repo/apps/worker").env.production.vars,
    undefined,
  );
});

test("ops-04 · a region other than eu is refused when the site file is read", () => {
  for (const jurisdiction of ["us", "EU", "", "fedramp"]) {
    const read = siteOf({ ...SITE, jurisdiction });
    assert.equal(read.ok, false);
    assert.deepEqual(read.ok ? [] : read.errors, [
      'jurisdiction is "eu", or left out for Cloudflare\'s default placement',
    ]);
  }
});

test("the watcher's config takes its account, addresses and store from the site file", () => {
  const read = siteOf(SITE);
  assert.ok(read.ok);
  const joined = joinWatch(
    { name: "watch-local", main: "src/index.ts", triggers: { crons: ["*/5 * * * *"] } },
    read.value,
    "/repo/apps/watch",
  );
  assert.deepEqual(joined, {
    name: "analytics-watch",
    main: "/repo/apps/watch/src/index.ts",
    triggers: { crons: ["*/5 * * * *"] },
    account_id: "0".repeat(32),
    workers_dev: false,
    vars: {
      TARGET: "https://analytics.example.com/healthz",
      FROM: "alerts@example.com",
      TO: "owner@example.com",
    },
    kv_namespaces: [{ binding: "STATE", id: "1".repeat(32) }],
    send_email: [{ name: "ALERT", destination_address: "owner@example.com" }],
  });
});

/** The error of a failed read; a read that succeeded fails the test. */
function errorOf(read) {
  assert.equal(read.ok, false);
  return read.ok ? "" : read.error;
}

test("the site file is read from the CFX_SITE checkout, and its absence says what to set", () => {
  const dir = path.join(scope.dir, "site");
  mkdirSync(dir);
  assert.match(errorOf(readSite(undefined)), /CFX_SITE/);
  assert.match(errorOf(readSite(dir)), new RegExp(SITE_FILE));
  writeFileSync(
    path.join(dir, SITE_FILE),
    `// the owner's values\n${JSON.stringify(SITE, null, 2)}\n`,
  );
  const read = readSite(dir);
  assert.ok(read.ok);
  assert.equal(read.value.worker.name, "analytics");
});

test("the site file is named after the tool, as the family's conventions say", () => {
  // c-f-x conventions, section 4: one file per tool, `<tool>.jsonc`. The
  // tool's name is the root package's (D-34).
  const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(SITE_FILE, `${root.name}.jsonc`);
  assert.equal(root.name, "cfx-analytics");
});

test("the production block lists the Worker's required secrets, which Wrangler does not inherit", () => {
  const read = siteOf(SITE);
  assert.ok(read.ok);
  const template = { ...TEMPLATE, secrets: { required: ["AUTH_SECRET", "ADMIN_EMAIL"] } };
  const joined = joinWorker(template, read.value, "/repo/apps/worker");
  assert.deepEqual(joined.env.production.secrets, { required: ["AUTH_SECRET", "ADMIN_EMAIL"] });
  // And the real template lists exactly the secrets the Worker's Env declares.
  const real = parse(
    readFileSync(new URL("../apps/worker/wrangler.jsonc", import.meta.url), "utf8"),
  );
  assert.deepEqual(real.secrets?.required, [
    "AUTH_SECRET",
    "ADMIN_EMAIL",
    "DASHBOARD_ORIGIN",
    "CLOUDFLARE_CLIENT_ID",
    "CLOUDFLARE_CLIENT_SECRET",
  ]);
});
