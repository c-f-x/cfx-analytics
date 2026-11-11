// @ts-check

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { IMPORT_LINES_MAX } from "../packages/shared/src/limits.ts";
import { EXPORT_TABLES, IMPORT_ORDER } from "../packages/shared/src/privacy.ts";
import { dashboardApi, keychainService } from "./lib/dashboard-api.mjs";
import { buildDigest, deploySteps, healthVerdict, planText, REGISTRY_TABLES } from "./lib/ops.mjs";
import { openRunScope } from "./lib/run-scope.mjs";
import { deploymentOfSite, joinWatch, joinWorker, readSite } from "./lib/site.mjs";
import { ROOT } from "./lib/source.mjs";
import { readWranglerConfig } from "./lib/wrangler-config.mjs";

// The operations, one command each (docs/operations.md). Every command that
// changes Cloudflare prints its plan, with the undo of each step, and runs
// only with --go. Each stops at its first failing step and says which.
//
//   pnpm ops deploy <env> [--go]
//   pnpm ops secrets <env> [--go]
//   pnpm ops health <env> [--notify]
//   pnpm ops watch [--go]
//   pnpm ops backup <env> <folder>
//   pnpm ops export <env> <project id> <folder>
//   pnpm ops wrangler <env> -- <wrangler arguments>
//
// The deployment's values come from the site file in the checkout CFX_SITE
// names (D-32). Each command joins it with the template config into its own
// scratch folder, which is removed when the command ends.

const USAGE = `usage:
  pnpm ops deploy <env> [--go]                 check, build once, migrate, deploy that build, check /healthz
  pnpm ops secrets <env> [--go]                set AUTH_SECRET (kept in the keychain), ADMIN_EMAIL, DASHBOARD_ORIGIN
  pnpm ops health <env> [--notify]             ask /healthz; --notify shows a macOS notification when it fails
  pnpm ops watch [--go]                        deploy the watcher, which emails the owner when production fails
  pnpm ops backup <env> <folder>               the registry, every product's tables and the recordings' objects
  pnpm ops restore <env> <folder> [--go]       a backup into a deployment that holds no product yet
  pnpm ops export <env> <project id> <folder>  one product's tables as NDJSON
  pnpm ops wrangler <env> -- <arguments>       wrangler against the deployment, such as an undo the plans print

<env> is production, the one deployment the site file in $CFX_SITE describes.`;

const HEALTH_TIMEOUT_MS = 15_000;

/**
 * @typedef {import("./lib/site.mjs").Deployment & {
 *   config: string,
 *   site: import("./lib/site.mjs").Site,
 * }} Deployment
 */

/** The run's scratch folder: the joined configs and a deploy's bundles live here and go with it. */
const scope = openRunScope({ installExitHandlers: true });

const WORKER_DIR = path.join(ROOT, "apps/worker");
const WATCH_DIR = path.join(ROOT, "apps/watch");

/**
 * The deployment named `env`, from the site file, with the Worker's config
 * joined into this run's folder; or an exit with the reason.
 * @param {string | undefined} env
 * @returns {Deployment}
 */
function deploymentNamed(env) {
  if (env === undefined || env === "") fail(USAGE, 2);
  const site = readSite(process.env.CFX_SITE);
  if (!site.ok) fail(site.error);
  if (env !== "production")
    fail(`The site file describes one deployment, production, not "${env}".`);
  const config = path.join(scope.dir, "wrangler.jsonc");
  writeFileSync(
    config,
    JSON.stringify(joinWorker(readWranglerConfig(), site.value, WORKER_DIR), null, 2),
  );
  return { ...deploymentOfSite(site.value), config, site: site.value };
}

/**
 * @param {string} message
 * @param {number} [code]
 * @returns {never}
 */
function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

/** The environment every wrangler call runs in: the deployment's account, logs in /tmp. */
function wranglerEnv(/** @type {Deployment} */ deployment) {
  return { ...process.env, CLOUDFLARE_ACCOUNT_ID: deployment.accountId };
}

/**
 * Runs wrangler and answers its exit code and output; the output is also
 * shown, unless `quiet`.
 * @param {Deployment} deployment
 * @param {string[]} args
 * @param {{ quiet?: boolean, input?: string }} [options]
 * @returns {{ code: number, output: string }}
 */
