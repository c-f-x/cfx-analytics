// @ts-check

import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

// Starts the real Worker under wrangler dev and brings its local resources up:
// the registry D1 migrations, then one project row. Nothing here reaches
// Cloudflare: every command carries --local and --persist-to in the run scope.

const READY_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL = 2_000;

/**
 * @typedef {{ dir: string, recordChild: (pid: number, options?: { group?: boolean }) => void }} Scope
 * @typedef {{ id: string, token: string, name: string, createdAt: number }} Project
 */

/**
 * Applies the registry migrations to the run's persisted D1 state.
 * @param {{ root: string, stateDir: string }} options
 * @returns {void}
 */
export function applyMigrations({ root, stateDir }) {
  runPnpm(root, [
    "--filter",
    "@cfanalytics/worker",
    "exec",
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "REGISTRY",
    "--local",
    "--persist-to",
    stateDir,
  ]);
}

/**
 * Seeds one project row in the shapes the registry's CHECKs require, with
 * recordings and heatmaps on.
 * @param {{ root: string, stateDir: string, project: Project }} options
 * @returns {void}
 */
export function seedProject({ root, stateDir, project }) {
  const sql = [
    "INSERT INTO projects (id, name, token, created_at, recording_enabled, heatmaps_enabled)",
    `VALUES (${quote(project.id)}, ${quote(project.name)}, ${quote(project.token)}, ${String(project.createdAt)}, 1, 1)`,
  ].join(" ");
  runPnpm(root, [
    "--filter",
    "@cfanalytics/worker",
    "exec",
    "wrangler",
    "d1",
    "execute",
    "REGISTRY",
    "--local",
    "--persist-to",
    stateDir,
    "--yes",
    "--command",
    sql,
  ]);
}

/**
 * Starts `wrangler dev` on an OS-picked port, in its own process group, and
 * waits for its ready line. The deadline catches a hang. `vars` gives more
 * variables from the origin the Worker will answer on, such as the
 * dashboard's AUTH_SECRET and DASHBOARD_ORIGIN.
 * @param {{ root: string, scope: Scope, stateDir: string, vars?: (origin: string) => Record<string, string> }} options
 * @returns {Promise<{ apiHost: string, pid: number }>}
 */
export async function startDev({ root, scope, stateDir, vars }) {
  const port = await freePort();
  const extra = Object.entries(vars?.(`http://127.0.0.1:${String(port)}`) ?? {}).flatMap(
    ([name, value]) => ["--var", `${name}:${value}`],
  );
  const inspectorPort = await freePort();
  const log = createWriteStream(path.join(scope.dir, "wrangler.log"), { flags: "a" });
  const { command, prefix } = pnpmInvocation();
  const child = spawn(
    command,
    [
      ...prefix,
      "--filter",
      "@cfanalytics/worker",
      "exec",
      "wrangler",
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(inspectorPort),
      "--persist-to",
      stateDir,
      "--var",
      "LOCAL_UNSCOPED_PROJECT_STORES:1",
      ...extra,
    ],
    {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_LOG_PATH: path.join(scope.dir, "wrangler-logs") },
    },
  );
  if (child.pid === undefined) {
    throw new Error("wrangler did not start: node gave it no process id");
  }
  scope.recordChild(child.pid, { group: true });

  let output = "";
  /** @type {(() => void) | undefined} */
  let acceptReady;
  /** @param {Buffer | string} chunk */
  const collect = (chunk) => {
    const text = String(chunk);
    log.write(text);
    output = (output + text).slice(-OUTPUT_TAIL * 4);
    acceptReady?.();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.once("exit", () => log.end());

  /** @type {Promise<string>} */
  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `wrangler was not ready in ${String(READY_TIMEOUT_MS / 1_000)} s; its output ended with:\n${tail(output)}`,
        ),
      );
    }, READY_TIMEOUT_MS);
    /**
     * @param {(value: string) => void} callback
     * @param {string} value
     */
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    acceptReady = () => {
      const url = readyUrl(output);
      if (url !== null) settle(resolve, url);
    };
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `wrangler exited (${String(code ?? signal)}) before it was ready; its output ended with:\n${tail(output)}`,
        ),
      );
    });
    acceptReady?.();
  });

  return { apiHost: await ready, pid: child.pid };
}

/**
 * The URL wrangler printed when it was ready.
 * @param {string} output
 * @returns {string | null}
 */
function readyUrl(output) {
  const match = /Ready on (https?:\/\/[^\s]+)/.exec(output);
  const url = match?.[1];
  return url === undefined ? null : url.replace(/\/+$/, "");
}

/**
 * @param {string} output
 * @returns {string}
 */
function tail(output) {
  return output.slice(-OUTPUT_TAIL);
}

/**
 * The pnpm that runs this script, as its CLI file, or pnpm from the PATH.
 * @returns {{ command: string, prefix: string[] }}
 */
function pnpmInvocation() {
  const execpath = process.env.npm_execpath;
  if (execpath === undefined || !/pnpm/i.test(path.basename(execpath))) {
    return { command: "pnpm", prefix: [] };
  }
  // pnpm is a JS file when run through npm and a standalone binary through npx.
  if (/\.[cm]?js$/.test(execpath)) {
    return { command: process.execPath, prefix: [execpath] };
  }
  return { command: execpath, prefix: [] };
}

/**
 * Runs one pnpm command to completion and fails with its stderr.
 * @param {string} root
 * @param {string[]} args
 * @returns {string}
 */
export function runPnpm(root, args) {
  const { command, prefix } = pnpmInvocation();
  try {
    return execFileSync(command, [...prefix, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = isRecord(error) && typeof error.stderr === "string" ? error.stderr : "";
    throw new Error(`pnpm ${args.join(" ")} failed:\n${stderr.trim() || String(error)}`, {
      cause: error,
    });
  }
}

/**
 * A port node just held and released, so it is free but not fixed.
 * @returns {Promise<number>}
 */
async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not pick a free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Quotes a string for the one INSERT this module runs.
 * @param {string} value
 * @returns {string}
 */
function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
