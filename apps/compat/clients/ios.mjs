// @ts-check

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, request as forward } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { isFlagsRequest } from "../checks.mjs";
import { PLAN } from "../plan.mjs";
import { readObservations, waitFor } from "../store.mjs";

// posthog-ios in a macOS command-line target (apps/compat/macos/), built with
// SwiftPM. An iOS app cannot run on this machine, so the SDK is linked into a
// macOS executable with no bundle id (spike S2). The SDK talks to the Worker
// through a pass-through recorder, so the /flags request a check reads is the
// one the SDK itself sent.

const MACOS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "macos");
const EXPECTED_EVENTS = [PLAN.ios.event, "$screen", "$identify", "$create_alias"];
const BUILD_TIMEOUT_MS = 15 * 60 * 1_000;
const DELIVERED_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 10_000;
const OUTPUT_TAIL = 40;
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * @typedef {{ dir: string, recordChild: (pid: number, options?: { group?: boolean }) => void }} Scope
 * @typedef {import("../checks.mjs").RecordedCall} RecordedCall
 * @typedef {{ host: string, calls: RecordedCall[], close: () => Promise<void> }} Recorder
 */

/**
 * Builds the macOS client, runs it against a recorder in front of the Worker,
 * and stops it once its four events are stored and its /flags request has
 * been recorded.
 * @param {{ apiHost: string, token: string, scope: Scope, stateDir: string }} options
 * @returns {Promise<import("../checks.mjs").SdkReport>}
 */
export async function runIos({ apiHost, token, scope, stateDir }) {
  const scratch = path.join(scope.dir, "swift");
  const build = await runToEnd(
    "swift",
    ["build", "--package-path", MACOS_DIR, "--scratch-path", scratch],
    { scope, timeoutMs: BUILD_TIMEOUT_MS },
  );
  if (build.code !== 0) {
    throw new Error(`swift build exited ${String(build.code)}:\n${tail(build.output)}`);
  }

  // posthog-ios keeps its state, the identified user included, under
  // Application Support/com.posthog.unknown when the program has no bundle id.
  // Foundation reads the home folder from CFFIXED_USER_HOME, not HOME, so that
  // points into the run's scope. A state folder in the real home, before or
  // after, is an error: it would carry one run's identity into the next.
  const realState = path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "com.posthog.unknown",
    token,
  );
  /** @type {string[]} */
  const errors = [];
  if (existsSync(realState)) errors.push(`posthog-ios state from another run is at ${realState}`);

  const recorder = await startRecorder(apiHost);
  let output = "";
  const { child, exited } = startClient(path.join(scratch, "debug", "CompatMac"), recorder.host, {
    token,
    home: path.join(scope.dir, "home"),
    collect: (chunk) => {
      output += chunk;
    },
  });
  if (child.pid === undefined) {
    await recorder.close();
    throw new Error("CompatMac did not start");
  }
  scope.recordChild(child.pid, { group: true });

  let ended = false;
  child.once("close", () => {
    ended = true;
  });

  try {
    const waited = await waitFor(() => delivered(recorder.calls, stateDir, ended), {
      timeoutMs: DELIVERED_TIMEOUT_MS,
    });
    if (!waited.ready) {
      const seconds = String(DELIVERED_TIMEOUT_MS / 1_000);
      errors.push(`posthog-ios's events did not all arrive in ${seconds} s: ${waited.detail}`);
    }
  } finally {
    await stopGroup(child.pid, exited);
    await recorder.close();
  }

  if (existsSync(realState)) errors.push(`posthog-ios wrote outside the run's scope: ${realState}`);
  errors.push(...output.split("\n").filter(isErrorLine));
  return { sdk: "ios", errors, calls: recorder.calls };
}

