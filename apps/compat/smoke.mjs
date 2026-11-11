// @ts-check

import { dashboardApi } from "../../scripts/lib/dashboard-api.mjs";
import { deploymentOfSite, readSite } from "../../scripts/lib/site.mjs";
import { failedCount, formatCheck } from "./checks.mjs";
import { runBrowser } from "./clients/browser.mjs";
import { runNode } from "./clients/node.mjs";
import { PLAN } from "./plan.mjs";
import { waitFor } from "./store.mjs";

// The smoke test of a real deployment (docs/operations.md): it answers
// /healthz, refuses the dashboard's data without a session while serving its
// page, and the real posthog-node and posthog-js reach it, with a recording
// and heatmap points. The SDKs send to a product made for this run alone, and
// the run deletes it and starts its purge at the end, whatever happened, so a
// deployment keeps no test product and no test data. Each check prints one
// line; the run exits 0 only when all passed.
//
//   pnpm smoke <env>

/** The run's product: its name says what it is and when it was made. */
const productName = () => `Smoke test ${new Date().toISOString().slice(0, 19)}Z`;
const STORED_WAIT_MS = 90_000;

/** @typedef {import("./checks.mjs").Check} Check */

/**
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
  if (argv[0] !== "production") return stop("usage: pnpm smoke production");
  const site = readSite(process.env.CFX_SITE);
  if (!site.ok) return stop(site.error);
  const deployment = deploymentOfSite(site.value);
  const origin = deployment.origin;
  const api = dashboardApi(deployment);
  if (!api.ok) return stop(api.error);
  const call = api.call;

  /** @type {Check[]} */
  const checks = [];
  const health = await fetch(`${origin}/healthz`);
  checks.push(
    check(
      "platform-12",
      "/healthz answers 200",
      health.status === 200,
      `status ${String(health.status)}`,
    ),
  );

  const data = await fetch(`${origin}/api/projects`);
  checks.push(
    check(
      "platform-01",
      "the dashboard's data without a session is 401",
      data.status === 401,
      `status ${String(data.status)}`,
    ),
  );
  const page = await fetch(`${origin}/`);
  const html = await page.text();
  checks.push(
    check(
      "platform-50",
      "the dashboard's page is served without data",
      page.status === 200 && html.includes('id="root"') && html.includes("/app/assets/"),
      `status ${String(page.status)}`,
    ),
  );
  const status = await (await fetch(`${origin}/auth/status`)).json();
  const signedOut = isRecord(status) && status.signedIn === false;
  checks.push(
    check("platform-49", "signed out, /auth/status says so", signedOut, JSON.stringify(status)),
  );

  const name = productName();
  const product = await call("POST", "/api/projects", {
    name,
    settings: { recording_enabled: true, heatmaps_enabled: true },
  });
  const { id, token } = product;
  if (typeof id !== "string" || typeof token !== "string") {
    return stop("The smoke product has no id or token.");
  }
  try {
    await sendAndRead(call, origin, id, token, checks);
  } finally {
    checks.push(await removeProduct(call, id, name));
  }

  for (const each of checks) console.log(formatCheck(each));
  console.log(`\n${origin}, product ${id}`);
  if (failedCount(checks) > 0) process.exitCode = 1;
}

/**
 * The real posthog-node and posthog-js send to the run's product, and what
 * they sent is read back through the API.
 * @param {import("../../scripts/lib/dashboard-api.mjs").ApiCall} call
 * @param {string} origin
 * @param {string} id
 * @param {string} token
 * @param {Check[]} checks
 * @returns {Promise<void>}
 */
