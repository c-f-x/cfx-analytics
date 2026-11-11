// @ts-check

import { browserChecks, iosChecks, nodeChecks } from "../checks.mjs";
import { PLAN } from "../plan.mjs";
import { browserReady, runBrowser } from "./browser.mjs";
import { runIos } from "./ios.mjs";
import { runNode } from "./node.mjs";

/**
 * One SDK the suite can run. `expects` is the event names the run waits for;
 * `ready` adds any row a client needs beyond those names, such as a recording
 * chunk or a heatmap point.
 * @typedef {{
 *   plan: Record<string, unknown>,
 *   expects: string[],
 *   run: (options: import("../checks.mjs").ClientOptions) => Promise<import("../checks.mjs").SdkReport>,
 *   checks: (
 *     observations: import("../checks.mjs").Observations,
 *     report?: import("../checks.mjs").SdkReport,
 *   ) => import("../checks.mjs").Check[],
 *   ready?: (
 *     observations: import("../checks.mjs").Observations,
 *     report: import("../checks.mjs").SdkReport | undefined,
 *   ) => { ready: boolean, detail: string },
 * }} Client
 */

/**
 * Every client the suite can run, by the name `--only` takes. A new SDK joins
 * this map with its own module, plan and checks, and no other file changes
 * beyond its tests.
 * @type {{ node: Client, browser: Client, ios: Client }}
 */
export const CLIENTS = {
  node: {
    plan: PLAN.node,
    expects: [PLAN.node.event, "$identify", "$create_alias"],
    run: runNode,
    checks: nodeChecks,
  },
  browser: {
    plan: PLAN.browser,
    expects: PLAN.browser.events,
    run: runBrowser,
    checks: browserChecks,
    ready: browserReady,
  },
  ios: {
    plan: PLAN.ios,
    expects: [PLAN.ios.event, "$screen", "$identify", "$create_alias"],
    run: runIos,
    checks: iosChecks,
  },
};
