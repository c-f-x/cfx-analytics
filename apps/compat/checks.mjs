// @ts-check

import { PLAN } from "./plan.mjs";

// The verdicts of the compatibility checks. Pure: each reads the rows the store
// reader found and answers what passed, so a check can be tested without a run.

/**
 * @typedef {{
 *   uuid: string,
 *   event: string,
 *   distinctId: string,
 *   personId: number | null,
 *   ts: number,
 *   properties: Record<string, unknown>,
 * }} StoredEvent
 * @typedef {{ distinctId: string, personId: number }} PersonLink
 * @typedef {{
 *   method: string,
 *   path: string,
 *   status: number,
 *   body: string,
 *   answer: string,
 * }} RecordedCall
 * @typedef {{
 *   apiHost: string,
 *   token: string,
 *   scope: { dir: string, recordChild: (pid: number, options?: { group?: boolean }) => void },
 *   stateDir: string,
 * }} ClientOptions
 * @typedef {{ behaviour: string, what: string, passed: boolean, detail: string }} Check
 * @typedef {{
 *   method: string,
 *   path: string,
 *   status: number | null,
 *   contentType: string | null,
 *   encoding: string | null,
 *   body: string | null,
 * }} Exchange
 * @typedef {{ type: string, text: string, location: string }} ConsoleEntry
 * @typedef {{ url: string, type: string, size: number }} Beacon
 * @typedef {{
 *   sdk: string,
 *   errors: string[],
 *   exchanges?: Exchange[],
 *   console?: ConsoleEntry[],
 *   beacons?: Beacon[],
 *   config?: Record<string, unknown> | null,
 *   sessionIds?: { main: string | null, headed: string | null },
 *   calls?: RecordedCall[],
 * }} SdkReport
 * @typedef {{
 *   events: StoredEvent[],
 *   links: PersonLink[],
 *   points: import("./store.mjs").StoredPoint[],
 *   chunks: import("./store.mjs").StoredChunk[],
 *   objects: import("./store.mjs").DecodedObject[],
 * }} Observations
 */

const FLAG_KEYS = ["flags", "featureFlags", "featureFlagPayloads", "errorsWhileComputingFlags"];
/** The cookieless id: "cookieless_" and 16 lower-case hex digits (cookieless-01). */
const COOKIELESS_ID = /^cookieless_[0-9a-f]{16}$/;

/**
 * The posthog-node checks: its three events stored, its gzip body read, and
 * the identify and alias joining its ids to one person.
 * @param {{ events: StoredEvent[], links: PersonLink[] }} observations
 * @param {SdkReport} [_report] The client's own account of its run; node sends none.
 * @returns {Check[]}
 */
export function nodeChecks({ events, links }, _report) {
  const plan = PLAN.node;
  const expected = [plan.event, "$identify", "$create_alias"];
  const storedNames = new Set(events.map((event) => event.event));
  const missing = expected.filter((name) => !storedNames.has(name));
  const withLibrary = new Set(
    events.filter((event) => event.properties.$lib === "posthog-node").map((event) => event.event),
  );
  const missingLibrary = expected.filter((name) => !withLibrary.has(name));

  /** @type {(distinctId: string) => number | null} */
  const personOf = (distinctId) =>
    links.find((link) => link.distinctId === distinctId)?.personId ?? null;
  const anonymousPerson = personOf(plan.anonymousId);
  const userPerson = personOf(plan.user);
  const aliasPerson = personOf(plan.alias);
  const early = events.find(
    (event) => event.event === plan.event && event.distinctId === plan.anonymousId,
  );
  const joined = anonymousPerson !== null && anonymousPerson === userPerson;
  const earlyCounts = early !== undefined && early.personId === userPerson;

  return [
    {
      behaviour: "intake-01",
      what: "posthog-node's capture, identify and alias are stored with $lib posthog-node",
      passed: missingLibrary.length === 0,
      detail:
        missingLibrary.length === 0
          ? `${expected.length} of ${expected.length} events stored`
          : `missing ${missingLibrary.join(", ")}`,
    },
    {
      behaviour: "intake-10",
      what: "posthog-node's body labelled Content-Encoding: gzip was decoded",
      passed: missing.length === 0,
      detail: `${expected.length - missing.length} of ${expected.length} events stored`,
    },
    {
      behaviour: "identity-01",
      what: "$identify joined the anonymous id to the user's person, and the earlier event counts for it",
      passed: joined && earlyCounts,
      detail: joined
        ? earlyCounts
          ? `both ids share person ${String(userPerson)}, and the earlier event counts for it`
          : `both ids share person ${String(userPerson)}, but the earlier event is not counted for it`
        : personDetail(plan.anonymousId, anonymousPerson, plan.user, userPerson),
    },
    {
      behaviour: "identity-12",
      what: "$create_alias joined the alias to the user's person",
      passed: aliasPerson !== null && aliasPerson === userPerson,
      detail:
        aliasPerson !== null && aliasPerson === userPerson
          ? `the alias and the user share person ${String(userPerson)}`
          : personDetail(plan.alias, aliasPerson, plan.user, userPerson),
    },
  ];
}