/**
 * Starts the built client with the recorder as its host, in its own process
 * group so the whole group can be stopped. A start that finds no binary
 * resolves through "error" instead of throwing, so the caller can report it.
 * @param {string} binary
 * @param {string} apiHost
 * @param {{ token: string, home: string, collect: (chunk: string) => void }} options
 * @returns {{ child: import("node:child_process").ChildProcess, exited: Promise<unknown> }}
 */
function startClient(binary, apiHost, { token, home, collect }) {
  const child = spawn(binary, [apiHost, token], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CFFIXED_USER_HOME: home },
  });
  const exited = new Promise((resolve) => {
    child.once("close", resolve);
    child.once("error", resolve);
  });
  child.stdout?.setEncoding("utf8").on("data", collect);
  child.stderr?.setEncoding("utf8").on("data", collect);
  return { child, exited };
}

/**
 * What the run still waits for: the four events in the store, and a POST
 * /flags recorded. It also ends the wait when the client has exited, so a
 * client that dies is reported instead of waiting out the deadline.
 * @param {RecordedCall[]} calls
 * @param {string} stateDir
 * @param {boolean} ended
 * @returns {{ ready: boolean, detail: string }}
 */
function delivered(calls, stateDir, ended) {
  const flags = calls.some(isFlagsRequest);
  /** @type {string[]} */
  let names;
  try {
    names = readObservations(stateDir).events.map((event) => event.event);
  } catch (error) {
    return { ready: false, detail: `${messageOf(error)}${ended ? " (CompatMac exited)" : ""}` };
  }
  const stored = new Set(names);
  const missing = EXPECTED_EVENTS.filter((name) => !stored.has(name));
  if (missing.length === 0 && flags) return { ready: true, detail: "" };
  const parts = [
    missing.length === 0 ? "" : `still missing ${missing.join(", ")}`,
    flags ? "" : "no /flags request",
    ended ? "CompatMac exited" : "",
  ];
  return { ready: false, detail: parts.filter((part) => part !== "").join("; ") };
}

/**
 * Stops the client's process group: SIGTERM first, SIGKILL if it has not ended
 * by the deadline. The SDK sends on the main queue, so it runs until stopped.
 * @param {number} pid
 * @param {Promise<unknown>} exited
 * @returns {Promise<void>}
 */
async function stopGroup(pid, exited) {
  signalGroup(pid, "SIGTERM");
  if (await settledWithin(exited, STOP_TIMEOUT_MS)) return;
  signalGroup(pid, "SIGKILL");
  await settledWithin(exited, STOP_TIMEOUT_MS);
}

/**
 * @param {number} pid
 * @param {NodeJS.Signals} signal
 * @returns {void}
 */
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // It ended between the check and the signal.
  }
}

/**
 * Whether the promise settled before the deadline. The timer is cleared either
 * way, so it never holds the run open.
 * @param {Promise<unknown>} promise
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function settledWithin(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Runs a command to its end in its own process group, so a run that is stopped
 * takes it too, and returns its output. The deadline catches a hang.
 * @param {string} command
 * @param {string[]} args
 * @param {{ scope: Scope, timeoutMs: number }} options
 * @returns {Promise<{ code: number | null, output: string }>}
 */
function runToEnd(command, args, { scope, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    if (child.pid !== undefined) scope.recordChild(child.pid, { group: true });
    let output = "";
    const collect = (/** @type {Buffer | string} */ chunk) => {
      output += String(chunk);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
      reject(
        new Error(
          `${command} did not finish in ${String(timeoutMs / 1_000)} s; its output ended with:\n${tail(output)}`,
        ),
      );
    }, timeoutMs);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * A pass-through server in front of the Worker. It forwards every request and
 * its answer unchanged and records both, so a check reads what the SDK really
 * sent and what the Worker really answered.
 * @param {string} target the Worker's URL
 * @returns {Promise<Recorder>}
 */
function startRecorder(target) {
  const upstream = new URL(target);
  /** @type {RecordedCall[]} */
  const calls = [];
  const server = createServer((request, response) => {
    /** @type {Buffer[]} */
    const chunks = [];
    request.on("error", () => {
      // The SDK hung up; its answer is already recorded, if it had one.
    });
    request.on("data", (chunk) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      forwardCall(request, Buffer.concat(chunks), response, upstream, calls);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("the recorder got no port"));
        return;
      }
      resolve({
        host: `http://127.0.0.1:${String(address.port)}`,
        calls,
        close: async () => {
          server.closeAllConnections();
          await new Promise((done) => {
            server.close(() => {
              done(undefined);
            });
          });
        },
      });
    });
  });
}

