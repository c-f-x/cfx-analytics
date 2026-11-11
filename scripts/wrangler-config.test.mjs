import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  deploymentKeyViolations,
  siteValueViolations,
  textViolations,
} from "./lib/deployment-values.mjs";
import { readSite } from "./lib/site.mjs";
import { ROOT } from "./lib/source.mjs";
import { configBlocks, readWranglerConfig } from "./lib/wrangler-config.mjs";

const config = readWranglerConfig();
const watchConfig = readWranglerConfig(new URL("../apps/watch/wrangler.jsonc", import.meta.url));

// docs/engineering.md: no secrets or deployment values in wrangler.jsonc.
// Settings live in the D1 registry and secrets are set with `wrangler secret
// put`, so no block declares `vars`, and no value looks like a credential.
const CREDENTIAL = /(secret|token|password|api[_-]?key|private[_-]?key)/i;

function valuesThatBelongElsewhere(cfg) {
  const found = [];
  for (const [name, block] of configBlocks(cfg)) {
    if (block.vars !== undefined) found.push(`${name}: vars`);
  }
  const walk = (value, at) => {
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, at ? `${at}.${k}` : k);
    } else if (typeof value === "string" && CREDENTIAL.test(at)) {
      found.push(at);
    }
  };
  walk(cfg, "");
  return found;
}

test("the secrets check catches values and secrets put in the config", () => {
  const bad = { vars: { BASE: "x" }, env: { prod: { vars: {}, ACCESS_TOKEN: "abc" } } };
  assert.deepEqual(valuesThatBelongElsewhere(bad), [
    "top level: vars",
    "env.prod: vars",
    "env.prod.ACCESS_TOKEN",
  ]);
});

test("wrangler.jsonc holds no secrets or deployment values", () => {
  assert.deepEqual(valuesThatBelongElsewhere(config), []);
  assert.deepEqual(valuesThatBelongElsewhere(watchConfig), []);
});

// docs/architecture.md: recordings stay in the EU. Every R2 bucket, in every
// block, is bound in the "eu" jurisdiction.
function bucketsOutsideEu(cfg) {
  const found = [];
  for (const [name, block] of configBlocks(cfg)) {
    for (const bucket of block.r2_buckets ?? []) {
      if (bucket.jurisdiction !== "eu") found.push(`${name}: ${bucket.binding}`);
    }
  }
  return found;
}

test("the EU check catches a bucket bound outside the EU", () => {
  const bad = {
    r2_buckets: [{ binding: "RECORDINGS", bucket_name: "a", jurisdiction: "eu" }],
    env: { prod: { r2_buckets: [{ binding: "RECORDINGS", bucket_name: "b" }] } },
  };
  assert.deepEqual(bucketsOutsideEu(bad), ["env.prod: RECORDINGS"]);
});

test("every R2 bucket is bound in the EU jurisdiction", () => {
  assert.deepEqual(bucketsOutsideEu(config), []);
});

test("development secrets in .dev.vars stay out of git", () => {
  const ignored = spawnSync("git", ["check-ignore", "-q", "apps/worker/.dev.vars"], {
    cwd: new URL("..", import.meta.url),
  });
  assert.equal(ignored.status, 0);
});

// D-32, c-f-x conventions section 4: the repository holds templates only. An
// installation's account, hostnames, resource ids and addresses live in the
// private site file, so no tracked file may hold one.

test("the template check refuses the keys only a deployment has", () => {
  const bad = {
    account_id: "x",
    env: { production: { routes: [{ pattern: "a.example.com" }], route: "b.example.com" } },
  };
  assert.deepEqual(deploymentKeyViolations(bad), [
    "account_id",
    "env.production.routes",
    "env.production.route",
  ]);
});

test("both templates hold no key only a deployment has", () => {
  assert.deepEqual(deploymentKeyViolations(config), []);
  assert.deepEqual(deploymentKeyViolations(watchConfig), []);
});