/**
 * The posthog-js checks: the SDK's config and lazy scripts, its capture paths,
 * the recording it sends, its heatmap points, its scroll depth and the
 * cookieless page, each read from the Worker's rows and objects and from the
 * requests the client saw.
 * @param {Observations} observations
 * @param {SdkReport} [report]
 * @returns {Check[]}
 */
export function browserChecks({ events, links, points, chunks, objects }, report) {
  const plan = PLAN.browser;
  const exchanges = report?.exchanges ?? [];
  const consoleErrors = (report?.console ?? []).filter((entry) => entry.type === "error");
  const sdkClean = consoleErrors.length === 0;
  // A beacon sent during an unload never reports its answer to the browser's
  // automation protocol, so a request without a status is not a failed answer.
  // The rows the Worker writes prove whether it decoded them.
  const apiFailures = exchanges.filter(
    (exchange) => exchange.status !== null && exchange.status >= 400,
  );
  const apiClean = apiFailures.length === 0;
  const web = events.filter((event) => event.properties.$lib === "web");

  const configScript = exchanges.find(
    (exchange) => isConfigScript(exchange.path) && exchange.status === 200,
  );
  const lazyRecorder = exchanges.find(
    (exchange) => isStaticScript(exchange.path, "lazy-recorder") && exchange.status === 200,
  );

  const flagAnswers = exchanges.filter(
    (exchange) => isFlagsPath(exchange.path) && exchange.status === 200,
  );
  const flagAnswer = flagAnswers
    .map((exchange) => parsedBody(exchange))
    .find((body) => body !== null && FLAG_KEYS.every((key) => Object.hasOwn(body, key)));
  const flagsOk =
    flagAnswer !== undefined &&
    flagAnswer !== null &&
    flagAnswer.errorsWhileComputingFlags === false;

  const mainSession = report?.sessionIds?.main ?? null;
  const sessionChunks =
    mainSession === null ? [] : chunks.filter((chunk) => chunk.sessionId === mainSession);
  const sessionObjects = sessionChunks.map((chunk) =>
    objects.find((object) => object.key === chunk.objectKey),
  );
  const everyObject =
    sessionChunks.length > 0 && sessionObjects.every((found) => found !== undefined);
  const recordingEvents = sessionObjects.flatMap((found) => found?.events ?? []);
  const timestamps = recordingEvents
    .map((event) => event.timestamp)
    .filter((timestamp) => typeof timestamp === "number");
  const ordered = isOrdered(timestamps);
  const fullSnapshot = recordingEvents.some((event) => event.type === 2);

  const maskedLengths = recordingEvents.flatMap((event) => {
    const length = maskedInputLength(event);
    return length === null ? [] : [length];
  });
  const maskedText = maskedLengths.filter((length) => length === plan.typedText.length);
  const leaked = recordingEvents.some((event) => JSON.stringify(event).includes(plan.typedText));

  const pagePoints = points.filter((point) => point.path === plan.pagePath);
  const clickPoints = pagePoints.filter((point) => point.kind === "click");
  const heatmapRows = events.filter((event) => event.event === "$$heatmap");

  const pageleaves = events.filter(
    (event) =>
      event.event === "$pageleave" &&
      typeof event.properties.$prev_pageview_max_scroll === "number",
  );
  const depths = pageleaves.map((event) => Number(event.properties.$prev_pageview_max_scroll));
  const deepest = depths.length === 0 ? null : Math.max(...depths);

  const cookielessEvents = events.filter((event) => COOKIELESS_ID.test(event.distinctId));
  const sentinelStored =
    events.some((event) => event.distinctId === "$posthog_cookieless") ||
    links.some((link) => link.distinctId === "$posthog_cookieless");

  const playbackPosts = exchanges.filter(
    (exchange) =>
      pathnameOf(exchange.path).startsWith("/s") &&
      exchange.method === "POST" &&
      exchange.status === 200,
  );
  const recordingOn = isRecord(report?.config?.sessionRecording);
  const elementsChainAsString = report?.config?.elementsChainAsString === true;
  const gzipPost = exchanges.find(
    (exchange) =>
      isCapturePath(exchange.path) &&
      exchange.method === "POST" &&
      exchange.status === 200 &&
      (exchange.contentType ?? "").startsWith("text/plain") &&
      (exchange.encoding === null || exchange.encoding === ""),
  );
  const formBeacon = (report?.beacons ?? []).find(
    (beacon) =>
      isCapturePath(new URL(beacon.url).pathname) &&
      beacon.type.startsWith("application/x-www-form-urlencoded") &&
      beacon.size > 0 &&
      new URL(beacon.url).searchParams.get("compression") === "base64",
  );
  // The browser sends this pageleave only from the page whose compression is
  // off, so the row with a scroll depth is that beacon's answer (intake-11).
  const formRow = events.some(
    (event) =>
      event.event === "$pageleave" &&
      typeof event.properties.$prev_pageview_max_scroll === "number",
  );
  const missing = plan.events.filter((name) => !web.some((event) => event.event === name));

  return [
    {
      behaviour: "config-03",
      what: "/flags answered with the four keys and errorsWhileComputingFlags false",
      passed: flagsOk && sdkClean,
      detail:
        flagAnswer === undefined
          ? `${String(flagAnswers.length)} /flags answers, none with the four keys`
          : flagsOk
            ? "the /flags answer held the four keys and computing errors false"
            : "the /flags answer said errorsWhileComputingFlags true",
    },
    {
      behaviour: "config-05",
      what: "the config script and the versioned lazy script came from the host, and no answer failed",
      passed: configScript !== undefined && lazyRecorder !== undefined && apiClean && sdkClean,
      detail: apiDetail(configScript?.status ?? null, lazyRecorder?.status ?? null, apiFailures),
    },
    {
      behaviour: "config-09",
      what: "$autocapture events carry $elements_chain as a string",
      passed: elementsChainAsString && web.some(hasElementsChain),
      detail: `the config said elementsChainAsString ${String(elementsChainAsString)}; ${String(
        web.filter(hasElementsChain).length,
      )} $autocapture events carry one`,
    },
    {
      behaviour: "config-29",
      what: "the lazy recorder loaded from /static/ with no 404, and sent a chunk to /s/",
      passed:
        lazyRecorder !== undefined &&
        recordingOn &&
        playbackPosts.length > 0 &&
        apiClean &&
        sdkClean,
      detail: `config sessionRecording ${recordingOn ? "set" : "not set"}; ${String(
        playbackPosts.length,
      )} chunk posts; ${apiDetailWords(apiFailures)}`,
    },
    {
      behaviour: "intake-01",
      what: "posthog-js's $pageview, $autocapture and $pageleave are stored with $lib web",
      passed: missing.length === 0,
      detail:
        missing.length === 0
          ? `${String(plan.events.length)} of ${String(plan.events.length)} events stored`
          : `missing ${missing.join(", ")}`,
    },
    {
      behaviour: "intake-10",
      what: "a gzip body sent as text/plain with no Content-Encoding was decoded",
      passed: gzipPost !== undefined && web.some((event) => event.event === "$pageview"),
      detail:
        gzipPost === undefined
          ? "no text/plain capture was answered 200"
          : "the text/plain capture was answered 200 and its $pageview is stored",
    },
    {
      behaviour: "intake-11",
      what: "a form body with a base64 data field was decoded and stored",
      passed: formBeacon !== undefined && formRow,
      detail:
        formBeacon === undefined
          ? `no base64 form beacon to /e/ (${beaconDetail(report?.beacons ?? [])})`
          : formRow
            ? "the form-encoded $pageleave beacon was decoded and stored"
            : "the base64 form beacon went out, but no $pageleave row with a scroll depth is stored",
    },
    {
      behaviour: "recordings-01",
      what: "a session's chunks reached R2 and play back in order from a full snapshot",
      passed:
        everyObject && fullSnapshot && timestamps.length === recordingEvents.length && ordered,
      detail: recordingDetail(mainSession, sessionChunks.length, recordingEvents.length, {
        everyObject,
        fullSnapshot,
        ordered,
      }),
    },
    {
      behaviour: "recordings-02",
      what: "typed input text is stored as asterisks of the same length",
      passed: maskedText.length > 0 && !leaked,
      detail: leaked
        ? "the typed text appears in the recording"
        : `${String(maskedText.length)} input events masked to ${String(
            plan.typedText.length,
          )} asterisks`,
    },
    {
      behaviour: "heatmaps-01",
      what: "the click made heatmap points and no event row",
      passed: heatmapRows.length === 0 && clickPoints.length > 0 && pagePointsFit(pagePoints),
      detail: `${String(pagePoints.length)} points on ${plan.pagePath} (${String(
        clickPoints.length,
      )} clicks); ${String(heatmapRows.length)} $$heatmap rows`,
    },
    {
      behaviour: "heatmaps-20",
      what: "the $pageleave sent after scrolling and navigating carried the scroll depth",
      passed: deepest !== null && deepest >= plan.scrollDepth,
      detail:
        deepest === null
          ? "no $pageleave carried $prev_pageview_max_scroll"
          : `$prev_pageview_max_scroll ${String(deepest)}`,
    },
    {
      behaviour: "cookieless-01",
      what: "the cookieless page's events are stored under a cookieless_ id, and the sentinel nowhere",
      passed:
        cookielessEvents.length > 0 &&
        cookielessEvents.every((event) => event.properties.$cookieless_mode === true) &&
        !sentinelStored,
      detail: `${String(cookielessEvents.length)} events under a cookieless id${
        sentinelStored ? ", and the sentinel is stored" : ", and no sentinel in any table"
      }`,
    },
  ];
}

