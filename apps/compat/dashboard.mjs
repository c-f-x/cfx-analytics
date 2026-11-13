// @ts-check

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { POSTHOG_JS_VERSION } from "../../packages/shared/src/posthog.ts";
import { sessionToken } from "../../scripts/lib/ops.mjs";
import { openRunScope } from "../../scripts/lib/run-scope.mjs";
import { failedCount, formatCheck } from "./checks.mjs";
import { runBrowser } from "./clients/browser.mjs";
import { PLAN } from "./plan.mjs";
import { waitFor } from "./store.mjs";
import { applyMigrations, runPnpm, startDev } from "./wrangler.mjs";

// The dashboard end to end (dashboard-05 to dashboard-13): the built app,
// served by the real Worker under wrangler dev, with a product that holds two
// weeks of events from /batch and a real posthog-js visit with its recording
// and heatmap. Playwright visits every screen in light and dark mode, and
// each check prints one line. With --shots, each screen's picture is kept in
// that folder for review; everything else lives in the run scope.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const APP_FOLDER = path.join(ROOT, "apps/worker/assets/app");
const ADMIN = "admin@dashboard.test";
const SESSION_COOKIE = "__Host-cfa_session";
const DAY_MS = 86_400_000;
const HISTORY_DAYS = 14;
const STORED_WAIT_MS = 60_000;
const SCREEN_WAIT_MS = 20_000;
const USAGE = "usage: pnpm e2e [--shots <folder>]";

/** @typedef {import("./checks.mjs").Check} Check */
/** @typedef {import("playwright").Page} Page */
/** @typedef {import("playwright").BrowserContext} BrowserContext */
/** @typedef {{ origin: string, cookie: string }} Api */

/**
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
  const shots = shotsOf(argv);
  if (shots === null) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (shots !== undefined) mkdirSync(shots, { recursive: true });

  const scope = openRunScope({ installExitHandlers: true });
  const stateDir = path.join(scope.dir, "state");
  const appExisted = existsSync(APP_FOLDER);
  /** @type {Check[]} */
  const checks = [];
  let failed = false;
  /** @type {import("playwright").Browser | null} */
  let browser = null;

  try {
    runPnpm(ROOT, ["--filter", "@cfanalytics/web", "build"]);
    applyMigrations({ root: ROOT, stateDir });
    const secret = randomBytes(32).toString("hex");
    const { apiHost: origin } = await startDev({
      root: ROOT,
      scope,
      stateDir,
      vars: (at) => ({ AUTH_SECRET: secret, ADMIN_EMAIL: ADMIN, DASHBOARD_ORIGIN: at }),
    });
    const session = sessionToken(secret, { email: ADMIN, exp: Date.now() + 12 * 3_600_000 });
    const api = { origin, cookie: `${SESSION_COOKIE}=${session}` };

    const shop = await createProduct(api, "E2E Shop", {
      recording_enabled: true,
      heatmaps_enabled: true,
    });
    const seeded = await seedHistory(origin, shop.token, Date.now());
    const visit = await runBrowser({ apiHost: origin, token: shop.token });
    for (const error of visit.errors) console.error(`browser visit: ${error}`);
    const stored = await waitFor(() => storedReady(api, shop.id, seeded), {
      timeoutMs: STORED_WAIT_MS,
      pollMs: 500,
    });
    if (!stored.ready) throw new Error(`the seeded data did not arrive: ${stored.detail}`);

    browser = await chromium.launch({ headless: true, channel: "chromium" });
    checks.push(...(await signedOut(browser, origin)));
    checks.push(...(await phone(browser, api, shop.id, shots)));
    for (const scheme of /** @type {const} */ (["light", "dark"])) {
      // The session cookie is __Host- and Secure, which Chromium will not
      // store for a plain-http origin, so every request carries it as a header.
      const context = await browser.newContext({
        colorScheme: scheme,
        viewport: { width: 1440, height: 960 },
        extraHTTPHeaders: { cookie: api.cookie },
      });
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
      const page = await context.newPage();
      /** @type {string[]} */
      const pageErrors = [];
      page.on("pageerror", (error) =>
        pageErrors.push(`${page.url()}: ${firstLine(error.message)}`),
      );
      // A failed request is a fault unless a check named it as expected, such
      // as the unknown product's designed 404; so is any other console error.
      /** @type {Set<string>} */
      const expectedFailures = new Set();
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const failedUrl = message.text().startsWith("Failed to load resource")
          ? message.location().url
          : null;
        if (failedUrl !== null && [...expectedFailures].some((part) => failedUrl.includes(part))) {
          return;
        }
        pageErrors.push(`${page.url()}: ${firstLine(message.text())} ${failedUrl ?? ""}`.trim());
      });
      const expectFailure = (/** @type {string} */ part) => expectedFailures.add(part);
      const shoot = async (/** @type {string} */ name) => {
        if (shots === undefined) return;
        await page.screenshot({
          path: path.join(shots, `${name}-${scheme}.png`),
          fullPage: true,
          animations: "disabled",
        });
      };
      // The actions that change data run once, in light mode; dark mode
      // visits the same screens to read them.
      const acts = scheme === "light";
      checks.push(...(await screens(page, api, shop, { acts, shoot, expectFailure })));
      checks.push({
        behaviour: "dashboard-13",
        what: `no screen threw an error (${scheme})`,
        passed: pageErrors.length === 0,
        detail: pageErrors.slice(0, 3).join("; "),
      });
      await context.close();
    }
  } catch (error) {
    failed = true;
    console.error(messageOf(error));
  } finally {
    await browser?.close();
  }

  for (const each of checks) console.log(formatCheck(each));
  if (failedCount(checks) > 0) failed = true;
  if (checks.length === 0) failed = true;

  if (!appExisted) rmSync(APP_FOLDER, { recursive: true, force: true });
  const { leftovers } = await scope.close();
  if (leftovers.length > 0) {
    failed = true;
    console.error(`left behind: ${leftovers.join(", ")}`);
  }
  if (failed) process.exitCode = 1;
}

