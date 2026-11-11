// What may not sit in a tracked file of this public repository (D-32, c-f-x
// conventions section 4): an installation's account and resource ids, email
// addresses, workers.dev hosts and home folders, and in the template configs
// the keys only a deployment has. Real hostnames cannot be told from links by
// their shape, so they are found as the site file's own values, where the site
// file is at hand. Pure: callers pass the text in.

/** A 32-character hex id, such as an account or KV namespace id, standing alone. */
const HEX32 = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi;
const UUID =
  /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi;
/** An address, not a URL's user info: nothing word-like, ":" or "/" just before it. */
const EMAIL = /(?<![\w.%+:/-])[\w.%+-]+@((?:[a-z0-9-]+\.)+[a-z]{2,}|localhost)\b/gi;
const WORKERS_DEV = /\b((?:[a-z0-9-]+\.)+workers\.dev)\b/gi;
/** A macOS home folder. Linux's /home/<name>/ is left out: it reads like a URL route. */
const HOME = /(\/Users\/[^/\s"'`]+\/)/g;

/**
 * Domains kept for documentation and tests (RFC 2606, RFC 6761), which a
 * public file may use freely.
 * @param {string} domain
 * @returns {boolean}
 */
export function isExampleDomain(domain) {
  const d = domain.toLowerCase().replace(/\.$/, "");
  return (
    /(^|\.)example\.(com|net|org)$/.test(d) ||
    /(^|\.)(test|example|invalid|localhost)$/.test(d) ||
    d === "localhost"
  );
}

/**
 * Whether an id is a made-up placeholder: a run of six or more of one hex
 * digit, as in 0190f3b0-7c00-7000-8000-000000000000. Ids Cloudflare draws at
 * random almost never hold one (about 3 in 100,000 for 32 hex digits).
 * @param {string} id
 * @returns {boolean}
 */
export const isPlaceholderId = (id) => /([0-9a-f])\1{5}/i.test(id);

/** Addresses published on purpose: the family's security contact (SECURITY.md). */
const PUBLIC_ADDRESSES = new Set(["security@c-f-x.com"]);

/** Files whose text must stay as their authors wrote it: licence notices keep their addresses. */
const LICENCE_FILES = new Set(["THIRD_PARTY_NOTICES.md", "LICENSE"]);

/**
 * Each deployment value in one file's text, as `file:line holds ...`.
 * @param {string} file the repository path
 * @param {string} text
 * @returns {string[]}
 */
export function textViolations(file, text) {
  const found = [];
  for (const [index, line] of text.split("\n").entries()) {
    const at = `${file}:${String(index + 1)}`;
    for (const [id] of line.matchAll(UUID)) {
      if (!isPlaceholderId(id)) found.push(`${at} holds a resource id`);
    }
    for (const [id] of line.matchAll(HEX32)) {
      if (!isPlaceholderId(id)) found.push(`${at} holds an account or resource id`);
    }
    if (!LICENCE_FILES.has(file)) {
      for (const [address, domain = ""] of line.matchAll(EMAIL)) {
        if (!isExampleDomain(domain) && !PUBLIC_ADDRESSES.has(address.toLowerCase())) {
          found.push(`${at} holds the email address ${address}`);
        }
      }
    }
    for (const [, host = ""] of line.matchAll(WORKERS_DEV)) {
      if (!/(^|\.)example\.workers\.dev$/i.test(host)) {
        found.push(`${at} names the workers.dev host ${host}`);
      }
    }
    for (const [, home = ""] of line.matchAll(HOME))
      found.push(`${at} names a home folder (${home})`);
  }
  return found;
}

/** Keys that only a deployment's config holds; a template holds none. */
const DEPLOYMENT_KEYS = new Set(["account_id", "zone_id", "routes", "route"]);

/**
 * Where a template config holds a key only a deployment has, by path.
 * @param {unknown} config
 * @returns {string[]}
 */
export function deploymentKeyViolations(config) {
  const found = [];
  /** @param {unknown} node @param {string} prefix */
  const walk = (node, prefix) => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    for (const [key, child] of Object.entries(node)) {
      const at = prefix === "" ? key : `${prefix}.${key}`;
      if (DEPLOYMENT_KEYS.has(key)) found.push(at);
      else walk(child, at);
    }
  };
  walk(config, "");
  return found;
}

/**
 * The site file's hostnames, addresses and ids found in one file's text. Its
 * names (the Worker's, the database's) are kept in the open on purpose
 * (the owner's ruling, 2026-11-11), so only values of those three shapes count.
 * @param {import("./site.mjs").Site} site
 * @param {string} file
 * @param {string} text
 * @returns {string[]}
 */
export function siteValueViolations(site, file, text) {
  const values = [
    site.account_id,
    site.admin_email,
    site.worker.dashboard_host,
    ...site.worker.intake_hosts,
    site.worker.d1.id,
    site.watch.kv_id,
    site.watch.from,
    site.watch.to,
  ];
  const found = [];
  for (const [index, line] of text.split("\n").entries()) {
    const lower = line.toLowerCase();
    for (const value of values) {
      if (lower.includes(value.toLowerCase())) {
        found.push(`${file}:${String(index + 1)} holds the site file's ${value}`);
      }
    }
  }
  return found;
}
