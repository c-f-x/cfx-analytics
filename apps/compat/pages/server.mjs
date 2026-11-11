// @ts-check

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The pages the browser client opens, and the SDK they run, served from an
// origin of their own: the API is on another port, so every request the SDK
// sends is cross-origin and its CORS answers are exercised. The SDK comes from
// the posthog-js installed in this package, which package.json pins to the
// version the Worker serves its lazy scripts for (D-15); a mismatch makes the
// lazy recorder request 404 and config-05 and config-29 fail.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEXT_HTML = "text/html; charset=utf-8";
const TEXT_JAVASCRIPT = "text/javascript; charset=utf-8";

/**
 * @typedef {{ body: Buffer, type: string }} ServedFile
 */

/**
 * Serves the pages, their script and the installed posthog-js build on
 * 127.0.0.1 and a port the OS picks. Close it in a finally: it outlives
 * nothing.
 * @returns {Promise<{ origin: string, close: () => Promise<void> }>}
 */
export async function startPageServer() {
  const require = createRequire(import.meta.url);
  const packageFile = require.resolve("posthog-js/package.json");
  const packageJson = /** @type {unknown} */ (JSON.parse(readFileSync(packageFile, "utf8")));
  if (!isRecord(packageJson) || typeof packageJson.version !== "string") {
    throw new Error(`posthog-js's package.json at ${packageFile} has no version`);
  }

  /** @type {Map<string, ServedFile>} */
  const served = new Map([
    ["/", fileOf(path.join(HERE, "normal.html"), TEXT_HTML)],
    ["/normal.html", fileOf(path.join(HERE, "normal.html"), TEXT_HTML)],
    ["/second.html", fileOf(path.join(HERE, "second.html"), TEXT_HTML)],
    ["/cookieless.html", fileOf(path.join(HERE, "cookieless.html"), TEXT_HTML)],
    ["/page.js", fileOf(path.join(HERE, "page.js"), TEXT_JAVASCRIPT)],
    // array.js is the build a page installs with a script tag. The Worker
    // serves its lazy scripts but no SDK build, so this one comes from the
    // page origin as an installed package ships it. Unlike array.full.js it
    // leaves the recorder to the Worker's lazy script, the path config-05 and
    // config-29 prove.
    [
      "/posthog-js/array.js",
      fileOf(path.join(path.dirname(packageFile), "dist", "array.js"), TEXT_JAVASCRIPT),
    ],
  ]);

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    const file = served.get(pathname);
    if (request.method !== "GET" || file === undefined) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": file.type,
      "content-length": file.body.length,
      "cache-control": "no-store",
    });
    response.end(file.body);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  if (port === 0) throw new Error("the page server did not get a port");

  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined));
        server.closeAllConnections();
      }),
  };
}

/**
 * @param {string} file
 * @param {string} type
 * @returns {ServedFile}
 */
function fileOf(file, type) {
  return { body: readFileSync(file), type };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
