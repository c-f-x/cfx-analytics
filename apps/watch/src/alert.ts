// When the watcher emails the owner (ops-01, ops-02). One failed check can be a
// blip, so the second failed check in a row alerts, once; the first healthy
// check after an alert says the deployment is back. Pure.

export type Health = "healthy" | "failing";

/** What the watcher remembers between checks. */
export interface WatchState {
  health: Health;
  /** Failed checks in a row; 0 while healthy. */
  failures: number;
  /** When `health` last changed. */
  since: number;
}

/** Failed checks in a row before the alert: one failure can be a blip. */
export const FAILURES_BEFORE_ALERT = 2;

/** The state after a check at `now`, and the email it calls for, if any. */
export function nextWatch(
  previous: WatchState | null,
  healthy: boolean,
  now: number,
): { state: WatchState; alert: "down" | "up" | null } {
  const before = previous ?? { health: "healthy", failures: 0, since: now };
  if (healthy) {
    if (before.health === "failing") {
      return { state: { health: "healthy", failures: 0, since: now }, alert: "up" };
    }
    return { state: { ...before, failures: 0 }, alert: null };
  }
  const failures = before.failures + 1;
  if (before.health === "healthy" && failures >= FAILURES_BEFORE_ALERT) {
    return { state: { health: "failing", failures, since: now }, alert: "down" };
  }
  return { state: { ...before, failures }, alert: null };
}

/** `ms` as "2026-10-22 18:00 UTC". */
const utc = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** The alert's subject and plain text. */
export function alertEmail(
  alert: "down" | "up",
  target: string,
  since: number,
): { subject: string; text: string } {
  if (alert === "down") {
    return {
      subject: "cfanalytics is failing",
      text: `${target} has failed two checks in a row, since ${utc(since)}.\n\nThe Worker's logs say why: pnpm --filter @cfanalytics/worker exec wrangler tail --env production --status error\n\nAnother email follows when it is healthy again.`,
    };
  }
  return {
    subject: "cfanalytics is healthy again",
    text: `${target} answers healthy again, at ${utc(since)}.`,
  };
}
