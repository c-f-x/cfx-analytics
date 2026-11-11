// @ts-check

import { chromium } from "playwright";
import { startPageServer } from "../pages/server.mjs";
import { PLAN } from "../plan.mjs";

/**
 * @typedef {import("../checks.mjs").SdkReport} SdkReport
 * @typedef {import("../checks.mjs").Exchange} Exchange
 * @typedef {import("../checks.mjs").ConsoleEntry} ConsoleEntry
 * @typedef {import("../checks.mjs").Beacon} Beacon
 * @typedef {import("playwright").Browser} Browser
 * @typedef {import("playwright").Page} Page
 * @typedef {import("playwright").Request} Request
 * @typedef {{
 *   errors: string[],
 *   console: ConsoleEntry[],
 *   exchanges: Exchange[],
 *   beacons: Beacon[],
 *   config: Record<string, unknown> | null,
 *   sessionIds: { main: string | null, headed: string | null },
 * }} ReportParts
 */

// posthog-js in Playwright's full Chromium, through pages served from a second
// origin so every request the SDK makes is cross-origin. The SDK refuses to
// count a browser it takes for a robot: it reads "HeadlessChrome" in the user
// agent or brands, or navigator.webdriver. So the run launches the full
// Chromium (channel "chromium") in its new headless mode, turns the automation
// flag off, and gives every context the same browser's user agent without
// "Headless" (spike S2, finding 1).

const LAUNCH_ARGS = ["--disable-blink-features=AutomationControlled"];
const CHUNK_TIMEOUT_MS = 30_000;
const MIN_CHUNKS = 2;

/**
 * What the store must hold before the browser checks can decide: the browser's
 * events, two chunks of its session, a pageleave with its scroll depth,
 * heatmap points and a cookieless event. run.mjs asks this again until it is
 * ready or the deadline passes.
 * @param {import("../checks.mjs").Observations} stored
 * @param {SdkReport | undefined} report
 * @returns {{ ready: boolean, detail: string }}
 */
export function browserReady(stored, report) {
  /** @type {string[]} */
  const missing = [];
  const session = report?.sessionIds?.main ?? null;
  if (
    !stored.events.some((event) => event.event === "$pageview" && event.properties.$lib === "web")
  ) {
    missing.push("a browser $pageview");
  }
  if (session === null) {
    missing.push("the browser's session id");
  } else if (stored.chunks.filter((chunk) => chunk.sessionId === session).length < MIN_CHUNKS) {
    missing.push(`${String(MIN_CHUNKS)} recording chunks`);
  }
  if (
    !stored.events.some(
      (event) =>
        event.event === "$pageleave" &&
        typeof event.properties.$prev_pageview_max_scroll === "number" &&
        event.properties.$prev_pageview_max_scroll >= PLAN.browser.scrollDepth,
    )
  ) {
    missing.push("a $pageleave with its scroll depth");
  }
  if (!stored.points.some((point) => point.path === PLAN.browser.pagePath)) {
    missing.push("heatmap points");
  }
  if (!stored.events.some((event) => /^cookieless_[0-9a-f]{16}$/.test(event.distinctId))) {
    missing.push("a cookieless event");
  }
  return {
    ready: missing.length === 0,
    detail: missing.length === 0 ? "" : `still missing ${missing.join(", ")}`,
  };
}

/**
 * Runs the real posthog-js against the Worker:
 * 1. a headless visitor loads the first page, waits for the lazy recorder,
 *    clicks #buy, types the secret, and waits for the first /s/ chunk;
 * 2. it follows the link to the second page, waits for another chunk, and
 *    shuts the SDK down so its queue is flushed;
 * 3. a headed visitor scrolls the first page, follows the same link, and waits
 *    for the $pageleave its navigation sends (headless sends none);
 * 4. a fresh context opens the cookieless page and flushes it;
 * 5. every browser and the page server close in a finally.
 * The report is the client's account: what it saw on the wire and the console,
 * its remote config and its session ids. The Worker's rows are the checks'
 * source of truth.
 * @param {{ apiHost: string, token: string }} options
 * @returns {Promise<SdkReport>}
 */