function wrangler(deployment, args, options = {}) {
  const result = spawnSync(
    "pnpm",
    ["--filter", "@cfanalytics/worker", "exec", "wrangler", ...args, "--config", deployment.config],
    {
      cwd: ROOT,
      env: wranglerEnv(deployment),
      encoding: "utf8",
      input: options.input,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (options.quiet !== true) process.stdout.write(output);
  return { code: result.status ?? 1, output };
}

/**
 * The one JSON value in wrangler's --json output, or null.
 * @param {string} output
 * @returns {unknown}
 */
function jsonIn(output) {
  const start = output.search(/[[{]/);
  if (start < 0) return null;
  try {
    return JSON.parse(output.slice(start));
  } catch {
    return null;
  }
}

// ── deploy ──────────────────────────────────────────────────────────────────

/**
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function deploy(args) {
  const deployment = deploymentNamed(args[0]);
  const go = args.includes("--go");
  if (!go && !isClean())
    console.log("Note: the working tree has changes; --go refuses to deploy them.\n");
  if (go && !isClean())
    fail("The working tree has uncommitted changes. Deploy a commit, so the deploy can be traced.");

  // The undo points are read before anything changes, and they only read.
  const info = wrangler(deployment, ["d1", "time-travel", "info", deployment.database, "--json"], {
    quiet: true,
  });
  const parsedInfo = jsonIn(info.output);
  const bookmarkValue = isRecord(parsedInfo) ? parsedInfo.bookmark : undefined;
  if (info.code !== 0 || typeof bookmarkValue !== "string") {
    fail(`Could not read the registry's time-travel bookmark:\n${info.output}`);
  }
  const listed = wrangler(deployment, ["deployments", "list", "--env", deployment.env, "--json"], {
    quiet: true,
  });
  const previousVersion = latestVersion(listed.code === 0 ? jsonIn(listed.output) : null);

  const checkedDir = path.join(scope.dir, "checked");
  const shippedDir = path.join(scope.dir, "shipped");
  const steps = deploySteps({
    deployment,
    config: deployment.config,
    bookmark: bookmarkValue,
    previousVersion,
    checkedDir,
    shippedDir,
  });
  console.log(`Deploy ${deployment.worker} (env "${deployment.env}") from ${commit()}:\n`);
  console.log(planText(steps));
  if (!go) {
    console.log("\nNothing ran. Run again with --go to deploy.");
    return;
  }

  const url = deployment.origin;
  /** @type {{ index: number, step: import("./lib/ops.mjs").DeployStep } | null} */
  let failed = null;
  for (const [index, step] of steps.entries()) {
    console.log(`\n▶ ${String(index + 1)}. ${step.name}`);
    let code;
    if ("command" in step) {
      // oxlint-disable-next-line no-await-in-loop -- each step must finish before the next starts
      const run = await runShown(step.command, step.args, wranglerEnv(deployment));
      code = run.code;
    } else if (step.check === "same build") {
      code = buildDigest(checkedDir) === buildDigest(shippedDir) ? 0 : 1;
      if (code !== 0) console.error("The shipped bundle differs from the checked one.");
    } else {
      // A new custom domain answers once its certificate is issued, so the
      // check waits for a healthy answer, up to a deadline that catches a fault.
      // oxlint-disable-next-line no-await-in-loop -- the health check is the last step
      const verdict = await healthyWithin(url, DEPLOY_HEALTH_DEADLINE_MS);
      console.log(verdict.message);
      code = verdict.healthy ? 0 : 1;
    }
    if (code !== 0) {
      failed = { index, step };
      break;
    }
  }
  if (failed !== null) {
    console.error(
      `\nStep ${String(failed.index + 1)} ("${failed.step.name}") failed. Undo the steps before it that changed Cloudflare, newest first:`,
    );
    for (const step of steps.slice(0, failed.index + 1).toReversed())
      console.error(`- ${step.name}: ${step.undo}`);
    process.exit(1);
  }
  console.log(`\nDeployed ${commit()} to ${url ?? deployment.worker}.`);
}

/**
 * The newest version id in `wrangler deployments list --json`, or null for a
 * Worker never deployed.
 * @param {unknown} listed
 * @returns {string | null}
 */
function latestVersion(listed) {
  if (!Array.isArray(listed) || listed.length === 0) return null;
  const newest = listed.at(-1);
  const id = newest?.versions?.[0]?.version_id;
  return typeof id === "string" ? id : null;
}

/**
 * Runs a command with its output shown as it comes, and answers its exit code and output.
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ code: number, output: string }>}
 */
function runShown(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ["inherit", "pipe", "pipe"] });
    let output = "";
    const show = (/** @type {Buffer} */ chunk, /** @type {NodeJS.WriteStream} */ to) => {
      output += String(chunk);
      to.write(chunk);
    };
    child.stdout.on("data", (chunk) => show(chunk, process.stdout));
    child.stderr.on("data", (chunk) => show(chunk, process.stderr));
    child.once("error", () => resolve({ code: 127, output }));
    child.once("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

function isClean() {
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
  return status.status === 0 && status.stdout.trim() === "";
}

function commit() {
  return spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).stdout.trim();
}

// ── secrets ─────────────────────────────────────────────────────────────────

/**
 * Sets the deployment's secrets. AUTH_SECRET is drawn here, kept in the
 * macOS keychain for the backup command, and piped to wrangler; it is never
 * printed or put on a command line.
 * @param {string[]} args
 * @returns {void}
 */
function secrets(args) {
  const deployment = deploymentNamed(args[0]);
  const origin = deployment.origin;
  const service = keychainService(deployment);
  const plan = [
    `1. AUTH_SECRET: 32 random bytes, kept in the keychain (service ${service}, account AUTH_SECRET) and put with wrangler secret put. A new one signs everyone out.\n   undo: wrangler secret delete AUTH_SECRET --env ${deployment.env}, and security delete-generic-password -s ${service} -a AUTH_SECRET`,
    `2. ADMIN_EMAIL: ${deployment.adminEmail}\n   undo: wrangler secret delete ADMIN_EMAIL --env ${deployment.env}`,
    `3. DASHBOARD_ORIGIN: ${origin}\n   undo: wrangler secret delete DASHBOARD_ORIGIN --env ${deployment.env}`,
  ];
  console.log(`Secrets for ${deployment.worker}:\n\n${plan.join("\n")}`);
  if (!args.includes("--go")) {
    console.log("\nNothing ran. Run again with --go to set them.");
    return;
  }
  const secret = randomBytes(32).toString("base64url");
  const kept = spawnSync("security", ["-i"], {
    input: `add-generic-password -U -s ${service} -a AUTH_SECRET -w ${secret}\n`,
    encoding: "utf8",
  });
  if (kept.status !== 0) fail("Step 1 failed: the keychain refused AUTH_SECRET. Nothing was put.");
  for (const [name, value] of [
    ["AUTH_SECRET", secret],
    ["ADMIN_EMAIL", deployment.adminEmail],
    ["DASHBOARD_ORIGIN", origin],
  ]) {
    const put = wrangler(deployment, ["secret", "put", name, "--env", deployment.env], {
      input: value,
      quiet: true,
    });
    if (put.code !== 0) fail(`Putting ${name} failed:\n${put.output.replaceAll(secret, "***")}`);
    console.log(`put ${name}`);
  }
}

// ── health ──────────────────────────────────────────────────────────────────

/** How long a deploy waits for a healthy /healthz: a new custom domain's certificate takes minutes. */
const DEPLOY_HEALTH_DEADLINE_MS = 10 * 60_000;
const HEALTH_POLL_MS = 10_000;

/**
 * Asks /healthz until it is healthy or `deadlineMs` passes, and answers the last verdict.
 * @param {string} origin
 * @param {number} deadlineMs
 * @returns {Promise<{ healthy: boolean, message: string }>}
 */
async function healthyWithin(origin, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each ask waits for the one before
    const verdict = await healthOf(origin);
    if (verdict.healthy || Date.now() >= deadline) return verdict;
    console.log(`${verdict.message}; asking again`);
    // oxlint-disable-next-line no-await-in-loop -- the pause between asks
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
  }
}

/**
 * @param {string} origin
 * @returns {Promise<{ healthy: boolean, message: string }>}
 */
async function healthOf(origin) {
  /** @type {number | null} */
  let status = null;
  try {
    const response = await fetch(`${origin}/healthz`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    status = response.status;
  } catch {
    status = null;
  }
  const verdict = healthVerdict(status);
  return { healthy: verdict.healthy, message: `${origin}: ${verdict.message}` };
}

/**
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function health(args) {
  const deployment = deploymentNamed(args[0]);
  const verdict = await healthOf(deployment.origin);
  console.log(`${new Date().toISOString()} ${verdict.message}`);
  if (verdict.healthy) return;
  if (args.includes("--notify")) {
    const text = `cfanalytics ${deployment.env} is failing: ${verdict.message}`.replaceAll(
      '"',
      "'",
    );
    spawnSync("osascript", [
      "-e",
      `display notification "${text}" with title "cfanalytics" sound name "Basso"`,
    ]);
  }
  process.exit(1);
}

/**
 * Deploys the watcher (apps/watch, D-30): a Worker on Cloudflare that asks
 * production's /healthz every five minutes and emails the owner when it
 * fails twice in a row, and again when it is back. Its account, store and
 * addresses come from the site file's watch block (D-32).
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function watch(args) {
  const deployment = deploymentNamed("production");
  const config = path.join(scope.dir, "watch.wrangler.jsonc");
  const template = readWranglerConfig(new URL("../apps/watch/wrangler.jsonc", import.meta.url));
  writeFileSync(config, JSON.stringify(joinWatch(template, deployment.site, WATCH_DIR), null, 2));
  console.log(`Deploy the watcher, ${deployment.site.watch.name}, from apps/watch:

1. pnpm --filter @cfanalytics/watch exec wrangler deploy, with the site file's values
   undo: pnpm --filter @cfanalytics/watch exec wrangler delete --name ${deployment.site.watch.name}`);
  if (!args.includes("--go")) {
    console.log("\nNothing ran. Run again with --go to deploy it.");
    return;
  }
  const deployed = await runShown(
    "pnpm",
    ["--filter", "@cfanalytics/watch", "exec", "wrangler", "deploy", "--config", config],
    wranglerEnv(deployment),
  );
  if (deployed.code !== 0) fail("Step 1 (deploy the watcher) failed.");
  console.log(
    "The watcher runs every five minutes and emails the site file's watch.to when production fails.",
  );
}

/**
 * Runs wrangler against the deployment, with the site file joined in, such as
 * an undo the plans print: `pnpm ops wrangler production -- rollback <id>`.
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function wranglerCommand(args) {
  const deployment = deploymentNamed(args[0]);
  if (args[1] !== "--" || args.length < 3) fail(USAGE, 2);
  const ran = await runShown(
    "pnpm",
    [
      "--filter",
      "@cfanalytics/worker",
      "exec",
      "wrangler",
      ...args.slice(2),
      "--config",
      deployment.config,
      "--env",
      deployment.env,
    ],
    wranglerEnv(deployment),
  );
  if (ran.code !== 0) process.exitCode = ran.code;
}

// ── backup and export ───────────────────────────────────────────────────────

/**
 * A GET on the deployment's dashboard API, signed in, or an exit with why not.
 * @param {Deployment} deployment
 * @returns {(where: string) => Promise<Record<string, unknown>>}
 */
function signedInGet(deployment) {
  const api = dashboardApi(deployment);
  if (!api.ok) fail(api.error);
  return (where) => api.call("GET", where);
}

/**
 * Writes one product's tables as NDJSON under `folder`, page by page
 * (privacy-22), and answers the rows written per table and the recording
 * object keys it names.
 * @param {(where: string) => Promise<Record<string, unknown>>} get
 * @param {string} projectId
 * @param {string} folder
 * @returns {Promise<{ rows: Record<string, number>, objectKeys: string[] }>}
 */
async function exportProject(get, projectId, folder) {
  mkdirSync(folder, { recursive: true });
  /** @type {Record<string, number>} */
  const rows = {};
  /** @type {string[]} */
  const objectKeys = [];
  for (const table of EXPORT_TABLES) {
    const lines = [];
    let after = 0;
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- each page needs the cursor of the one before
      const page = await get(`/api/projects/${projectId}/export/${table}?after=${String(after)}`);
      const got = Array.isArray(page.lines)
        ? page.lines.filter((line) => typeof line === "string")
        : [];
      lines.push(...got);
      if (typeof page.next !== "number") break;
      after = page.next;
    }
    writeFileSync(path.join(folder, `${table}.ndjson`), lines.map((line) => `${line}\n`).join(""));
    rows[table] = lines.length;
    if (table === "recording_chunks") {
      for (const line of lines) {
        const row = /** @type {unknown} */ (JSON.parse(line));
        const key = isRecord(row) ? row.object_key : undefined;
        if (typeof key === "string") objectKeys.push(key);
      }
    }
  }
  return { rows, objectKeys };
}

/**
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function exportCommand(args) {
  const deployment = deploymentNamed(args[0]);
  const [, projectId, folder] = args;
  if (projectId === undefined || folder === undefined) fail(USAGE, 2);
  const { rows } = await exportProject(signedInGet(deployment), projectId, path.resolve(folder));
  console.log(JSON.stringify(rows));
}

/**
 * A backup in `folder`: registry.sql from D1, projects/<id>/<table>.ndjson
 * for every product, objects/<key> for every recording chunk (fetched only
 * when not already there, so a repeat run adds the new ones), and
 * manifest.json.
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function backup(args) {
  const deployment = deploymentNamed(args[0]);
  const folder = args[1];
  if (folder === undefined) fail(USAGE, 2);
  const root = path.resolve(folder);
  mkdirSync(root, { recursive: true, mode: 0o700 });

  console.log("▶ 1. the registry's rows");
  const exported = wrangler(deployment, [
    "d1",
    "export",
    deployment.database,
    "--remote",
    "--env",
    deployment.env,
    "--no-schema",
    ...REGISTRY_TABLES.flatMap((table) => ["--table", table]),
    "--output",
    path.join(root, "registry.sql"),
  ]);
  if (exported.code !== 0) fail("Step 1 (the registry) failed.");

  console.log("▶ 2. every product's tables");
  const get = signedInGet(deployment);
  const listed = await get("/api/projects");
  const projects = Array.isArray(listed.projects) ? listed.projects : [];
  /** @type {Record<string, Record<string, number>>} */
  const counts = {};
  /** @type {string[]} */
  const keys = [];
  for (const project of projects) {
    const id = isRecord(project) ? project.id : undefined;
    if (typeof id !== "string") continue;
    // oxlint-disable-next-line no-await-in-loop -- one product at a time keeps the store's load small
    const done = await exportProject(get, id, path.join(root, "projects", id));
    counts[id] = done.rows;
    keys.push(...done.objectKeys);
    console.log(`${id}: ${JSON.stringify(done.rows)}`);
  }

  console.log("▶ 3. the recordings' objects");
  let fetched = 0;
  for (const key of keys) {
    const file = path.join(root, "objects", key);
    if (existsSync(file)) continue;
    mkdirSync(path.dirname(file), { recursive: true });
    const got = wrangler(
      deployment,
      [
        "r2",
        "object",
        "get",
        `${deployment.bucket}/${key}`,
        "--remote",
        "--jurisdiction",
        "eu",
        "--file",
        file,
      ],
      { quiet: true },
    );
    if (got.code !== 0) fail(`Step 3 failed on ${key}:\n${got.output}`);
    fetched += 1;
  }
  console.log(`${String(fetched)} fetched, ${String(keys.length - fetched)} already there`);

  writeFileSync(
    path.join(root, "manifest.json"),
    `${JSON.stringify({ takenAt: new Date().toISOString(), commit: commit(), deployment: deployment.env, products: counts, objects: keys.length }, null, 2)}\n`,
  );
  console.log(`Backup of ${deployment.env} is in ${root}.`);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A backup back into a deployment that holds no product yet (privacy-30):
 * 1. the target's registry must hold no product, live or deleted;
 * 2. registry.sql's rows go into the registry;
 * 3. each product's tables go in through the import route, in IMPORT_ORDER,
 *    500 lines a request; a repeat run adds nothing twice;
 * 4. each recording object goes back into the bucket.
 * The plan, with each step's undo, prints first; it runs only with --go.
 * @param {string[]} args
 * @returns {Promise<void>}
 */
async function restore(args) {
  const deployment = deploymentNamed(args[0]);
  const folder = args[1];
  if (folder === undefined) fail(USAGE, 2);
  const root = path.resolve(folder);
  for (const needed of ["registry.sql", "manifest.json", "projects"]) {
    if (!existsSync(path.join(root, needed)))
      fail(`${root} holds no ${needed}; it is not a backup.`);
  }
  const projectIds = readdirSync(path.join(root, "projects"));
  const info = wrangler(deployment, ["d1", "time-travel", "info", deployment.database, "--json"], {
    quiet: true,
  });
  const parsedInfo = jsonIn(info.output);
  const bookmark = isRecord(parsedInfo) ? parsedInfo.bookmark : undefined;
  if (info.code !== 0 || typeof bookmark !== "string")
    fail(`Could not read the registry's bookmark:\n${info.output}`);
  const plan = [
    `1. check that ${deployment.database} holds no product\n   undo: nothing to undo: it only reads`,
    `2. load ${path.join(root, "registry.sql")} into ${deployment.database}\n   undo: pnpm --filter @cfanalytics/worker exec wrangler d1 time-travel restore ${deployment.database} --bookmark ${bookmark} --env ${deployment.env}`,
    `3. import the tables of ${String(projectIds.length)} products in ${IMPORT_ORDER.join(", ")} order\n   undo: delete each product in Settings; its purge removes its tables`,
    `4. put each recording object into ${deployment.bucket}\n   undo: the same purge removes them`,
  ];
  console.log(`Restore ${root} into ${deployment.worker}:\n\n${plan.join("\n")}`);
  if (!args.includes("--go")) {
    console.log("\nNothing ran. Run again with --go to restore.");
    return;
  }

  console.log("\n▶ 1. the target holds no product");
  const counted = wrangler(
    deployment,
    [
      "d1",
      "execute",
      deployment.database,
      "--remote",
      "--env",
      deployment.env,
      "--json",
      "--command",
      "SELECT COUNT(*) AS n FROM projects",
    ],
    { quiet: true },
  );
  const answer = jsonIn(counted.output);
  const first =
    Array.isArray(answer) && isRecord(answer[0]) && Array.isArray(answer[0].results)
      ? answer[0].results[0]
      : undefined;
  if (counted.code !== 0 || !isRecord(first) || first.n !== 0)
    fail(`Step 1 failed: the target holds products, or could not be read:\n${counted.output}`);

  console.log("▶ 2. the registry's rows");
  const loaded = wrangler(deployment, [
    "d1",
    "execute",
    deployment.database,
    "--remote",
    "--env",
    deployment.env,
    "--yes",
    "--file",
    path.join(root, "registry.sql"),
  ]);
  if (loaded.code !== 0)
    fail("Step 2 (the registry) failed. Undo it with the command in the plan.");

  console.log("▶ 3. each product's tables");
  const api = dashboardApi(deployment);
  if (!api.ok) fail(api.error);
  /** @type {string[]} */
  const keys = [];
  for (const id of projectIds) {
    for (const table of IMPORT_ORDER) {
      const file = path.join(root, "projects", id, `${table}.ndjson`);
      const lines = existsSync(file)
        ? readFileSync(file, "utf8")
            .split("\n")
            .filter((line) => line !== "")
        : [];
      let added = 0;
      for (let start = 0; start < lines.length; start += IMPORT_LINES_MAX) {
        const page = lines.slice(start, start + IMPORT_LINES_MAX);
        // oxlint-disable-next-line no-await-in-loop -- a table's rows go in order, and a person before the rows that name them
        const answered = await api.call("POST", `/api/projects/${id}/import/${table}`, {
          lines: page,
        });
        added += typeof answered.added === "number" ? answered.added : 0;
      }
      if (table === "recording_chunks") {
        for (const line of lines) {
          const row = /** @type {unknown} */ (JSON.parse(line));
          if (isRecord(row) && typeof row.object_key === "string") keys.push(row.object_key);
        }
      }
      console.log(`${id} ${table}: ${String(added)} of ${String(lines.length)} added`);
    }
  }

  console.log("▶ 4. the recording objects");
  for (const key of keys) {
    const file = path.join(root, "objects", key);
    if (!existsSync(file)) fail(`Step 4 failed: the backup has no object ${key}.`);
    const put = wrangler(
      deployment,
      [
        "r2",
        "object",
        "put",
        `${deployment.bucket}/${key}`,
        "--remote",
        "--jurisdiction",
        "eu",
        "--file",
        file,
      ],
      { quiet: true },
    );
    if (put.code !== 0) fail(`Step 4 failed on ${key}:\n${put.output}`);
  }
  console.log(
    `Restored ${String(projectIds.length)} products and ${String(keys.length)} objects into ${deployment.worker}.`,
  );
}

// ── main ────────────────────────────────────────────────────────────────────

const [command, ...rest] = process.argv.slice(2);
if (command === "deploy") await deploy(rest);
else if (command === "secrets") secrets(rest);
else if (command === "health") await health(rest);
else if (command === "watch") await watch(rest);
else if (command === "backup") await backup(rest);
else if (command === "restore") await restore(rest);
else if (command === "export") await exportCommand(rest);
else if (command === "wrangler") await wranglerCommand(rest);
else fail(USAGE, 2);

const { leftovers } = await scope.close();
if (leftovers.length > 0) fail(`The run left behind: ${leftovers.join(", ")}`);
