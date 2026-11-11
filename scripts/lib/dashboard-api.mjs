// @ts-check

import { spawnSync } from "node:child_process";
import { sessionToken } from "./ops.mjs";

// A signed-in way to a deployment's dashboard API for the operations
// commands (backup, export, smoke). AUTH_SECRET is read from the macOS
// keychain, where pnpm ops secrets keeps it, into memory only.

/** The keychain service that holds a deployment's AUTH_SECRET. */
export const keychainService = (/** @type {{ env: string }} */ deployment) =>
  `cfanalytics-${deployment.env}`;

/**
 * @typedef {(method: string, where: string, body?: unknown) => Promise<Record<string, unknown>>} ApiCall
 */

/**
 * A call to the deployment's API under a session for its admin (D-27), the
 * site file's admin_email, valid for an hour, or an error saying why there is
 * none. A call that answers other than 2xx, or with no JSON object, throws
 * with the status and body.
 * @param {{ env: string, origin: string, adminEmail: string }} deployment
 * @returns {{ ok: true, call: ApiCall } | { ok: false, error: string }}
 */
export function dashboardApi(deployment) {
  const { origin } = deployment;
  const read = spawnSync(
    "security",
    ["find-generic-password", "-s", keychainService(deployment), "-a", "AUTH_SECRET", "-w"],
    { encoding: "utf8" },
  );
  if (read.status !== 0) {
    return {
      ok: false,
      error: `No AUTH_SECRET for "${deployment.env}" in the keychain; pnpm ops secrets keeps it there.`,
    };
  }
  const token = sessionToken(read.stdout.trim(), {
    email: deployment.adminEmail,
    exp: Date.now() + 3_600_000,
  });
  const cookie = `__Host-cfa_session=${token}`;
  /** @type {ApiCall} */
  const call = async (method, where, body) => {
    /** @type {RequestInit} */
    const init = { method, headers: { cookie, origin, "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(`${origin}${where}`, init);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${where} answered ${String(response.status)}: ${text}`);
    }
    const parsed = /** @type {unknown} */ (JSON.parse(text));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${method} ${where} answered no object`);
    }
    return Object.fromEntries(Object.entries(parsed));
  };
  return { ok: true, call };
}