export async function runBrowser({ apiHost, token }) {
  const pages = await startPageServer();
  /** @type {ReportParts} */
  const report = {
    errors: [],
    console: [],
    exchanges: [],
    beacons: [],
    config: null,
    sessionIds: { main: null, headed: null },
  };
  /** @type {Promise<void>[]} */
  const bodyReads = [];
  /** @type {Browser | null} */
  let browser = null;
  /** @type {Browser | null} */
  let headed = null;

  try {
    browser = await launch(true);
    const userAgent = await visitorUserAgent(browser);
    const query = `?api=${encodeURIComponent(apiHost)}&token=${encodeURIComponent(token)}`;
    await mainVisit(browser, userAgent, pages.origin, query, apiHost, token, report, bodyReads);

    headed = await launch(false);
    await pageleaveVisit(
      headed,
      await visitorUserAgent(headed),
      pages.origin,
      query,
      apiHost,
      report,
      bodyReads,
    );

    await cookielessVisit(browser, userAgent, pages.origin, query, apiHost, report, bodyReads);
  } catch (error) {
    // A visit that times out still leaves what the earlier ones saw, so the
    // checks can say what went wrong rather than only that the run threw.
    report.errors.push(messageOf(error));
  } finally {
    await browser?.close();
    await headed?.close();
    await pages.close();
  }

  await Promise.all(bodyReads);
  return {
    sdk: "browser",
    errors: report.errors,
    console: report.console,
    exchanges: report.exchanges,
    beacons: report.beacons,
    config: report.config,
    sessionIds: report.sessionIds,
  };
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The headless visit: the events, the autocapture, the typed input and two
 * snapshot chunks.
 * @param {Browser} browser
 * @param {string} userAgent
 * @param {string} pageOrigin
 * @param {string} query
 * @param {string} apiHost
 * @param {string} token
 * @param {ReportParts} report
 * @param {Promise<void>[]} bodyReads
 * @returns {Promise<void>}
 */
async function mainVisit(browser, userAgent, pageOrigin, query, apiHost, token, report, bodyReads) {
  const context = await browser.newContext({ userAgent });
  try {
    const page = await context.newPage();
    watch(page, apiHost, report, bodyReads);

    // The recorder and /flags are requested after the remote config arrives,
    // so their waiters must exist before the navigation starts.
    const recorderLoaded = page.waitForResponse(
      (response) => isStaticScript(response.url(), "lazy-recorder") && response.status() === 200,
    );
    const flagsAnswered = page.waitForResponse(isFlagsResponse);
    await Promise.all([page.goto(`${pageOrigin}${PLAN.browser.pagePath}${query}`), recorderLoaded]);
    await flagsAnswered;
    await page.locator("#buy").waitFor({ state: "visible" });

    // The recorder's script is fetched before it observes the page; the click
    // and the typing must happen after it has started, or rrweb never sees them.
    await page.waitForFunction("posthog.sessionRecording?.started === true");
    report.sessionIds.main = await sessionId(page);
    report.config = await remoteConfig(page, token);

    await page.locator("#buy").click();
    await page.locator("#secret").pressSequentially(PLAN.browser.typedText);
    await chunkSent(page, apiHost);

    await page.locator("#next").click();
    await page.waitForURL((url) => url.pathname === PLAN.browser.secondPath);
    // An interaction releases the recorder's buffer on the new page, as the
    // first click did on the old one.
    await page.locator("#buy").click();
    await chunkSent(page, apiHost);

    // Flush the page's event queue and the recorder, so nothing is in flight
    // when the context closes.
    await page.evaluate("posthog.shutdown()");
  } finally {
    await context.close();
  }
}

/**
 * The headed visit: a scroll and a same-tab link click, whose $pageleave is
 * the only one posthog-js sends with the page's scroll depth (spike S2,
 * finding 3).
 * @param {Browser} browser
 * @param {string} userAgent
 * @param {string} pageOrigin
 * @param {string} query
 * @param {string} apiHost
 * @param {ReportParts} report
 * @param {Promise<void>[]} bodyReads
 * @returns {Promise<void>}
 */
async function pageleaveVisit(browser, userAgent, pageOrigin, query, apiHost, report, bodyReads) {
  const context = await browser.newContext({ userAgent });
  try {
    const page = await context.newPage();
    watch(page, apiHost, report, bodyReads);
    // Compression off: the pageleave beacon then goes as a base64 form body
    // instead of a gzip text/plain one (intake-11).
    await page.goto(`${pageOrigin}${PLAN.browser.pagePath}${query}&compression=off`);
    await page.locator("#buy").waitFor({ state: "visible" });
    await page.waitForFunction("posthog.__loaded === true");
    report.sessionIds.headed = await sessionId(page);

    await page.evaluate(`window.scrollTo(0, ${String(PLAN.browser.scrollDepth)})`);
    // The SDK's scroll manager has seen the scroll once its context holds it;
    // the pageleave reads that context.
    await page.waitForFunction(
      `posthog.scrollManager.getContext()?.maxScrollY >= ${String(PLAN.browser.scrollDepth)}`,
    );

    // The pageleave is a beacon sent during the unload, which Playwright does
    // not report as a request. The row it leaves is the evidence, and run.mjs
    // waits for it (heatmaps-20).
    await page.locator("#next").click();
    await page.waitForURL((url) => url.pathname === PLAN.browser.secondPath);
    // The page that unloaded recorded its beacon in sessionStorage, which the
    // next page of the same tab can read.
    report.beacons.push(...(await readBeacons(page)));
  } finally {
    await context.close();
  }
}

/**
 * The beacons the page script recorded before the navigation, now that the
 * next page can read the same sessionStorage (intake-11).
 * @param {Page} page
 * @returns {Promise<Beacon[]>}
 */
async function readBeacons(page) {
  const text = await page.evaluate("sessionStorage.getItem('compat-beacons')");
  if (typeof text !== "string") return [];
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry) =>
      isRecord(entry) &&
      typeof entry.url === "string" &&
      typeof entry.type === "string" &&
      typeof entry.size === "number",
  );
}

