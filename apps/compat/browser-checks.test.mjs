// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import { browserChecks, failedCount } from "./checks.mjs";
import { PLAN } from "./plan.mjs";

const MAIN_SESSION = "11111111-1111-4111-8111-111111111111";
const HEADED_SESSION = "22222222-2222-4222-8222-222222222222";
const STARS = "*".repeat(PLAN.browser.typedText.length);

/**
 * @param {string} name
 * @param {Record<string, unknown>} properties
 * @param {string} [distinctId]
 * @returns {import("./checks.mjs").StoredEvent}
 */
function event(name, properties, distinctId = "anon-1") {
  return {
    uuid: `${name}-${distinctId}`,
    event: name,
    distinctId,
    personId: null,
    ts: 1_700_000_000_000,
    properties: { $lib: "web", ...properties },
  };
}

/**
 * @param {Partial<import("./checks.mjs").Exchange>} overrides
 * @returns {import("./checks.mjs").Exchange}
 */
function exchange(overrides) {
  return {
    method: "GET",
    path: "/",
    status: 200,
    contentType: null,
    encoding: null,
    body: null,
    ...overrides,
  };
}

/** The requests a healthy posthog-js run makes. */
function exchanges() {
  return [
    exchange({ path: "/array/cfa_pk_token/config.js", contentType: "text/javascript" }),
    exchange({
      method: "POST",
      path: "/flags/?v=2&config=true",
      contentType: "application/json",
      body: JSON.stringify({
        flags: {},
        featureFlags: {},
        featureFlagPayloads: {},
        errorsWhileComputingFlags: false,
      }),
    }),
    exchange({
      path: "/static/1.438.12/lazy-recorder.js",
      contentType: "text/javascript",
    }),
    exchange({ method: "POST", path: "/e/", contentType: "text/plain" }),
    exchange({ method: "POST", path: "/s/", contentType: "text/plain" }),
  ];
}

/**
 * The rows and report a healthy posthog-js run leaves.
 * @returns {{ observations: import("./checks.mjs").Observations, report: import("./checks.mjs").SdkReport }}
 */
function healthy() {
  return {
    observations: {
      events: [
        event("$pageview", {}),
        event("$autocapture", { $elements_chain: "div > button" }),
        event("$pageleave", { $prev_pageview_max_scroll: 2000 }),
        event("$pageview", { $cookieless_mode: true }, "cookieless_0123456789abcdef"),
      ],
      links: [],
      points: [
        {
          eventUuid: "heatmap-1",
          seq: 0,
          host: "127.0.0.1:8080",
          path: PLAN.browser.pagePath,
          widthBand: 1200,
          x: 100,
          y: 200,
          kind: "click",
          fixed: false,
          bot: false,
          ts: 1_700_000_000_000,
          sessionId: MAIN_SESSION,
          distinctId: "anon-1",
        },
      ],
      chunks: [
        {
          uuid: "chunk-1",
          sessionId: MAIN_SESSION,
          objectKey: "p-1/s-1/1.ndjson.gz",
          firstTs: 100,
          lastTs: 110,
          byteSize: 1,
          snapshotPath: PLAN.browser.pagePath,
          snapshotWidth: 1280,
        },
        {
          uuid: "chunk-2",
          sessionId: MAIN_SESSION,
          objectKey: "p-1/s-1/2.ndjson.gz",
          firstTs: 200,
          lastTs: 210,
          byteSize: 1,
          snapshotPath: PLAN.browser.pagePath,
          snapshotWidth: 1280,
        },
      ],
      objects: [
        {
          key: "p-1/s-1/1.ndjson.gz",
          bytes: new Uint8Array(),
          events: [
            { type: 2, timestamp: 100 },
            { type: 3, timestamp: 110, data: { source: 5, text: STARS } },
          ],
        },
        {
          key: "p-1/s-1/2.ndjson.gz",
          bytes: new Uint8Array(),
          events: [{ type: 4, timestamp: 200 }],
        },
      ],
    },
    report: {
      sdk: "browser",
      errors: [],
      console: [],
      exchanges: exchanges(),
      beacons: [
        {
          url: "http://api.test/e/?compression=base64",
          type: "application/x-www-form-urlencoded",
          size: 120,
        },
      ],
      config: { elementsChainAsString: true, sessionRecording: { endpoint: "/s/" } },
      sessionIds: { main: MAIN_SESSION, headed: HEADED_SESSION },
    },
  };
}

/**
 * @param {import("./checks.mjs").Check[]} checks
 * @param {string} behaviour
 * @returns {import("./checks.mjs").Check}
 */
function byId(checks, behaviour) {
  const found = checks.find((check) => check.behaviour === behaviour);
  assert.ok(found, `no check named ${behaviour}`);
  return found;
}

void test("every browser check passes on the rows a healthy run leaves", () => {
  const { observations, report } = healthy();
  const checks = browserChecks(observations, report);
  assert.equal(failedCount(checks), 0, JSON.stringify(checks.filter((check) => !check.passed)));
  assert.deepEqual(
    checks.map((check) => check.behaviour),
    [
      "config-03",
      "config-05",
      "config-09",
      "config-29",
      "intake-01",
      "intake-10",
      "intake-11",
      "recordings-01",
      "recordings-02",
      "heatmaps-01",
      "heatmaps-20",
      "cookieless-01",
    ],
  );
});

