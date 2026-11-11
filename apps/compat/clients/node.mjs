// @ts-check

import { PostHog } from "posthog-node";
import { PLAN } from "../plan.mjs";

/**
 * Runs the real posthog-node against the Worker with nothing set but the host:
 * a capture under an anonymous id, an $identify that brings $set and joins the
 * anonymous id to the user, and an alias. shutdown() flushes the queue through
 * /batch/, which is the request these checks read.
 *
 * @param {{ apiHost: string, token: string }} options
 * @returns {Promise<{ sdk: string, errors: string[] }>}
 */
export async function runNode({ apiHost, token }) {
  /** @type {string[]} */
  const errors = [];
  const client = new PostHog(token, { host: apiHost });
  client.on("error", (error) => {
    errors.push(error instanceof Error ? error.message : String(error));
  });

  client.capture({
    distinctId: PLAN.node.anonymousId,
    event: PLAN.node.event,
    properties: { plan: "compat" },
  });
  client.identify({
    distinctId: PLAN.node.user,
    properties: {
      $anon_distinct_id: PLAN.node.anonymousId,
      $set: { email: PLAN.node.email },
    },
  });
  client.alias({ distinctId: PLAN.node.user, alias: PLAN.node.alias });
  await client.shutdown();

  return { sdk: "node", errors };
}
