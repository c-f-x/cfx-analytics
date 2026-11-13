import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "jsonc-parser";

// The site file (D-32, c-f-x conventions section 4). The repository holds
// templates only; the values of one installation (its account, hostnames,
// resource ids and addresses) live in a private checkout named by CFX_SITE,
// in the file SITE_FILE. The deploy joins them with the template config in
// its own scratch folder. This is the smallest loader this repository needs;
// @c-f-x/kit will publish the family's, and readSite is the one function to
// swap when it does.

export const SITE_FILE = "cfx-analytics.jsonc";

/**
 * @typedef {{
 *   account_id: string,
 *   admin_email: string,
 *   worker: {
 *     name: string,
 *     dashboard_host: string,
 *     intake_hosts: string[],
 *     d1: { name: string, id: string },
 *     r2_bucket: string,
 *   },
 *   watch: { name: string, kv_id: string, from: string, to: string },
 *   alert_addresses: string[],
 *   jurisdiction?: "eu",
 * }} Site
 */

const HEX32 = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const HOST = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Each value a site file holds, by its path, with the test it must pass and
 * what to say when it does not.
 * @type {[string, (value: unknown) => boolean, string][]}
 */
const FIELDS = [
  ["account_id", (v) => typeof v === "string" && HEX32.test(v), "a 32-character hex account id"],
  ["admin_email", (v) => typeof v === "string" && EMAIL.test(v), "an email address"],
  ["worker.name", (v) => typeof v === "string" && NAME.test(v), "a Worker name"],
  ["worker.dashboard_host", (v) => typeof v === "string" && HOST.test(v), "a bare hostname"],
  [
    "worker.intake_hosts",
    (v) => Array.isArray(v) && v.every((h) => typeof h === "string" && HOST.test(h)),
    "a list of bare hostnames",
  ],
  ["worker.d1.name", (v) => typeof v === "string" && NAME.test(v), "a D1 database name"],
  ["worker.d1.id", (v) => typeof v === "string" && UUID.test(v), "a D1 database id"],
  ["worker.r2_bucket", (v) => typeof v === "string" && NAME.test(v), "an R2 bucket name"],
  ["watch.name", (v) => typeof v === "string" && NAME.test(v), "a Worker name"],
  ["watch.kv_id", (v) => typeof v === "string" && HEX32.test(v), "a KV namespace id"],
  ["watch.from", (v) => typeof v === "string" && EMAIL.test(v), "an email address"],
  ["watch.to", (v) => typeof v === "string" && EMAIL.test(v), "an email address"],
  [
    "alert_addresses",
    (v) =>
      Array.isArray(v) && v.length > 0 && v.every((a) => typeof a === "string" && EMAIL.test(a)),
    "a list of at least one verified email address",
  ],
];

// Where the installation keeps its data (cfx-kit D-11, D-38): "eu", or left
// out for Cloudflare's default placement. It is optional, so it is not in FIELDS.
const JURISDICTION = "jurisdiction";

/** @param {unknown} root @param {string} at @returns {unknown} */
const valueAt = (root, at) =>
  at.split(".").reduce((node, key) => (isRecord(node) ? node[key] : undefined), root);

/**
 * A parsed site file checked whole: every value present and of its shape, and
 * no key it does not know, so a misspelt key is not silently ignored.
 * @param {unknown} raw
 * @returns {{ ok: true, value: Site } | { ok: false, errors: string[] }}
 */
export function siteOf(raw) {
  if (!isRecord(raw)) return { ok: false, errors: ["the site file is not a JSON object"] };
  const errors = [];
  const known = new Set([
    JURISDICTION,
    ...FIELDS.flatMap(([at]) =>
      at.split(".").map((_, i, parts) => parts.slice(0, i + 1).join(".")),
    ),
  ]);
  /** @param {Record<string, unknown>} node @param {string} prefix */
  const unknownKeys = (node, prefix) => {
    for (const [key, child] of Object.entries(node)) {
      const at = prefix === "" ? key : `${prefix}.${key}`;
      if (!known.has(at)) errors.push(`${at} is not a known key`);
      else if (isRecord(child)) unknownKeys(child, at);
    }
  };
  for (const [at, valid, shape] of FIELDS) {
    if (!valid(valueAt(raw, at))) errors.push(`${at} is not ${shape}`);
  }
  if (JURISDICTION in raw && raw[JURISDICTION] !== "eu") {
    errors.push(`${JURISDICTION} is "eu", or left out for Cloudflare's default placement`);
  }
  unknownKeys(raw, "");
  errors.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (errors.length > 0) return { ok: false, errors };
  // Every value was checked above, so each read below finds its shape.
  /** @param {string} at */
  const text = (at) => {
    const value = valueAt(raw, at);
    return typeof value === "string" ? value : "";
  };
  const hosts = valueAt(raw, "worker.intake_hosts");
  return {
    ok: true,
    value: {
      account_id: text("account_id"),
      admin_email: text("admin_email"),
      worker: {
        name: text("worker.name"),
        dashboard_host: text("worker.dashboard_host"),
        intake_hosts: Array.isArray(hosts) ? hosts.filter((h) => typeof h === "string") : [],
        d1: { name: text("worker.d1.name"), id: text("worker.d1.id") },
        r2_bucket: text("worker.r2_bucket"),
      },
      watch: {
        name: text("watch.name"),
        kv_id: text("watch.kv_id"),
        from: text("watch.from"),
        to: text("watch.to"),
      },
      alert_addresses: (() => {
        const list = valueAt(raw, "alert_addresses");
        return Array.isArray(list) ? list.filter((a) => typeof a === "string") : [];
      })(),
      ...(raw[JURISDICTION] === "eu" ? { jurisdiction: "eu" } : {}),
    },
  };
}