/**
 * The folder named by --shots, undefined without it, or null for other arguments.
 * @param {string[]} argv
 * @returns {string | undefined | null}
 */
function shotsOf(argv) {
  if (argv.length === 0) return undefined;
  if (argv.length === 2 && argv[0] === "--shots" && argv[1] !== undefined && argv[1] !== "") {
    return path.resolve(argv[1]);
  }
  return null;
}

/**
 * One call to the dashboard's API with the session and the dashboard's origin.
 * @param {Api} api
 * @param {string} method
 * @param {string} where
 * @param {unknown} [body]
 * @returns {Promise<Response>}
 */
async function call(api, method, where, body) {
  /** @type {RequestInit} */
  const init = {
    method,
    headers: { cookie: api.cookie, origin: api.origin, "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return await fetch(`${api.origin}${where}`, init);
}

/**
 * @param {Api} api
 * @param {string} method
 * @param {string} where
 * @param {unknown} [body]
 * @returns {Promise<Record<string, unknown>>}
 */
async function callJson(api, method, where, body) {
  const response = await call(api, method, where, body);
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${method} ${where} answered ${String(response.status)}: ${text}`);
  const parsed = /** @type {unknown} */ (JSON.parse(text));
  if (!isRecord(parsed)) throw new Error(`${method} ${where} answered no object`);
  return parsed;
}

/**
 * @param {Api} api
 * @param {string} name
 * @param {Record<string, unknown>} settings
 * @returns {Promise<{ id: string, token: string, name: string }>}
 */
async function createProduct(api, name, settings) {
  const made = await callJson(api, "POST", "/api/projects", { name, settings });
  if (typeof made.id !== "string" || typeof made.token !== "string") {
    throw new Error("the create answer named no id or token");
  }
  return { id: made.id, token: made.token, name };
}

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const PAGES = ["/", "/pricing", "/docs", "/blog/launch", "/signup"];
const REFERRERS = [
  "https://www.google.com/",
  "https://news.ycombinator.com/",
  "",
  "https://duckduckgo.com/",
  "https://github.com/",
];

/**
 * A small seeded random source, so every run seeds the same history.
 * @param {number} seed
 * @returns {() => number}
 */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Two weeks of visits through /batch, each event at its own past time: page
 * views from several sources, and a signup funnel some visitors finish.
 * Answers how many events were sent.
 * @param {string} origin
 * @param {string} token
 * @param {number} now
 * @returns {Promise<number>}
 */
async function seedHistory(origin, token, now) {
  const random = seededRandom(42);
  const pick = (/** @type {readonly string[]} */ list) =>
    list[Math.floor(random() * list.length)] ?? list[0] ?? "";
  /** @type {Record<string, unknown>[]} */
  const events = [];
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  for (let day = HISTORY_DAYS - 1; day >= 0; day -= 1) {
    const visitors = 18 + Math.round(10 * Math.sin(day / 2) + random() * 8);
    for (let index = 0; index < visitors; index += 1) {
      const distinctId = `visitor-${String(day)}-${String(index)}`;
      const sessionId = randomUUID();
      const referrer = pick(REFERRERS);
      let at = today - day * DAY_MS + Math.floor(random() * 20 * 3_600_000);
      if (at > now - 60_000) at = now - 60_000 - Math.floor(random() * 3_600_000);
      const views = 1 + Math.floor(random() * 4);
      const base = {
        distinct_id: distinctId,
        $session_id: sessionId,
        $referrer: referrer === "" ? "$direct" : referrer,
        $referring_domain: referrer === "" ? "$direct" : new URL(referrer).hostname,
        $device_type: random() < 0.3 ? "Mobile" : "Desktop",
        $browser: random() < 0.7 ? "Chrome" : "Safari",
        $os: random() < 0.6 ? "Mac OS X" : "Windows",
        $lib: "web",
      };
      for (let view = 0; view < views; view += 1) {
        const pathname = view === 0 ? pick(PAGES.slice(0, 3)) : pick(PAGES);
        events.push(
          event("$pageview", base, at, {
            $pathname: pathname,
            $current_url: `https://shop.example${pathname}`,
            $host: "shop.example",
          }),
        );
        at += 30_000 + Math.floor(random() * 120_000);
      }
      if (random() < 0.35) {
        events.push(event("signup_started", base, at, { $pathname: "/signup" }));
        if (random() < 0.5)
          events.push(event("signup_done", base, at + 45_000, { $pathname: "/signup" }));
      }
    }
  }
  for (let start = 0; start < events.length; start += 200) {
    const response = await fetch(`${origin}/batch/`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": CHROME_UA },
      body: JSON.stringify({
        api_key: token,
        batch: events.slice(start, start + 200),
        sent_at: new Date(now).toISOString(),
      }),
    });
    if (!response.ok)
      throw new Error(`/batch/ answered ${String(response.status)}: ${await response.text()}`);
  }
  return events.length;
}