void test("a /flags answer without the four keys fails config-03 and says how many answers came", () => {
  const { observations, report } = healthy();
  for (const entry of report.exchanges ?? []) {
    if (entry.path.startsWith("/flags")) entry.body = JSON.stringify({ flags: {} });
  }
  const checks = browserChecks(observations, report);
  assert.equal(byId(checks, "config-03").passed, false);
  assert.match(byId(checks, "config-03").detail, /1 \/flags answers/);
  assert.equal(byId(checks, "config-05").passed, true);
});

void test("a missing lazy recorder fails config-05 and config-29 alone", () => {
  const { observations, report } = healthy();
  report.exchanges = (report.exchanges ?? []).filter(
    (entry) => !entry.path.endsWith("/lazy-recorder.js"),
  );
  const checks = browserChecks(observations, report);
  assert.equal(byId(checks, "config-05").passed, false);
  assert.equal(byId(checks, "config-29").passed, false);
  assert.equal(byId(checks, "config-03").passed, true);
});

void test("a console error fails every check that asks for a clean console", () => {
  const { observations, report } = healthy();
  report.console = [{ type: "error", text: "PostHog failed to load", location: "http://api.test" }];
  const checks = browserChecks(observations, report);
  assert.equal(byId(checks, "config-03").passed, false);
  assert.equal(byId(checks, "config-05").passed, false);
  assert.equal(byId(checks, "config-29").passed, false);
  assert.equal(byId(checks, "intake-01").passed, true);
});

void test("an $autocapture without a string elements chain fails config-09", () => {
  const { observations, report } = healthy();
  observations.events[1] = event("$autocapture", { $elements: [] });
  const checks = browserChecks(observations, report);
  assert.equal(byId(checks, "config-09").passed, false);
  assert.equal(byId(checks, "intake-01").passed, true);
});

void test("a capture without text/plain fails intake-10, and one without a form body fails intake-11", () => {
  const first = healthy();
  first.report.exchanges = (first.report.exchanges ?? []).filter(
    (entry) => entry.contentType !== "text/plain" || !entry.path.startsWith("/e"),
  );
  const checks = browserChecks(first.observations, first.report);
  assert.equal(byId(checks, "intake-10").passed, false);
  assert.equal(byId(checks, "intake-11").passed, true);

  const second = healthy();
  second.report.beacons = [];
  const other = browserChecks(second.observations, second.report);
  assert.equal(byId(other, "intake-11").passed, false);
  assert.equal(byId(other, "intake-10").passed, true);
});

void test("a base64 form beacon whose pageleave row never arrived fails intake-11 and says so", () => {
  const { observations, report } = healthy();
  observations.events = observations.events.filter((row) => row.event !== "$pageleave");
  const checks = browserChecks(observations, report);
  assert.equal(byId(checks, "intake-11").passed, false);
  assert.match(byId(checks, "intake-11").detail, /no \$pageleave row/);
});

void test("a chunk without its R2 object fails recordings-01 and says which part is missing", () => {
  const { observations, report } = healthy();
  observations.objects.pop();
  const checks = browserChecks(observations, report);
  assert.equal(byId(checks, "recordings-01").passed, false);
  assert.match(
    byId(checks, "recordings-01").detail,
    /2 chunks, 2 events, a chunk's object is missing/,
  );
});

void test("plaintext in a recording fails recordings-02", () => {
  const { observations, report } = healthy();
  const object = observations.objects[0];
  assert.ok(object);
  object.events.push({
    type: 3,
    timestamp: 120,
    data: { source: 5, text: PLAN.browser.typedText },
  });
  const checks = browserChecks(observations, report);
  assert.equal(byId(checks, "recordings-02").passed, false);
  assert.match(byId(checks, "recordings-02").detail, /typed text appears/);
});

void test("a $$heatmap event row fails heatmaps-01, and so does a page with no click points", () => {
  const withRow = healthy();
  withRow.observations.events.push(event("$$heatmap", { $heatmap_data: {} }));
  assert.equal(
    byId(browserChecks(withRow.observations, withRow.report), "heatmaps-01").passed,
    false,
  );

  const noClick = healthy();
  noClick.observations.points = [];
  assert.equal(
    byId(browserChecks(noClick.observations, noClick.report), "heatmaps-01").passed,
    false,
  );
});

void test("a pageleave without the scroll depth fails heatmaps-20", () => {
  const { observations, report } = healthy();
  observations.events[2] = event("$pageleave", { $prev_pageview_max_scroll: 500 });
  const checks = browserChecks(observations, report);
  assert.equal(byId(checks, "heatmaps-20").passed, false);
  assert.match(byId(checks, "heatmaps-20").detail, /500/);
});

void test("a stored sentinel fails cookieless-01 and says so", () => {
  const { observations, report } = healthy();
  observations.events.push(event("$pageview", { $cookieless_mode: true }, "$posthog_cookieless"));
  const checks = browserChecks(observations, report);
  assert.equal(byId(checks, "cookieless-01").passed, false);
  assert.match(byId(checks, "cookieless-01").detail, /the sentinel is stored/);
});