/**
 * The posthog-ios checks: its event and $screen stored with $lib posthog-ios,
 * its /flags request carrying api_key answered, and its identify and alias
 * joining the ids to one person.
 * @param {Observations} observations
 * @param {SdkReport} [report] The client's run, holding the requests it recorded.
 * @returns {Check[]}
 */
export function iosChecks({ events, links }, report) {
  const calls = report?.calls ?? [];
  const plan = PLAN.ios;
  const sent = events.filter((event) => event.properties.$lib === "posthog-ios");
  const sentNames = new Set(sent.map((event) => event.event));
  const missing = [plan.event, "$screen"].filter((name) => !sentNames.has(name));
  const screen = sent.find((event) => event.event === "$screen");
  const screenNamed = screen !== undefined && screen.properties.$screen_name === plan.screen;

  /** @type {(distinctId: string) => number | null} */
  const personOf = (distinctId) =>
    links.find((link) => link.distinctId === distinctId)?.personId ?? null;
  const early = events.filter(
    (event) => event.event === plan.event && event.distinctId !== plan.user,
  );
  const anonymousId = early[0]?.distinctId ?? null;
  const anonymousPerson = anonymousId === null ? null : personOf(anonymousId);
  const userPerson = personOf(plan.user);
  const aliasPerson = personOf(plan.alias);
  const joined = anonymousPerson !== null && anonymousPerson === userPerson;
  const earlyCounts = userPerson !== null && early.some((event) => event.personId === userPerson);
  const aliasJoined = aliasPerson !== null && aliasPerson === userPerson;
  const flags = flagsVerdict(calls);

  return [
    {
      behaviour: "intake-01",
      what: "posthog-ios's event and $screen are stored with $lib posthog-ios",
      passed: missing.length === 0 && screenNamed,
      detail:
        missing.length > 0
          ? `missing ${missing.join(", ")}`
          : screenNamed
            ? `${plan.event} and $screen stored`
            : `the $screen event does not carry $screen_name ${plan.screen}`,
    },
    {
      behaviour: "config-07",
      what: "posthog-ios's /flags request carrying api_key was answered",
      passed: flags.passed,
      detail: flags.detail,
    },
    {
      behaviour: "identity-01",
      what: "$identify joined the anonymous id to the user, and the alias joined the user",
      passed: joined && earlyCounts && aliasJoined,
      detail: !joined
        ? anonymousId === null
          ? `no ${plan.event} event was stored under an anonymous id`
          : personDetail(anonymousId, anonymousPerson, plan.user, userPerson)
        : !earlyCounts
          ? `both ids share person ${String(userPerson)}, but the earlier event is not counted for it`
          : !aliasJoined
            ? personDetail(plan.alias, aliasPerson, plan.user, userPerson)
            : `the anonymous id, the user and the alias share person ${String(userPerson)}, and the earlier event counts for it`,
    },
  ];
}