/**
 * @param {string} name
 * @param {{ distinct_id: string } & Record<string, unknown>} base
 * @param {number} at
 * @param {Record<string, unknown>} properties
 * @returns {Record<string, unknown>}
 */
function event(name, base, at, properties) {
  const { distinct_id: distinctId, ...shared } = base;
  return {
    event: name,
    distinct_id: distinctId,
    uuid: randomUUID(),
    timestamp: new Date(at).toISOString(),
    properties: { ...shared, ...properties },
  };
}

/**
 * Whether the product holds what the screens are checked against: the seeded
 * events, the browser's recording and its heatmap points.
 * @param {Api} api
 * @param {string} id
 * @param {number} seededCount
 * @returns {Promise<{ ready: boolean, detail: string }>}
 */
async function storedReady(api, id, seededCount) {
  /** @type {string[]} */
  const missing = [];
  const trend = await callJson(api, "POST", `/api/projects/${id}/query`, {
    kind: "trend",
    measure: "events",
    granularity: "day",
    range: { kind: "last_days", days: 30 },
  });
  const total = totalOf(trend);
  if (total < seededCount) missing.push(`events (${String(total)} of ${String(seededCount)})`);
  const recordings = await callJson(api, "GET", `/api/projects/${id}/recordings`);
  if (!Array.isArray(recordings.recordings) || recordings.recordings.length === 0) {
    missing.push("a recording");
  }
  const heatmap = await callJson(api, "POST", `/api/projects/${id}/heatmap`, {
    range: { kind: "last_days", days: 1 },
    path: PLAN.browser.pagePath,
  });
  const result = isRecord(heatmap.result) ? heatmap.result : {};
  if (!Array.isArray(result.bands) || result.bands.length === 0) missing.push("heatmap points");
  return { ready: missing.length === 0, detail: missing.join(", ") };
}

