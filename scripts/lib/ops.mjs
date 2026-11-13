import { createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// The pure rules of the operations commands (scripts/ops.mjs,
// docs/operations.md): the deploy's steps with the undo of each, whether two
// builds are the same, and what a health answer means. Which deployment a
// command acts on comes from the site file (site.mjs). The commands do the I/O.

/**
 * @typedef {{ name: string, command: string, args: string[], undo: string }} CommandStep
 * @typedef {{ name: string, check: string, undo: string }} CheckStep
 * @typedef {CommandStep | CheckStep} DeployStep
 * @typedef {import("./site.mjs").Deployment} Deployment
 */

/**
 * How the plans write a wrangler command run against the deployment: through
 * `pnpm ops wrangler`, which joins the site file into a config first (D-32),
 * so an undo printed now still runs after this run's config is gone.
 * @param {string} args
 * @returns {string}
 */
export const wranglerCommand = (args) => `pnpm ops wrangler production -- ${args}`;

/** A wrangler command, run in the Worker's package against the joined config at `config`. */
const wrangler = (/** @type {string} */ config, /** @type {string[]} */ ...args) => ({
  command: "pnpm",
  args: ["--filter", "@cfanalytics/worker", "exec", "wrangler", ...args, "--config", config],
});

/**
 * The deploy, step by step, each with what undoes it (docs/operations.md).
 * The build is made once into `checkedDir` after every check passed; the
 * deploy writes what it uploads into `shippedDir`, and the "same build" step
 * fails unless the two are byte for byte the same.
 * @param {{
 *   deployment: Deployment,
 *   config: string,
 *   bookmark: string,
 *   previousVersion: string | null,
 *   checkedDir: string,
 *   shippedDir: string,
 * }} input
 * @returns {DeployStep[]}
 */
export function deploySteps({
  deployment,
  config,
  bookmark,
  previousVersion,
  checkedDir,
  shippedDir,
}) {
  const { env, worker, database } = deployment;
  return [
    {
      name: "check",
      command: "pnpm",
      args: ["check"],
      undo: "Nothing to undo: the checks change nothing in Cloudflare.",
    },
    {
      name: "build the dashboard",
      command: "pnpm",
      args: ["--filter", "@cfanalytics/web", "build"],
      undo: "Nothing to undo: the build is local.",
    },
    {
      name: "bundle the Worker once",
      ...wrangler(config, "deploy", "--dry-run", "--env", env, "--outdir", checkedDir),
      undo: "Nothing to undo: the bundle is local.",
    },
    {
      name: "apply the registry migrations",
      ...wrangler(config, "d1", "migrations", "apply", "REGISTRY", "--remote", "--env", env),
      undo: `${wranglerCommand(`d1 time-travel restore ${database} --bookmark ${bookmark}`)} (this returns the whole registry to before the migration, so products, keys and settings changed since are lost too)`,
    },
    {
      name: "deploy the Worker",
      ...wrangler(config, "deploy", "--env", env, "--outdir", shippedDir),
      undo:
        previousVersion === null
          ? `This is ${worker}'s first deploy: ${wranglerCommand("delete")} removes it (its data stays in D1, the Durable Objects and R2).`
          : wranglerCommand(`rollback ${previousVersion}`),
    },
    {
      name: "the shipped bundle is the checked one",
      check: "same build",
      undo: "Nothing to undo: it compares two local folders. If it fails, undo the deploy step.",
    },
    {
      name: "the deployment answers /healthz",
      check: "health",
      undo: "Nothing to undo: it only reads. If it fails, undo the deploy step.",
    },
  ];
}

/** The plan as the owner reads it before anything runs: each step, then how to undo it. */
export function planText(steps) {
  return steps
    .map((step, index) => {
      const what = "command" in step ? `${step.command} ${step.args.join(" ")}` : step.check;
      return `${String(index + 1)}. ${step.name}\n   runs: ${what}\n   undo: ${step.undo}`;
    })
    .join("\n");
}

/**
 * Every uploaded file under `dir` with its SHA-256, by path relative to
 * `dir`, sorted. Two builds are the same when their digests are equal.
 * wrangler's README.md and source maps hold the output folder's own path, and
 * neither is uploaded, so they are left out.
 * @param {string} dir
 * @returns {string}
 */
export function buildDigest(dir) {
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "README.md" && !entry.name.endsWith(".map"))
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .toSorted();
  return files
    .map((file) => {
      const hash = createHash("sha256")
        .update(readFileSync(path.join(dir, file)))
        .digest("hex");
      return `${hash}  ${file}`;
    })
    .join("\n");
}

/**
 * The registry's tables, in the order a restore loads them: a product before
 * the keys and tiles that name it. The backup exports their rows without the
 * schema, since a restore loads them into a deployment whose migrations made
 * the tables. scripts/ops.test.mjs keeps this list equal to the migrations'.
 */
export const REGISTRY_TABLES = ["projects", "secret_keys", "board_tiles"];

/**
 * What a /healthz answer means (platform-12, platform-13).
 * @param {number | null} status null when nothing answered
 * @returns {{ healthy: boolean, message: string }}
 */
export function healthVerdict(status) {
  if (status === 200)
    return {
      healthy: true,
      message: "healthy: the Worker, the registry and the recordings bucket answer",
    };
  if (status === 503)
    return {
      healthy: false,
      message: "failing: the Worker runs, but the registry or the recordings bucket did not answer",
    };
  if (status === null) return { healthy: false, message: "failing: nothing answered" };
  return { healthy: false, message: `failing: /healthz answered ${String(status)}` };
}

/**
 * A dashboard session token as the Worker signs one (platform-44, D-27):
 * base64url(JSON) "." base64url(HMAC-SHA256 of that text under AUTH_SECRET).
 * @param {string} secret
 * @param {{ email: string, exp: number }} payload
 * @returns {string}
 */
export function sessionToken(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

// ── Where the stores live (D-38) ────────────────────────────────────────────

/**
 * The wrangler arguments that name a deployment's region, for the commands
 * that address its bucket. None for Cloudflare's default placement.
 * @param {{ bucket?: string, jurisdiction?: "eu" }} deployment
 * @returns {string[]}
 */
export function jurisdictionArgs(deployment) {
  return deployment.jurisdiction === undefined ? [] : ["--jurisdiction", deployment.jurisdiction];
}

/**
 * Why a deploy must stop before it changes anything, or null when the site's
 * region is where its bucket really is (ops-03). Cloudflare cannot move a
 * store, so a site file that names the wrong region would point the Worker at
 * new, empty stores.
 * @param {{ bucket: string, jurisdiction?: "eu" }} deployment
 * @param {{ found: boolean, output: string }} lookup the bucket asked for in the site's region
 * @returns {string | null}
 */
export function regionProblem(deployment, lookup) {
  if (lookup.found) return null;
  const where =
    deployment.jurisdiction === undefined
      ? "Cloudflare's default placement"
      : `the ${deployment.jurisdiction} jurisdiction`;
  return [
    `The site file says the stores are in ${where}, but the bucket ${deployment.bucket} was not found there.`,
    "A deployment keeps the region it was made in (D-38): set the site file's jurisdiction to where its stores are.",
    `Wrangler said: ${lookup.output.trim() || "nothing"}`,
  ].join("\n");
}