// The samples are joined from pieces, so this file's own text holds none of
// what it checks for, and the repository-wide check can read it too.
const at = "@";
const ID32 = ["a1b2c3d4e5f6", "0718293a4b5c6d7e8f90"].join("");
const ID36 = ["3f2a9c4e", "8b1d", "4e6f", "9a2c", "5d7e1b3f8a40"].join("-");
const REAL = ["realcompany", "no"].join(".");
const WORKERS_DEV = ["workers", "dev"].join(".");
const USERS = ["", "Users"].join("/");

test("the text check flags ids, addresses, workers.dev hosts and home folders", () => {
  const sample = [
    `account ${ID32} here`,
    `d1 ${ID36}`,
    `mail someone${at}${REAL}`,
    `see https://tool.someone.${WORKERS_DEV}/x`,
    `path ${USERS}/someone/project/file`,
  ].join("\n");
  assert.deepEqual(textViolations("notes.md", sample), [
    "notes.md:1 holds an account or resource id",
    "notes.md:2 holds a resource id",
    `notes.md:3 holds the email address someone${at}${REAL}`,
    `notes.md:4 names the workers.dev host tool.someone.${WORKERS_DEV}`,
    `notes.md:5 names a home folder (${USERS}/someone/)`,
  ]);
});

test("the text check lets documentation examples and placeholder ids pass", () => {
  const sample = [
    "owner@example.com, admin@dashboard.test, a@b.example, x@y.invalid, me@localhost",
    "0190f3b0-7c00-7000-8000-000000000000 and 11111111-1111-4111-8111-111111111111",
    "019302a17c0070008000000000000001, and a sha256 of 64 hex characters:",
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "https://user:secret@www.reddit.com/r/x is a URL, not an address",
    "https://analytics.example.workers.dev, /home/api/ is a route, pnpm@12.14.0 a version",
  ].join("\n");
  assert.deepEqual(textViolations("notes.md", sample), []);
  // The family's public security address is published on purpose; no other
  // address at its domain is.
  assert.deepEqual(textViolations("SECURITY.md", `Write to security${at}c-f-x.com`), []);
  assert.deepEqual(textViolations("notes.md", `Write to someone${at}c-f-x.com`), [
    `notes.md:1 holds the email address someone${at}c-f-x.com`,
  ]);
  // Licence texts keep their authors' addresses, as their licences require.
  const notice = `Copyright 2013 Someone someone${at}${REAL}`;
  assert.deepEqual(textViolations("THIRD_PARTY_NOTICES.md", notice), []);
});

/** Every tracked text file, read from the working tree. */
function trackedTexts() {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((file) => file !== "" && file !== "pnpm-lock.yaml");
  return files.flatMap((file) => {
    const bytes = readFileSync(path.join(ROOT, file));
    // A NUL byte marks a binary file, as git does.
    return bytes.includes(0) ? [] : [{ file, text: bytes.toString("utf8") }];
  });
}

test("no tracked file holds an id, an address, a workers.dev host or a home folder", () => {
  assert.deepEqual(
    trackedTexts().flatMap(({ file, text }) => textViolations(file, text)),
    [],
  );
});

test("the site check flags a site file's hostnames, addresses and ids in a file", () => {
  const site = {
    account_id: ID32,
    admin_email: `owner${at}${REAL}`,
    worker: {
      name: "analytics",
      dashboard_host: `stats.${REAL}`,
      intake_hosts: [`e.shop.${REAL}`],
      d1: { name: "analytics-registry", id: ID36 },
      r2_bucket: "analytics-recordings",
    },
    watch: { name: "w", kv_id: "b".repeat(32), from: `a${at}${REAL}`, to: `owner${at}${REAL}` },
  };
  assert.deepEqual(
    siteValueViolations(site, "docs/x.md", `the dashboard is at stats.${REAL}\nnothing here`),
    [`docs/x.md:1 holds the site file's stats.${REAL}`],
  );
});

// The site file is private, so this runs where it is: on the owner's Mac,
// where `pnpm ops` reads it too. CI, which cannot read it, runs the checks above.
test("no tracked file holds a value of the site file in CFX_SITE", (t) => {
  const site = readSite(process.env.CFX_SITE);
  if (!site.ok) {
    t.skip("CFX_SITE names no site file here");
    return;
  }
  assert.deepEqual(
    trackedTexts().flatMap(({ file, text }) => siteValueViolations(site.value, file, text)),
    [],
  );
});