/**
 * What the recorded /flags requests prove: that one carrying api_key was
 * answered 200 with the maps posthog-ios reads (posthog-protocol.md §10.6).
 * @param {RecordedCall[]} calls
 * @returns {{ passed: boolean, detail: string }}
 */
function flagsVerdict(calls) {
  const flagsCalls = calls.filter(isFlagsRequest);
  if (flagsCalls.length === 0) {
    return {
      passed: false,
      detail:
        calls.length === 0
          ? "no request was recorded"
          : `no POST /flags was recorded (saw ${pathsOf(calls)})`,
    };
  }
  const withApiKey = flagsCalls.filter((call) => carriesApiKey(call.body));
  const first = withApiKey[0];
  if (first === undefined)
    return { passed: false, detail: "the /flags request carried no api_key" };
  const answered = withApiKey.find(
    (call) => call.status === 200 && flagsAnswerProblem(call.answer) === null,
  );
  if (answered !== undefined) {
    return {
      passed: true,
      detail: `${String(withApiKey.length)} /flags request(s) carried api_key and were answered 200 with flags`,
    };
  }
  if (first.status !== 200) {
    return { passed: false, detail: `/flags answered ${String(first.status)}` };
  }
  return {
    passed: false,
    detail: `the /flags answer was ${String(flagsAnswerProblem(first.answer))}`,
  };
}

