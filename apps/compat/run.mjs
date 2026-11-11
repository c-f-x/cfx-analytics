// @ts-check

import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openRunScope } from "../../scripts/lib/run-scope.mjs";
import { failedCount, formatCheck } from "./checks.mjs";
import { CLIENTS } from "./clients/index.mjs";
import { decodeRecordingObject, readBucketObjects, readObservations, waitFor } from "./store.mjs";
import { applyMigrations, seedProject, startDev } from "./wrangler.mjs";

// Runs real PostHog SDKs against the real Worker in a run scope: its own
// wrangler dev, its own persisted state, its own project. Every check prints
// one line, and the run exits 0 only when all of them passed.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STORED_WAIT_MS = 30_000;
const USAGE = "usage: pnpm compat [--only node,browser,ios]";

/** @typedef {keyof typeof CLIENTS} ClientName */

/**
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
  const names = parseOnly(argv);
  if (names === null) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const scope = openRunScope({ installExitHandlers: true });
  const stateDir = path.join(scope.dir, "state");
  const project = newProject();
  /** @type {Map<ClientName, import("./checks.mjs").SdkReport>} */
  const reports = new Map();
  let failed = false;

  try {
    applyMigrations({ root: ROOT, stateDir });
    seedProject({ root: ROOT, stateDir, project });
    const { apiHost } = await startDev({ root: ROOT, scope, stateDir });

    for (const name of names) {
      const options = { apiHost, token: project.token, scope, stateDir };
      const report = await runClient(name, options);
      reports.set(name, report);
      if (report.errors.length > 0) {
        failed = true;
        for (const error of report.errors) console.error(`${name}: ${error}`);
      }
    }

    const waited = await waitFor(() => storedExpectations(stateDir, names, reports), {
      timeoutMs: STORED_WAIT_MS,
    });
    if (!waited.ready) {
      failed = true;
      console.error(`stored rows: ${waited.detail}`);
    }

    const observations = readAll(stateDir);
    /** @type {import("./checks.mjs").Check[]} */
    const checks = names.flatMap((name) => CLIENTS[name].checks(observations, reports.get(name)));
    for (const check of checks) console.log(formatCheck(check));
    if (failedCount(checks) > 0) failed = true;
  } catch (error) {
    failed = true;
    console.error(messageOf(error));
  }

  const { leftovers } = await scope.close();
  if (leftovers.length > 0) {
    failed = true;
    console.error(`left behind: ${leftovers.join(", ")}`);
  }
  if (failed) process.exitCode = 1;
}

/**
 * Runs one client, turning a throw into a report the run can print.
 * @param {ClientName} name
 * @param {import("./checks.mjs").ClientOptions} options
 * @returns {Promise<import("./checks.mjs").SdkReport>}
 */
async function runClient(name, options) {
  try {
    return await CLIENTS[name].run(options);
  } catch (error) {
    return { sdk: name, errors: [messageOf(error)] };
  }
}

/**
 * What the store should hold once the clients it ran have flushed: every event
 * a client says it sends, by name, and anything its own `ready` names. A
 * client that threw is not waited for; its checks say what is missing.
 * @param {string} stateDir
 * @param {ClientName[]} names
 * @param {Map<ClientName, import("./checks.mjs").SdkReport>} reports
 * @returns {{ ready: boolean, detail: string }}
 */
function storedExpectations(stateDir, names, reports) {
  try {
    const stored = readObservations(stateDir);
    const storedNames = new Set(stored.events.map((event) => event.event));
    const missing = names
      .flatMap((name) => CLIENTS[name].expects)
      .filter((event) => !storedNames.has(event));
    if (missing.length > 0) {
      return { ready: false, detail: `still missing ${missing.join(", ")}` };
    }
    for (const name of names) {
      const report = reports.get(name);
      if (report === undefined || report.errors.length > 0) continue;
      const ready = CLIENTS[name].ready?.({ ...stored, objects: [] }, report);
      if (ready !== undefined && !ready.ready) return ready;
    }
    return { ready: true, detail: "" };
  } catch (error) {
    return { ready: false, detail: messageOf(error) };
  }
}

/**
 * Everything the checks read, with an empty answer where the Worker has not
 * written yet so each check still says why it failed.
 * @param {string} stateDir
 * @returns {import("./checks.mjs").Observations}
 */
function readAll(stateDir) {
  /** @type {import("./checks.mjs").Observations} */
  let stored = { events: [], links: [], points: [], chunks: [], objects: [] };
  try {
    stored = { ...readObservations(stateDir), objects: [] };
  } catch (error) {
    console.error(`stored rows: ${messageOf(error)}`);
  }
  try {
    /** @type {import("./store.mjs").DecodedObject[]} */
    const objects = [];
    for (const object of readBucketObjects(stateDir)) {
      try {
        objects.push({ ...object, events: decodeRecordingObject(object.bytes) });
      } catch (error) {
        // One unreadable object does not hide the rest; the check whose chunk
        // points at it then says the object is missing.
        console.error(`recording object ${object.key}: ${messageOf(error)}`);
      }
    }
    stored.objects = objects;
  } catch (error) {
    console.error(`recording objects: ${messageOf(error)}`);
  }
  return stored;
}

/**
 * The clients to run: all of them, or the names after --only. Null when the
 * arguments name something the suite does not have.
 * @param {string[]} argv
 * @returns {ClientName[] | null}
 */
function parseOnly(argv) {
  const index = argv.indexOf("--only");
  if (index === -1) return Object.keys(CLIENTS).filter(isClientName);
  const value = argv[index + 1];
  if (value === undefined) return null;
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (names.length === 0) return null;
  const unknown = names.filter((name) => !(name in CLIENTS));
  if (unknown.length > 0) {
    console.error(`unknown client ${unknown.join(", ")}`);
    return null;
  }
  return [...new Set(names.filter(isClientName))];
}

/**
 * @param {string} name
 * @returns {name is ClientName}
 */
function isClientName(name) {
  return name in CLIENTS;
}

/**
 * A fresh project id and token in the shapes the registry's CHECKs require.
 * @returns {{ id: string, token: string, name: string, createdAt: number }}
 */
function newProject() {
  return {
    id: `p_${randomBytes(8).toString("hex")}`,
    token: `cfa_pk_${randomBytes(32).toString("base64url")}`,
    name: `compat ${new Date().toISOString()}`,
    createdAt: Date.now(),
  };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main(process.argv.slice(2));
}
