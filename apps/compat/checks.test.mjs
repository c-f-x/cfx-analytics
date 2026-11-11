// @ts-check

import assert from "node:assert/strict";
import test from "node:test";
import { failedCount, formatCheck, iosChecks, nodeChecks } from "./checks.mjs";
import { PLAN } from "./plan.mjs";

/**
 * @param {string} name
 * @param {string} distinctId
 * @param {number | null} personId
 * @param {unknown} library
 * @returns {import("./checks.mjs").StoredEvent}
 */
function event(name, distinctId, personId, library = "posthog-node") {
  return {
    uuid: `${name}-${distinctId}`,
    event: name,
    distinctId,
    personId,
    ts: 1,
    properties: { $lib: library },
  };
}

/** The rows a healthy posthog-node run leaves behind. */
function healthy() {
  const person = 7;
  const plan = PLAN.node;
  return {
    events: [
      event(plan.event, plan.anonymousId, person),
      event("$identify", plan.user, person),
      event("$create_alias", plan.user, person),
    ],
    links: [
      { distinctId: plan.anonymousId, personId: person },
      { distinctId: plan.user, personId: person },
      { distinctId: plan.alias, personId: person },
    ],
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

void test("every node check passes on the rows a healthy run leaves", () => {
  const checks = nodeChecks(healthy());
  assert.equal(failedCount(checks), 0, JSON.stringify(checks.filter((check) => !check.passed)));
  assert.deepEqual(
    checks.map((check) => check.behaviour),
    ["intake-01", "intake-10", "identity-01", "identity-12"],
  );
});

void test("a missing event fails both intake checks and says which event", () => {
  const observations = healthy();
  observations.events.shift();
  const checks = nodeChecks(observations);
  assert.equal(byId(checks, "intake-01").passed, false);
  assert.match(byId(checks, "intake-01").detail, /compat_node_event/);
  assert.equal(byId(checks, "intake-10").passed, false);
  assert.match(byId(checks, "intake-10").detail, /2 of 3 events stored/);
});

void test("an event without the library marker fails intake-01 alone", () => {
  const observations = healthy();
  observations.events[1] = event("$identify", PLAN.node.user, 7, "posthog-js");
  const checks = nodeChecks(observations);
  assert.equal(byId(checks, "intake-01").passed, false);
  assert.match(byId(checks, "intake-01").detail, /\$identify/);
  assert.equal(byId(checks, "intake-10").passed, true);
});

void test("two persons for the anonymous id and the user fail identity-01", () => {
  const observations = healthy();
  const anonymous = observations.links[0];
  assert.ok(anonymous);
  anonymous.personId = 8;
  const checks = nodeChecks(observations);
  assert.equal(byId(checks, "identity-01").passed, false);
  assert.match(byId(checks, "identity-01").detail, /person 8.*person 7/);
  assert.equal(byId(checks, "identity-12").passed, true);
});

void test("an earlier event not claimed by the joined person fails identity-01", () => {
  const observations = healthy();
  observations.events[0] = event(PLAN.node.event, PLAN.node.anonymousId, null);
  const checks = nodeChecks(observations);
  assert.equal(byId(checks, "identity-01").passed, false);
  assert.match(byId(checks, "identity-01").detail, /not counted/);
});

void test("an unjoined alias fails identity-12 alone", () => {
  const observations = healthy();
  const alias = observations.links[2];
  assert.ok(alias);
  alias.personId = 9;
  const checks = nodeChecks(observations);
  assert.equal(byId(checks, "identity-01").passed, true);
  assert.equal(byId(checks, "identity-12").passed, false);
  assert.match(byId(checks, "identity-12").detail, /compat-node-alias is person 9/);
});

void test("a missing alias row fails identity-12 and says so", () => {
  const observations = healthy();
  observations.links.pop();
  const checks = nodeChecks(observations);
  assert.equal(byId(checks, "identity-12").passed, false);
  assert.match(byId(checks, "identity-12").detail, /compat-node-alias is person null/);
});

void test("failedCount counts only failures", () => {
  const checks = nodeChecks(healthy());
  assert.equal(failedCount(checks), 0);
  const first = checks[0];
  const fourth = checks[3];
  assert.ok(first);
  assert.ok(fourth);
  first.passed = false;
  fourth.passed = false;
  assert.equal(failedCount(checks), 2);
});

void test("formatCheck prints pass or FAIL, the behaviour, what it checks and its detail", () => {
  assert.equal(
    formatCheck({
      behaviour: "intake-01",
      what: "an event is stored",
      passed: true,
      detail: "1 of 1",
    }),
    "pass intake-01 an event is stored (1 of 1)",
  );
  assert.equal(
    formatCheck({ behaviour: "intake-01", what: "an event is stored", passed: false, detail: "" }),
    "FAIL intake-01 an event is stored",
  );
});

/**
 * @param {string} name
 * @param {string} distinctId
 * @param {number | null} personId
 * @param {Record<string, unknown>} [properties]
 * @returns {import("./checks.mjs").StoredEvent}
 */
function iosEvent(name, distinctId, personId, properties = {}) {
  return {
    uuid: `${name}-${distinctId}`,
    event: name,
    distinctId,
    personId,
    ts: 1,
    properties: { $lib: "posthog-ios", ...properties },
  };
}

/**
 * One recorded /flags call as the SDK sends it, with anything overridden.
 * @param {Partial<import("./checks.mjs").RecordedCall>} [overrides]
 * @returns {import("./checks.mjs").RecordedCall}
 */
function flagsCall(overrides = {}) {
  return {
    method: "POST",
    path: "/flags",
    status: 200,
    body: JSON.stringify({ api_key: "cfa_pk_token", distinct_id: PLAN.ios.user }),
    answer: JSON.stringify({
      flags: {},
      featureFlags: {},
      featureFlagPayloads: {},
      errorsWhileComputingFlags: false,
    }),
    ...overrides,
  };
}

/** The rows and calls a healthy posthog-ios run leaves behind. */
/**
 * The ios checks over a run's rows and the requests it recorded, which the
 * client hands over in its report.
 * @param {{ events: import("./checks.mjs").StoredEvent[], links: import("./checks.mjs").PersonLink[], calls: import("./checks.mjs").RecordedCall[] }} run
 */
function ios(run) {
  return iosChecks(
    { events: run.events, links: run.links, points: [], chunks: [], objects: [] },
    { sdk: "posthog-ios", errors: [], calls: run.calls },
  );
}

function iosHealthy() {
  const person = 11;
  const anonymousId = "0199c0de-0000-7000-8000-000000000000";
  return {
    events: [
      iosEvent(PLAN.ios.event, anonymousId, person),
      iosEvent("$screen", anonymousId, person, { $screen_name: PLAN.ios.screen }),
      iosEvent("$identify", PLAN.ios.user, person),
      iosEvent("$create_alias", PLAN.ios.user, person),
    ],
    links: [
      { distinctId: anonymousId, personId: person },
      { distinctId: PLAN.ios.user, personId: person },
      { distinctId: PLAN.ios.alias, personId: person },
    ],
    calls: [flagsCall()],
  };
}

void test("every ios check passes on the rows and calls a healthy run leaves", () => {
  const checks = ios(iosHealthy());
  assert.equal(failedCount(checks), 0, JSON.stringify(checks.filter((check) => !check.passed)));
  assert.deepEqual(
    checks.map((check) => check.behaviour),
    ["intake-01", "config-07", "identity-01"],
  );
});

void test("a stored event without the library marker fails intake-01", () => {
  const observations = iosHealthy();
  observations.events[0] = iosEvent(PLAN.ios.event, "anonymous", 11, { $lib: "posthog-node" });
  const checks = ios(observations);
  assert.equal(byId(checks, "intake-01").passed, false);
  assert.match(byId(checks, "intake-01").detail, /compat_ios_event/);
});

void test("a $screen without its screen name fails intake-01", () => {
  const observations = iosHealthy();
  observations.events[1] = iosEvent("$screen", "anonymous", 11);
  const checks = ios(observations);
  assert.equal(byId(checks, "intake-01").passed, false);
  assert.match(byId(checks, "intake-01").detail, /compat_ios_screen/);
});

void test("no recorded request fails config-07 and says so", () => {
  const observations = iosHealthy();
  observations.calls = [];
  const checks = ios(observations);
  assert.equal(byId(checks, "config-07").passed, false);
  assert.match(byId(checks, "config-07").detail, /no request was recorded/);
});

void test("a /flags request without api_key fails config-07", () => {
  const observations = iosHealthy();
  observations.calls = [flagsCall({ body: JSON.stringify({ token: "cfa_pk_token" }) })];
  const checks = ios(observations);
  assert.equal(byId(checks, "config-07").passed, false);
  assert.match(byId(checks, "config-07").detail, /carried no api_key/);
});

void test("a /flags answer missing featureFlagPayloads fails config-07", () => {
  const observations = iosHealthy();
  observations.calls = [flagsCall({ answer: JSON.stringify({ featureFlags: {} }) })];
  const checks = ios(observations);
  assert.equal(byId(checks, "config-07").passed, false);
  assert.match(byId(checks, "config-07").detail, /without flags, featureFlagPayloads/);
});

void test("a /flags answer that is not 200 fails config-07", () => {
  const observations = iosHealthy();
  observations.calls = [flagsCall({ status: 401 })];
  const checks = ios(observations);
  assert.equal(byId(checks, "config-07").passed, false);
  assert.match(byId(checks, "config-07").detail, /answered 401/);
});

void test("an alias in another person fails identity-01", () => {
  const observations = iosHealthy();
  const alias = observations.links[2];
  assert.ok(alias);
  alias.personId = 12;
  const checks = ios(observations);
  assert.equal(byId(checks, "identity-01").passed, false);
  assert.match(byId(checks, "identity-01").detail, /compat-ios-alias is person 12/);
  assert.equal(byId(checks, "config-07").passed, true);
});

void test("an earlier event not claimed by the identified person fails identity-01", () => {
  const observations = iosHealthy();
  observations.events[0] = iosEvent(PLAN.ios.event, "0199c0de-0000-7000-8000-000000000000", null);
  const checks = ios(observations);
  assert.equal(byId(checks, "identity-01").passed, false);
  assert.match(byId(checks, "identity-01").detail, /not counted/);
});