/**
 * Whether a recorded call is a POST to the flags path, with or without the
 * trailing slash (posthog-protocol.md §11, item 7).
 * @param {RecordedCall} call
 * @returns {boolean}
 */
export function isFlagsRequest(call) {
  return call.method === "POST" && (call.path === "/flags" || call.path === "/flags/");
}

/**
 * Whether a /flags request body names the project with `api_key`, as
 * posthog-ios does (posthog-protocol.md §10.6).
 * @param {string} body
 * @returns {boolean}
 */
function carriesApiKey(body) {
  const parsed = jsonObject(body);
  return parsed !== null && typeof parsed.api_key === "string" && parsed.api_key !== "";
}

/**
 * What the /flags answer lacks that posthog-ios needs, or null when it is
 * well formed: a JSON object with the three flag maps (§10.6).
 * @param {string} answer
 * @returns {string | null}
 */
function flagsAnswerProblem(answer) {
  const parsed = jsonObject(answer);
  if (parsed === null) return "not JSON";
  const missing = ["flags", "featureFlags", "featureFlagPayloads"].filter(
    (key) => !isRecord(parsed[key]),
  );
  return missing.length === 0 ? null : `without ${missing.join(", ")}`;
}

/**
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
function jsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The paths a run's recorded calls took, for a check that found none it needs.
 * @param {RecordedCall[]} calls
 * @returns {string}
 */