/**
 * The site file of the checkout at `cfxSite` (CFX_SITE), read and checked.
 * @param {string | undefined} cfxSite
 * @returns {{ ok: true, value: Site } | { ok: false, error: string }}
 */
export function readSite(cfxSite) {
  if (cfxSite === undefined || cfxSite === "") {
    return {
      ok: false,
      error: `CFX_SITE is not set. Set it to a checkout of the private site repository, which holds ${SITE_FILE} (docs/operations.md).`,
    };
  }
  const file = path.join(cfxSite, SITE_FILE);
  if (!existsSync(file)) return { ok: false, error: `${file} does not exist.` };
  /** @type {import("jsonc-parser").ParseError[]} */
  const problems = [];
  const raw = parse(readFileSync(file, "utf8"), problems, { allowTrailingComma: true });
  if (problems.length > 0) return { ok: false, error: `${file} is not valid JSONC.` };
  const site = siteOf(raw);
  if (!site.ok) return { ok: false, error: `${file}:\n- ${site.errors.join("\n- ")}` };
  return site;
}

/**
 * @typedef {{
 *   env: string,
 *   worker: string,
 *   accountId: string,
 *   database: string,
 *   bucket: string,
 *   origin: string,
 *   adminEmail: string,
 *   jurisdiction?: "eu",
 * }} Deployment
 */

/**
 * The names the operations commands need. There is one deployment, named
 * production; its origin is the dashboard's host (D-16, D-31).
 * @param {Site} site
 * @returns {Deployment}
 */
export function deploymentOfSite(site) {
  return {
    env: "production",
    worker: site.worker.name,
    accountId: site.account_id,
    database: site.worker.d1.name,
    bucket: site.worker.r2_bucket,
    origin: `https://${site.worker.dashboard_host}`,
    adminEmail: site.admin_email,
    ...(site.jurisdiction === undefined ? {} : { jurisdiction: site.jurisdiction }),
  };
}

/**
 * A template config with its relative paths made absolute, so the joined
 * config works from any folder, and without its editor schema.
 * @param {Record<string, any>} template
 * @param {string} dir the template's folder
 * @returns {Record<string, any>}
 */
function placed(template, dir) {
  const { $schema: _schema, ...rest } = structuredClone(template);
  if (typeof rest.main === "string") rest.main = path.join(dir, rest.main);
  if (rest.assets?.directory !== undefined)
    rest.assets.directory = path.join(dir, rest.assets.directory);
  for (const db of rest.d1_databases ?? []) {
    if (typeof db.migrations_dir === "string")
      db.migrations_dir = path.join(dir, db.migrations_dir);
  }
  return rest;
}

/**
 * The Worker's config for a deploy: the template, which holds local
 * development's values, plus `env.production` built from the site file. The
 * bindings it does not name are the template's.
 * @param {Record<string, any>} template
 * @param {Site} site
 * @param {string} dir the template's folder
 * @returns {Record<string, any>}
 */
export function joinWorker(template, site, dir) {
  const base = placed(template, dir);
  const migrationsDir = base.d1_databases?.[0]?.migrations_dir;
  const hosts = [site.worker.dashboard_host, ...site.worker.intake_hosts];
  return {
    ...base,
    env: {
      production: {
        name: site.worker.name,
        account_id: site.account_id,
        workers_dev: false,
        routes: hosts.map((pattern) => ({ pattern, custom_domain: true })),
        d1_databases: [
          {
            binding: "REGISTRY",
            database_name: site.worker.d1.name,
            database_id: site.worker.d1.id,
            migrations_dir: migrationsDir,
          },
        ],
        durable_objects: base.durable_objects,
        migrations: base.migrations,
        // Wrangler does not inherit the required secrets into an environment.
        ...(base.secrets === undefined ? {} : { secrets: base.secrets }),
        r2_buckets: [
          {
            binding: "RECORDINGS",
            bucket_name: site.worker.r2_bucket,
            ...(site.jurisdiction === undefined ? {} : { jurisdiction: site.jurisdiction }),
          },
        ],
        // The weekly email (#23, D-40): from the watcher's verified sender, on
        // the template's cron. Its recipients are the alert addresses and the
        // ones added in the dashboard that Cloudflare marks confirmed, which
        // the Worker checks before every send (alerts-13).
        send_email: [{ name: "MAIL" }],
        triggers: base.triggers,
        vars: {
          MAIL_FROM: site.watch.from,
          ALERT_ADDRESSES: JSON.stringify(site.alert_addresses),
          CLOUDFLARE_ACCOUNT_ID: site.account_id,
          // The one place the Worker learns where its stores are (platform-52).
          ...(site.jurisdiction === undefined ? {} : { STORE_JURISDICTION: site.jurisdiction }),
        },
        assets: base.assets,
      },
    },
  };
}

/**
 * The watcher's config for a deploy (D-30): the template's schedule and code,
 * with the account, the address it asks and the addresses it mails from the
 * site file.
 * @param {Record<string, any>} template
 * @param {Site} site
 * @param {string} dir the template's folder
 * @returns {Record<string, any>}
 */
export function joinWatch(template, site, dir) {
  return {
    ...placed(template, dir),
    name: site.watch.name,
    account_id: site.account_id,
    workers_dev: false,
    vars: {
      TARGET: `https://${site.worker.dashboard_host}/healthz`,
      FROM: site.watch.from,
      TO: site.watch.to,
    },
    kv_namespaces: [{ binding: "STATE", id: site.watch.kv_id }],
    send_email: [{ name: "ALERT", destination_address: site.watch.to }],
  };
}
