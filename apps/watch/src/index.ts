import { alertEmail, nextWatch, type WatchState } from "./alert.ts";

// The watcher's I/O (D-30): ask TARGET, keep the state in KV, email through
// the ALERT binding, which only reaches the owner's address (TO). The rule of when to
// email is alert.ts.

interface Env {
  TARGET: string;
  FROM: string;
  /** The owner's address; the ALERT binding is locked to it too. */
  TO: string;
  STATE: KVNamespace;
  ALERT: SendEmail;
}

const STATE_KEY = "state";
const CHECK_TIMEOUT_MS = 15_000;

/** Whether TARGET answered 200 within the timeout. */
async function isHealthy(target: string): Promise<boolean> {
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    return response.status === 200;
  } catch {
    return false;
  }
}

function isWatchState(value: unknown): value is WatchState {
  return (
    typeof value === "object" &&
    value !== null &&
    "health" in value &&
    "failures" in value &&
    "since" in value &&
    (value.health === "healthy" || value.health === "failing") &&
    typeof value.failures === "number" &&
    typeof value.since === "number"
  );
}

/**
 * One check. The new state is kept only after its email, if any, is sent, so
 * a failed send is tried again at the next check.
 */
async function check(env: Env, now: number): Promise<void> {
  const stored: unknown = await env.STATE.get(STATE_KEY, "json");
  const previous = isWatchState(stored) ? stored : null;
  const healthy = await isHealthy(env.TARGET);
  const { state, alert } = nextWatch(previous, healthy, now);
  console.log(
    JSON.stringify({
      event: "watch_check",
      healthy,
      health: state.health,
      failures: state.failures,
    }),
  );
  if (alert !== null) {
    const { subject, text } = alertEmail(alert, env.TARGET, state.since);
    await env.ALERT.send({
      from: { email: env.FROM, name: "cfx-analytics watch" },
      to: env.TO,
      subject,
      text,
    });
    console.log(JSON.stringify({ event: "watch_alert", alert }));
  }
  await env.STATE.put(STATE_KEY, JSON.stringify(state));
}

export default {
  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(check(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