async function sendAndRead(call, origin, id, token, checks) {
  const since = new Date().toISOString();
  const node = await runNode({ apiHost: origin, token });
  checks.push(
    check(
      "intake-01",
      "posthog-node sends without an error",
      node.errors.length === 0,
      node.errors.join("; "),
    ),
  );
  const browser = await runBrowser({ apiHost: origin, token });
  checks.push(
    check(
      "intake-01",
      "posthog-js sends without an error",
      browser.errors.length === 0,
      browser.errors.join("; "),
    ),
  );
  /** @type {[string, string, boolean][]} */
  let parts = [];
  await waitFor(
    async () => {
      const now = await stored(call, id, since);
      parts = now.parts;
      return now;
    },
    { timeoutMs: STORED_WAIT_MS, pollMs: 2_000 },
  );
  for (const [behaviour, what, passed] of parts) {
    checks.push(check(behaviour, what, passed, passed ? "" : "not stored in time"));
  }
}

/**
 * Deletes the run's product and starts its purge (privacy-03, privacy-20),
 * then checks it is no longer listed.
 * @param {import("../../scripts/lib/dashboard-api.mjs").ApiCall} call
 * @param {string} id
 * @param {string} name
 * @returns {Promise<Check>}
 */
async function removeProduct(call, id, name) {
  try {
    await call("DELETE", `/api/projects/${id}`, { confirm: name });
    await call("POST", `/api/projects/${id}/purge`);
    const listed = await call("GET", "/api/projects");
    const projects = Array.isArray(listed.projects) ? listed.projects : [];
    const gone = !projects.some((each) => isRecord(each) && each.id === id);
    return check(
      "privacy-03",
      "the run's product is deleted and its purge started",
      gone,
      "still listed",
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return check("privacy-03", "the run's product is deleted and its purge started", false, detail);
  }
}

/**
 * Whether what the SDKs sent since `since` is stored: posthog-node's event,
 * a browser page view, a recording and heatmap points.
 * @param {import("../../scripts/lib/dashboard-api.mjs").ApiCall} call
 * @param {string} id
 * @param {string} since
 * @returns {Promise<{ ready: boolean, detail: string, parts: [string, string, boolean][] }>}
 */
async function stored(call, id, since) {
  const range = { kind: "between", from: since, to: new Date(Date.now() + 60_000).toISOString() };
  const named = async (/** @type {string} */ event) => {
    const answer = await call("POST", `/api/projects/${id}/query`, {
      kind: "events",
      range,
      limit: 1,
      includeBots: true,
      includeInternal: true,
      filter: {
        op: "eq",
        property: { of: "event", name: "$lib" },
        value: event === PLAN.node.event ? "posthog-node" : "web",
      },
    });
    const rows = isRecord(answer.result) ? answer.result.rows : undefined;
    return Array.isArray(rows) && rows.length > 0;
  };
  const recordings = await call("GET", `/api/projects/${id}/recordings`);
  const heatmap = await call("POST", `/api/projects/${id}/heatmap`, {
    range,
    path: PLAN.browser.pagePath,

    includeBots: true,
  });
  const bands = isRecord(heatmap.result) ? heatmap.result.bands : undefined;
  /** @type {[string, string, boolean][]} */
  const parts = [
    ["intake-01", "posthog-node's events are stored", await named(PLAN.node.event)],
    ["intake-01", "posthog-js's events are stored", await named("$pageview")],
    [
      "recordings-05",
      "the browser's session is recorded and listed",
      Array.isArray(recordings.recordings) && recordings.recordings.length > 0,
    ],
    [
      "heatmaps-01",
      "the browser's clicks are stored as heatmap points",
      Array.isArray(bands) && bands.length > 0,
    ],
  ];
  return { ready: parts.every(([, , passed]) => passed), detail: "", parts };
}

/**
 * @param {string} behaviour
 * @param {string} what
 * @param {boolean} passed
 * @param {string} detail
 * @returns {Check}
 */
function check(behaviour, what, passed, detail) {
  return { behaviour, what, passed, detail: passed ? "" : detail };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string} message
 * @returns {void}
 */
function stop(message) {
  console.error(message);
  process.exitCode = 1;
}

await main(process.argv.slice(2));