/**
 * The cookieless visit in a fresh context: no cookies or storage, as a
 * visitor without consent has.
 * @param {Browser} browser
 * @param {string} userAgent
 * @param {string} pageOrigin
 * @param {string} query
 * @param {string} apiHost
 * @param {ReportParts} report
 * @param {Promise<void>[]} bodyReads
 * @returns {Promise<void>}
 */
async function cookielessVisit(browser, userAgent, pageOrigin, query, apiHost, report, bodyReads) {
  const context = await browser.newContext({ userAgent });
  try {
    const page = await context.newPage();
    watch(page, apiHost, report, bodyReads);
    await page.goto(`${pageOrigin}${PLAN.browser.cookielessPath}${query}`);
    await page.locator("#buy").waitFor({ state: "visible" });
    await page.locator("#buy").click();
    await page.evaluate("posthog.shutdown()");
  } finally {
    await context.close();
  }
}

/**
 * Records every request the page sends to the API and every console error or
 * warning the SDK logs. Response bodies are read only for the config script
 * and /flags, the two answers a check reads.
 * @param {Page} page
 * @param {string} apiHost
 * @param {ReportParts} report
 * @param {Promise<void>[]} bodyReads
 * @returns {void}
 */
function watch(page, apiHost, report, bodyReads) {
  /** @type {Map<Request, Exchange>} */
  const records = new Map();
  page.on("request", (request) => {
    if (!isApiRequest(request.url(), apiHost)) return;
    const url = new URL(request.url());
    const exchange = {
      method: request.method(),
      path: `${url.pathname}${url.search}`,
      status: null,
      contentType: request.headers()["content-type"] ?? null,
      encoding: request.headers()["content-encoding"] ?? null,
      body: null,
    };
    records.set(request, exchange);
    report.exchanges.push(exchange);
  });
  page.on("response", (response) => {
    const exchange = records.get(response.request());
    if (exchange === undefined) return;
    exchange.status = response.status();
    if (hasReadableBody(exchange.path)) {
      bodyReads.push(
        response.text().then(
          (text) => {
            exchange.body = text;
          },
          () => {
            // A body that cannot be read is a failed check, not a failed run.
          },
        ),
      );
    }
  });
  page.on("console", (message) => {
    const type = message.type();
    if (type !== "error" && type !== "warning") return;
    const text = message.text();
    const location = message.location().url;
    if (!/posthog/i.test(text) && !location.startsWith(apiHost)) return;
    report.console.push({ type, text, location });
    if (type === "error") report.errors.push(`${text} (${location})`);
  });
  page.on("pageerror", (error) => {
    report.errors.push(`page error: ${error.message}`);
  });
}