/**
 * Sends one recorded request to the Worker and copies its answer back.
 * @param {import("node:http").IncomingMessage} request
 * @param {Buffer} body
 * @param {import("node:http").ServerResponse} response
 * @param {URL} upstream
 * @param {RecordedCall[]} calls
 * @returns {void}
 */
function forwardCall(request, body, response, upstream, calls) {
  const call = {
    method: request.method ?? "",
    path: pathOf(request.url),
    body: decoded(body, request.headers["content-encoding"]),
  };
  const headers = keptHeaders(request.headers);
  headers.host = upstream.host;
  if (body.length > 0) headers["content-length"] = String(body.length);
  const sent = forward(
    {
      host: upstream.hostname,
      port: upstream.port,
      method: request.method,
      path: request.url ?? "/",
      headers,
    },
    (answer) => {
      /** @type {Buffer[]} */
      const answerChunks = [];
      answer.on("data", (chunk) => {
        answerChunks.push(chunk);
      });
      answer.on("end", () => {
        calls.push({
          ...call,
          status: answer.statusCode ?? 0,
          answer: decoded(Buffer.concat(answerChunks), answer.headers["content-encoding"]),
        });
      });
      response.writeHead(answer.statusCode ?? 502, keptHeaders(answer.headers));
      answer.pipe(response);
    },
  );
  sent.on("error", () => {
    calls.push({ ...call, status: 0, answer: "" });
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  sent.end(body);
}

/**
 * The headers worth passing on: every end-to-end header, so the Worker sees
 * the SDK's Content-Type, Content-Encoding and User-Agent as sent.
 * @param {import("node:http").IncomingHttpHeaders} headers
 * @returns {Record<string, string | string[]>}
 */
function keptHeaders(headers) {
  /** @type {Record<string, string | string[]>} */
  const kept = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    kept[name] = value;
  }
  return kept;
}

/**
 * The path a request made, without its query.
 * @param {string | undefined} url
 * @returns {string}
 */
function pathOf(url) {
  return new URL(url ?? "/", "http://recorder").pathname;
}

/**
 * A body as text, decompressed when its content-encoding says so. A body that
 * cannot be decompressed is recorded as it arrived, so a check reports it.
 * @param {Buffer} buffer
 * @param {string | string[] | undefined} encoding
 * @returns {string}
 */
function decoded(buffer, encoding) {
  const name = Array.isArray(encoding) ? encoding[0] : encoding;
  try {
    if (name === "gzip") return gunzipSync(buffer).toString("utf8");
    if (name === "deflate") return inflateSync(buffer).toString("utf8");
    if (name === "br") return brotliDecompressSync(buffer).toString("utf8");
  } catch {
    // The raw bytes are what a check should see.
  }
  return buffer.toString("utf8");
}

/**
 * The last lines of a command's output, for an error that names them.
 * @param {string} output
 * @returns {string}
 */
function tail(output) {
  return output.trimEnd().split("\n").slice(-OUTPUT_TAIL).join("\n");
}

/**
 * The SDK logs through hedgeLog, which prefixes its lines with "[PostHog]".
 * An error is either a line that says "error", or a PostHog line that says
 * "fail".
 * @param {string} line
 * @returns {boolean}
 */
function isErrorLine(line) {
  return /error/i.test(line) || (/\[PostHog\]/i.test(line) && /fail/i.test(line));
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