/**
 * A trend answer's first series total, or 0.
 * @param {Record<string, unknown>} answer
 * @returns {number}
 */
function totalOf(answer) {
  const result = isRecord(answer.result) ? answer.result : {};
  const series = Array.isArray(result.series) ? result.series : [];
  const first = /** @type {unknown} */ (series[0]);
  return isRecord(first) && typeof first.total === "number" ? first.total : 0;
}

/**
 * dashboard-05: without a session, the page is the sign-in screen and the API
 * answers 401.
 * @param {import("playwright").Browser} browser
 * @param {string} origin
 * @returns {Promise<Check[]>}
 */
async function signedOut(browser, origin) {
  const context = await browser.newContext();
  const page = await context.newPage();
  /** @type {Check[]} */
  const checks = [];
  try {
    for (const where of ["/", "/projects", "/p/anything/settings"]) {
      await page.goto(`${origin}${where}`);
      const shown = await visible(
        page.getByRole("heading", { name: /How your products are doing/ }),
      );
      const notSetUp = await visible(page.getByText("Sign-in is not set up yet"));
      checks.push({
        behaviour: "dashboard-05",
        what: `${where} without a session shows the sign-in page, saying it is not set up`,
        passed: shown && notSetUp,
        detail: shown && notSetUp ? "" : `sign-in ${String(shown)}, not set up ${String(notSetUp)}`,
      });
    }
    const response = await fetch(`${origin}/api/projects`);
    checks.push({
      behaviour: "dashboard-05",
      what: "the API without a session answers 401",
      passed: response.status === 401,
      detail: `status ${String(response.status)}`,
    });
  } finally {
    await context.close();
  }
  return checks;
}

/**
 * dashboard-14: at a phone's width the rail is a drawer behind "Menu", and
 * moving to a place closes it.
 * @param {import("playwright").Browser} browser
 * @param {Api} api
 * @param {string} id
 * @param {string | undefined} shots
 * @returns {Promise<Check[]>}
 */
async function phone(browser, api, id, shots) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: { cookie: api.cookie },
  });
  const page = await context.newPage();
  /** @type {Check[]} */
  const checks = [];
  const shoot = async (/** @type {string} */ name) => {
    if (shots === undefined) return;
    await page.screenshot({ path: path.join(shots, `${name}-phone.png`) });
  };
  try {
    await check(
      checks,
      "dashboard-14",
      "on a phone the rail is a drawer, and moving to a place closes it",
      async () => {
        await page.goto(`${api.origin}/p/${id}`);
        if (!(await visible(page.getByText("Visitors", { exact: true })))) return "no board";
        await shoot("board");
        await page.getByRole("button", { name: "Menu" }).click();
        const drawer = page.getByRole("dialog");
        if (!(await visible(drawer.getByRole("link", { name: "Recordings" })))) return "no drawer";
        await shoot("menu");
        await drawer.getByRole("link", { name: "Recordings" }).click();
        await page.waitForURL(/\/recordings/, { timeout: SCREEN_WAIT_MS });
        await drawer.waitFor({ state: "hidden", timeout: SCREEN_WAIT_MS });
        return "";
      },
      shoot,
    );
  } finally {
    await context.close();
  }
  return checks;
}

/**
 * Whether `locator` becomes visible before the screen deadline.
 * @param {import("playwright").Locator} locator
 * @returns {Promise<boolean>}
 */