/**
 * Waits for the SDK's recorder to send a snapshot chunk and be answered. The
 * wait ends on the response, so the chunk's status is known before the page
 * navigates and the exchange is complete.
 * @param {Page} page
 * @param {string} apiHost
 * @returns {Promise<void>}
 */
async function chunkSent(page, apiHost) {
  await page.waitForResponse(
    (response) => isChunkRequest(response.request(), apiHost) && response.status() === 200,
    { timeout: CHUNK_TIMEOUT_MS },
  );
}

/**
 * Whether a request is the recorder's chunk post to the Worker.
 * @param {Request} request
 * @param {string} apiHost
 * @returns {boolean}
 */
function isChunkRequest(request, apiHost) {
  return (
    request.method() === "POST" &&
    isApiRequest(request.url(), apiHost) &&
    new URL(request.url()).pathname.startsWith("/s")
  );
}

/**
 * The session id the SDK put on the page's events, once it has one.
 * @param {Page} page
 * @returns {Promise<string | null>}
 */
async function sessionId(page) {
  await page.waitForFunction('typeof posthog.get_session_id() === "string"');
  const value = await page.evaluate("posthog.get_session_id()");
  return typeof value === "string" ? value : null;
}

/**
 * The remote config the SDK read from config.js, as the page holds it.
 * @param {Page} page
 * @param {string} token
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function remoteConfig(page, token) {
  const value = await page.evaluate(
    `window._POSTHOG_REMOTE_CONFIG?.[${JSON.stringify(token)}]?.config ?? null`,
  );
  return isRecord(value) ? value : null;
}

/**
 * A browser presented as a visitor's: full Chromium, the automation flag off.
 * @param {boolean} headless
 * @returns {Promise<Browser>}
 */
async function launch(headless) {
  return await chromium.launch({ headless, channel: "chromium", args: LAUNCH_ARGS });
}

/**
 * The browser's own user agent with "HeadlessChrome" made "Chrome", as a
 * visitor's Chrome of the same version reports it.
 * @param {Browser} browser
 * @returns {Promise<string>}
 */
async function visitorUserAgent(browser) {
  const page = await browser.newPage();
  try {
    const agent = await page.evaluate("navigator.userAgent");
    return typeof agent === "string" ? agent.replace("HeadlessChrome", "Chrome") : "";
  } finally {
    await page.close();
  }
}

/**
 * Whether a request goes to the Worker under test.
 * @param {string} url
 * @param {string} apiHost
 * @returns {boolean}
 */
function isApiRequest(url, apiHost) {
  return url === apiHost || url.startsWith(`${apiHost}/`);
}

/**
 * Whether a response is the SDK's flags answer.
 * @param {import("playwright").Response} response
 * @returns {boolean}
 */
function isFlagsResponse(response) {
  const pathname = new URL(response.url()).pathname;
  return (pathname === "/flags" || pathname === "/flags/") && response.status() === 200;
}

/**
 * @param {string} url
 * @param {string} kind
 * @returns {boolean}
 */
function isStaticScript(url, kind) {
  const pathname = new URL(url).pathname;
  return pathname.startsWith("/static/") && pathname.endsWith(`/${kind}.js`);
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function hasReadableBody(path) {
  const pathname = path.split("?")[0] ?? "";
  return (
    pathname === "/flags" ||
    pathname === "/flags/" ||
    (pathname.startsWith("/array/") && pathname.endsWith("/config.js"))
  );
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