function pathsOf(calls) {
  return [...new Set(calls.map((call) => `${call.method} ${call.path}`))].join(", ");
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * How many checks failed. The run exits 0 only when this is 0.
 * @param {Check[]} checks
 * @returns {number}
 */
export function failedCount(checks) {
  return checks.filter((check) => !check.passed).length;
}

/**
 * One printed line: pass or FAIL, the behaviour ID, what it checks, its detail.
 * @param {Check} check
 * @returns {string}
 */
export function formatCheck(check) {
  const detail = check.detail === "" ? "" : ` (${check.detail})`;
  return `${check.passed ? "pass" : "FAIL"} ${check.behaviour} ${check.what}${detail}`;
}

/**
 * Says which person each id has, for a check that found them apart.
 * @param {string} leftId
 * @param {number | null} leftPerson
 * @param {string} rightId
 * @param {number | null} rightPerson
 * @returns {string}
 */
function personDetail(leftId, leftPerson, rightId, rightPerson) {
  return `${leftId} is person ${String(leftPerson)}, ${rightId} is person ${String(rightPerson)}`;
}

/**
 * Whether an event is an autocapture that carried an elements chain as a
 * string (config-09).
 * @param {StoredEvent} event
 * @returns {boolean}
 */
function hasElementsChain(event) {
  return (
    event.event === "$autocapture" &&
    typeof event.properties.$elements_chain === "string" &&
    event.properties.$elements_chain !== ""
  );
}

/**
 * Whether the points on a page carry the fields heatmaps-01 asks for: a host,
 * a viewport-width band and the bot flag.
 * @param {import("./store.mjs").StoredPoint[]} points
 * @returns {boolean}
 */
function pagePointsFit(points) {
  return (
    points.length > 0 &&
    points.every((point) => point.host !== null && point.widthBand > 0 && !point.bot)
  );
}

/**
 * What the recording check found, in one line.
 * @param {string | null} session
 * @param {number} chunkCount
 * @param {number} eventCount
 * @param {{ everyObject: boolean, fullSnapshot: boolean, ordered: boolean }} found
 * @returns {string}
 */
function recordingDetail(session, chunkCount, eventCount, found) {
  if (session === null) return "the client reported no session id";
  const parts = [`${String(chunkCount)} chunks`, `${String(eventCount)} events`];
  if (!found.everyObject) parts.push("a chunk's object is missing");
  if (!found.fullSnapshot) parts.push("no full snapshot");
  if (!found.ordered) parts.push("timestamps out of order");
  return parts.join(", ");
}

/**
 * What the page handed to sendBeacon, in one line.
 * @param {Beacon[]} beacons
 * @returns {string}
 */
function beaconDetail(beacons) {
  if (beacons.length === 0) return "no beacons recorded";
  return beacons.map((beacon) => `${beacon.url} ${beacon.type} ${String(beacon.size)}B`).join("; ");
}

/**
 * The config and lazy script answers, then what failed among the API's answers.
 * @param {number | null} configStatus
 * @param {number | null} lazyStatus
 * @param {Exchange[]} failures
 * @returns {string}
 */
function apiDetail(configStatus, lazyStatus, failures) {
  const scripts = `config.js ${statusText(configStatus)}, lazy-recorder ${statusText(lazyStatus)}`;
  return `${scripts}; ${apiDetailWords(failures)}`;
}

/**
 * @param {Exchange[]} failures
 * @returns {string}
 */
function apiDetailWords(failures) {
  if (failures.length === 0) return "no failed answers";
  const shown = failures.map(
    (failure) =>
      `${pathnameOf(failure.path)} ${failure.status === null ? "no answer" : String(failure.status)}`,
  );
  return `${String(failures.length)} failed: ${shown.join(", ")}`;
}

/**
 * @param {number | null} status
 * @returns {string}
 */
function statusText(status) {
  return status === null ? "not requested" : String(status);
}

/**
 * A response body parsed as a JSON object, or null when it is not one.
 * @param {Exchange} exchange
 * @returns {Record<string, unknown> | null}
 */
function parsedBody(exchange) {
  if (exchange.body === null) return null;
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(exchange.body);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

/**
 * @param {string} path
 * @returns {string}
 */
function pathnameOf(path) {
  return path.split("?")[0] ?? "";
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isFlagsPath(path) {
  const pathname = pathnameOf(path);
  return pathname === "/flags" || pathname === "/flags/";
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isConfigScript(path) {
  const pathname = pathnameOf(path);
  return pathname.startsWith("/array/") && pathname.endsWith("/config.js");
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isCapturePath(path) {
  const pathname = pathnameOf(path);
  return pathname === "/e" || pathname === "/e/";
}

/**
 * @param {string} path
 * @param {string} kind
 * @returns {boolean}
 */
function isStaticScript(path, kind) {
  const pathname = pathnameOf(path);
  return pathname.startsWith("/static/") && pathname.endsWith(`/${kind}.js`);
}

/**
 * Whether values never go down.
 * @param {number[]} values
 * @returns {boolean}
 */
function isOrdered(values) {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined || previous > current) return false;
  }
  return true;
}

/**
 * The length of an rrweb input event's fully masked text, or null when the
 * event is not an input event carrying asterisks (recordings-02).
 * @param {Record<string, unknown>} event
 * @returns {number | null}
 */
function maskedInputLength(event) {
  if (event.type !== 3) return null;
  const data = event.data;
  if (!isRecord(data) || data.source !== 5) return null;
  const text = data.text;
  if (typeof text !== "string" || !/^\*+$/.test(text)) return null;
  return text.length;
}