async function visible(locator) {
  try {
    await locator.first().waitFor({ state: "visible", timeout: SCREEN_WAIT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs one screen's check: `body` answers "" when it passed, else what was wrong.
 * A thrown error fails the check with its message.
 * @param {Check[]} checks
 * @param {string} behaviour
 * @param {string} what
 * @param {() => Promise<string>} body
 * @param {(name: string) => Promise<void>} [shoot] takes the screen's picture when the check fails
 * @returns {Promise<void>}
 */
async function check(checks, behaviour, what, body, shoot) {
  let detail;
  try {
    detail = await body();
  } catch (error) {
    detail = firstLine(messageOf(error)) || "it threw";
  }
  checks.push({ behaviour, what, passed: detail === "", detail });
  if (detail !== "") await shoot?.(`failed-${behaviour}-${String(checks.length)}`);
}

/**
 * Every screen with a session, its picture taken once it has drawn.
 * @param {Page} page
 * @param {Api} api
 * @param {{ id: string, token: string, name: string }} shop
 * @param {{ acts: boolean, shoot: (name: string) => Promise<void>, expectFailure: (urlPart: string) => void }} options
 * @returns {Promise<Check[]>}
 */
async function screens(page, api, shop, { acts, shoot, expectFailure }) {
  /** @type {Check[]} */
  const checks = [];
  const { origin } = api;
  const product = `${origin}/p/${shop.id}`;
  const mode = acts ? "light" : "dark";
  /** @type {(behaviour: string, what: string, body: () => Promise<string>) => Promise<void>} */
  const checkWith = (behaviour, what, body) => check(checks, behaviour, what, body, shoot);

  // What a new product's dialog and its empty board both show (dashboard-12):
  // the install line for the posthog-js version the Worker serves (D-15),
  // then the snippet with this deployment's address, then a link to Settings,
  // where recording and heatmaps start off.
  const installProblems = async (/** @type {string} */ where) => {
    const blocks = await page.locator("pre").allTextContents();
    const install = `npm install --save-exact posthog-js@${POSTHOG_JS_VERSION}`;
    if (blocks[0]?.trim() !== install) return `${where}'s install line reads "${blocks[0]}"`;
    const snippet = blocks[1] ?? "";
    if (!snippet.includes("posthog.init(") || !snippet.includes(origin)) {
      return `${where}'s snippet reads "${snippet}"`;
    }
    const settings = page.getByRole("link", { name: "Turn them on in Settings" });
    if (!(await visible(settings))) return `${where} does not say recording and heatmaps are off`;
    const href = (await settings.getAttribute("href")) ?? "";
    return href.endsWith("/settings") ? "" : `${where}'s Settings link goes to "${href}"`;
  };

  await checkWith(
    "dashboard-12",
    `All products lists the product with its visitors (${mode})`,
    async () => {
      await page.goto(`${origin}/projects`);
      if (!(await visible(page.getByText(shop.name)))) return "the product is not listed";
      const row = page.getByRole("link", { name: new RegExp(shop.name) });
      const figure = row.locator("span.tabular-nums").first();
      await figure.waitFor({ timeout: SCREEN_WAIT_MS });
      const text = (await figure.textContent()) ?? "";
      await shoot("products");
      return Number(text.replace(/[^0-9]/g, "")) > 0 ? "" : `visitors read "${text}"`;
    },
  );

  if (acts) {
    await checkWith(
      "dashboard-12",
      "a new product's dialog and empty board show the pinned install line, the snippet, and that recording and heatmaps are off",
      async () => {
        await page.getByRole("button", { name: "New product" }).first().click();
        await page.getByLabel("Name").fill("Empty site");
        await page.getByRole("button", { name: "Add product" }).click();
        if (!(await visible(page.getByText("Empty site is ready")))) return "no ready dialog";
        await shoot("new-product");
        const dialog = await installProblems("the dialog");
        if (dialog !== "") return dialog;
        await page.getByRole("button", { name: "Open the board" }).click();
        if (!(await visible(page.getByText("No events yet")))) {
          return "the new product's board shows no install panel";
        }
        return installProblems("the empty board");
      },
    );
    await shoot("board-empty");
  }

  await checkWith(
    "dashboard-06",
    `the board shows the tiles with the API's numbers (${mode})`,
    async () => {
      await page.goto(product);
      for (const title of ["Visitors", "Page views", "Sessions", "Pages", "Sources", "Devices"]) {
        if (!(await visible(page.getByText(title, { exact: true })))) return `no ${title} tile`;
      }
      if (!(await visible(page.getByText("/pricing"))))
        return "the Pages tile lists no seeded page";
      await page.waitForLoadState("networkidle");
      await shoot("board");
      return "";
    },
  );

  if (acts) {
    await checkWith(
      "dashboard-06",
      "the period and a filter change the board and stay in the address",
      async () => {
        await page.getByLabel("Period").click();
        await page.getByRole("option", { name: "Last 30 days" }).click();
        await page.waitForURL(/period=30d/, { timeout: SCREEN_WAIT_MS });
        await page
          .getByRole("button", { name: /\/pricing/ })
          .first()
          .click();
        await page.waitForURL(/filters=/, { timeout: SCREEN_WAIT_MS });
        const chip = await visible(page.getByText("/pricing", { exact: false }));
        await shoot("board-filtered");
        return chip ? "" : "no filter chip";
      },
    );

    await checkWith("dashboard-07", "a saved funnel is added at the end of the board", async () => {
      await page.goto(`${product}/questions/new`);
      await page.getByLabel("Title").fill("Visit to leave");
      await page.getByRole("tab", { name: "Funnel" }).click();
      await page.waitForLoadState("networkidle");
      await shoot("editor");
      await page.getByRole("button", { name: "Save to board" }).click();
      await page.waitForURL(new RegExp(`/p/${shop.id}(\\?|$)`), { timeout: SCREEN_WAIT_MS });
      const tiles = await callJson(api, "GET", `/api/projects/${shop.id}/tiles`);
      const list = Array.isArray(tiles.tiles) ? tiles.tiles : [];
      const last = /** @type {unknown} */ (list.at(-1));
      return isRecord(last) && last.title === "Visit to leave"
        ? ""
        : "the funnel is not the last tile";
    });

    await checkWith(
      "dashboard-06",
      "Open page on a page row goes to that page in Pages",
      async () => {
        await page.goto(product);
        const row = page.getByRole("row", { name: /\/pricing/ }).first();
        await row.hover();
        await row.getByRole("button", { name: "Open /pricing" }).click();
        await page.waitForURL(/\/pages\//, { timeout: SCREEN_WAIT_MS });
        return (await visible(page.getByRole("heading", { name: "/pricing" })))
          ? ""
          : "the page did not open";
      },
    );

    await checkWith("dashboard-07", "a removed standard tile can be restored", async () => {
      await page.goto(product);
      await page.getByRole("button", { name: "Devices: more" }).click();
      await page.getByRole("menuitem", { name: "Remove from board" }).click();
      const restore = page.getByText("Restore standard tiles").first();
      if (!(await visible(restore))) return "no restore link after a removal";
      await restore.click();
      return (await visible(page.getByText("Devices", { exact: true })))
        ? ""
        : "Devices did not come back";
    });
  }

  await checkWith(
    "dashboard-08",
    `Pages ranks the pages, and a page shows its heatmap, scroll depth and recordings (${mode})`,
    async () => {
      await page.goto(`${product}/pages`);
      if (!(await visible(page.getByText(PLAN.browser.pagePath))))
        return "the visited page is not listed";
      await shoot("pages");
      await page.getByText(PLAN.browser.pagePath).first().click();
      await page.waitForLoadState("networkidle");
      const marks = page.locator("span.rounded-full[title]");
      await marks.first().waitFor({ timeout: SCREEN_WAIT_MS });
      await shoot("page-heatmap");
      await page.getByRole("tab", { name: "Scroll depth" }).click();
      if (!(await visible(page.getByText("10%", { exact: true })))) return "no scroll depth bars";
      await shoot("page-scroll");
      await page.getByRole("tab", { name: "Recordings" }).click();
      if (!(await visible(page.getByRole("columnheader", { name: "Started" }))))
        return "no recordings on the page";
      return "";
    },
  );

  await checkWith(
    "dashboard-09",
    `Recordings lists the session, and it plays beside its events in plain words, with marks on its timeline (${mode})`,
    async () => {
      await page.goto(`${product}/recordings`);
      const row = page.locator("tbody tr").first();
      await row.waitFor({ timeout: SCREEN_WAIT_MS });
      await shoot("recordings");
      await row.click();
      if (!(await visible(page.getByRole("button", { name: "Play" })))) return "no player";
      if (!(await visible(page.getByText("Events in this session")))) return "no session events";
      await page.locator("iframe").first().waitFor({ timeout: SCREEN_WAIT_MS });
      // The events in plain words (recordings-37), each page view and click a
      // mark on the timeline, and a mark moves the player and the highlight.
      const list = page.locator("ol li button");
      await list.first().waitFor({ timeout: SCREEN_WAIT_MS });
      const labels = (await list.allTextContents()).map((text) => text.replace(/^\d+[smh]\s*/, ""));
      if (!labels.some((label) => label.startsWith("Opened /"))) {
        return `no page view in plain words: ${labels.join("; ")}`;
      }
      if (!labels.some((label) => label.startsWith("Clicked '"))) {
        return `no click in plain words: ${labels.join("; ")}`;
      }
      if (labels.some((label) => label.startsWith("$"))) {
        return `a raw event name is listed: ${labels.join("; ")}`;
      }
      const marked = labels.filter((label) =>
        /^(Opened|Clicked|Rage-clicked|Submitted)/.test(label),
      );
      const marks = page.getByRole("button", {
        name: /^\d+[smh], (Opened|Clicked|Rage-clicked|Submitted)/,
      });
      if ((await marks.count()) !== marked.length) {
        return `${String(await marks.count())} marks for ${String(marked.length)} page views and clicks`;
      }
      const last = marks.last();
      const name = (await last.getAttribute("aria-label")) ?? "";
      await last.click();
      const at = name.split(",")[0] ?? "";
      const readout = page.getByText(new RegExp(`^${at} / `));
      if (!(await visible(readout))) return `the player did not move to ${at}`;
      // The highlight follows the player, so wait for the row the mark names.
      const label = name.slice(at.length + 2);
      const current = page.locator('ol li button[aria-current="true"]', { hasText: label });
      if (!(await visible(current))) {
        const shown = await page.locator('ol li button[aria-current="true"]').allTextContents();
        return `the highlighted row reads "${shown.join("; ")}", not "${name}"`;
      }
      await shoot("player");
      return "";
    },
  );

  await checkWith(
    "dashboard-10",
    `Events lists the newest events, and Properties the names seen (${mode})`,
    async () => {
      await page.goto(`${product}/events`);
      if (!(await visible(page.getByText("$pageview")))) return "no $pageview listed";
      await shoot("events");
      await page.getByRole("tab", { name: "Properties" }).click();
      if (!(await visible(page.getByText("$pathname", { exact: true }))))
        return "no $pathname property";
      await shoot("properties");
      return "";
    },
  );

  await checkWith("dashboard-11", `Settings reads the product (${mode})`, async () => {
    await page.goto(`${product}/settings`);
    if (!(await visible(page.getByText("What is collected")))) return "no settings sections";
    await shoot("settings");
    return "";
  });

  if (acts) {
    await checkWith(
      "dashboard-11",
      "a your-own-traffic rule keeps the type of its value",
      async () => {
        await page.goto(`${product}/settings`);
        await page.getByLabel("Whose property").selectOption("event_property");
        await page.getByLabel("Property", { exact: true }).fill("plan_tier");
        await page.getByLabel("Value type").selectOption("number");
        await page.getByLabel("Value", { exact: true }).fill("42");
        await page.getByRole("button", { name: "Add rule" }).click();
        await page.getByRole("button", { name: "Save changes" }).click();
        if (!(await visible(page.getByText("Settings saved")))) return "no saved notice";
        const project = await callJson(api, "GET", `/api/projects/${shop.id}`);
        const settings = isRecord(project.settings) ? project.settings : {};
        const rules = Array.isArray(settings.internal_rules) ? settings.internal_rules : [];
        const saved = rules.find((rule) => isRecord(rule) && rule.property === "plan_tier");
        return isRecord(saved) && saved.value === 42
          ? ""
          : `the rule saved as ${JSON.stringify(saved)}`;
      },
    );

    await checkWith("dashboard-11", "a changed setting is saved and read back", async () => {
      const before = await callJson(api, "GET", `/api/projects/${shop.id}`);
      const was = isRecord(before.settings) ? before.settings.dead_clicks_enabled : undefined;
      await page.getByRole("switch", { name: "Dead clicks" }).click();
      await page.getByRole("button", { name: "Save changes" }).click();
      if (!(await visible(page.getByText("Settings saved")))) return "no saved notice";
      const after = await callJson(api, "GET", `/api/projects/${shop.id}`);
      const now = isRecord(after.settings) ? after.settings.dead_clicks_enabled : undefined;
      return typeof was === "boolean" && now === !was
        ? ""
        : `dead clicks went from ${String(was)} to ${String(now)}`;
    });

    await checkWith(
      "dashboard-11",
      "a new key is shown once, and revoking it asks first",
      async () => {
        await page.getByLabel("Key label").fill("Owner panel");
        await page.getByRole("button", { name: "New key" }).click();
        if (!(await visible(page.getByText("Copy the key now")))) return "no key dialog";
        await shoot("settings-key");
        await page.getByRole("button", { name: "Copy and close" }).click();
        if (!(await visible(page.getByText("Owner panel")))) return "the key is not listed";
        await page.getByRole("button", { name: "Revoke", exact: true }).click();
        if (!(await visible(page.getByText("Revoke Owner panel?"))))
          return "revoking did not ask first";
        await page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
        return (await visible(page.getByText("No keys."))) ? "" : "the key is still listed";
      },
    );

    await checkWith("dashboard-11", "deleting a product needs its name typed", async () => {
      const products = await callJson(api, "GET", "/api/projects");
      const list = Array.isArray(products.projects) ? products.projects : [];
      const empty = /** @type {unknown} */ (
        list.find((each) => isRecord(each) && each.name === "Empty site")
      );
      if (!isRecord(empty) || typeof empty.id !== "string") return "no Empty site product";
      await page.goto(`${origin}/p/${empty.id}/settings`);
      await page.getByRole("button", { name: "More" }).click();
      await page.getByRole("menuitem", { name: "Delete product" }).click();
      const confirm = page.getByRole("dialog").getByRole("button", { name: "Delete product" });
      if (!(await confirm.isDisabled())) return "Delete is enabled before the name is typed";
      await page.getByLabel("The product's name").fill("Empty site");
      await shoot("settings-delete");
      await confirm.click();
      await page.waitForURL(/\/projects/, { timeout: SCREEN_WAIT_MS });
      const after = await callJson(api, "GET", "/api/projects");
      const left = Array.isArray(after.projects) ? after.projects : [];
      return left.some((each) => isRecord(each) && each.name === "Empty site")
        ? "the product is still listed"
        : "";
    });
  }

  await checkWith(
    "dashboard-13",
    `an unknown product shows a designed page (${mode})`,
    async () => {
      expectFailure("/api/projects/no-such-product");
      await page.goto(`${origin}/p/no-such-product`);
      if (!(await visible(page.getByText("No such product")))) return "no missing-product page";
      await shoot("error");
      return "";
    },
  );

  if (acts) {
    // Last, since it ends this page's session.
    await checkWith(
      "dashboard-05",
      "a session that ends while a screen is open leads to the sign-in page",
      async () => {
        await page.goto(product);
        if (!(await visible(page.getByText("Visitors", { exact: true })))) return "no board";
        // Every call after this answers 401, by design.
        expectFailure("/api/");
        await page.setExtraHTTPHeaders({ cookie: "__Host-cfa_session=ended.session" });
        await page.getByRole("link", { name: "Events", exact: true }).click();
        const signIn = page.getByRole("heading", { name: /How your products are doing/ });
        return (await visible(signIn)) ? "" : "the screen did not lead to sign-in";
      },
    );
  }

  return checks;
}

/**
 * @param {string} text
 * @returns {string}
 */
function firstLine(text) {
  return text.split("\n")[0] ?? "";
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

await main(process.argv.slice(2));
