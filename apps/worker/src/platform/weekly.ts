import type { TopResult, TrendResult } from "@cfanalytics/shared";
import {
  lastWeeks,
  type ProductWeek,
  productWeekOf,
  type WeekAnswers,
  weekQueries,
  weeklyEmail,
} from "../features/alerts/index.ts";
import { listProjects } from "../features/projects/index.ts";
import { runProjectQuery } from "../features/query/index.ts";
import type { Hono } from "hono";
import type { Deps } from "./deps.ts";
import { type AppEnv, apiError, dashboardAnswer } from "./http.ts";
import { alertAddresses, sendMail } from "./mail.ts";
import { err, ok, type Result } from "./result.ts";
import { requireAdmin, requireSameOrigin } from "./session.ts";

// The weekly email's run (alerts-07, #23): every product's last week, read
// through the same queries as the dashboard, one email to each alert address.
// It calls three slices, so it lives here with the other orchestration.

/** One email as mail.ts sends it. */
export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

export interface WeeklyRun {
  /** The verified addresses the site file lists (alert_addresses). */
  recipients: string[];
  /** The dashboard's origin, for the links. */
  origin: string;
  send: (mail: OutgoingMail) => Promise<Result<string, string>>;
}

export interface WeeklyOutcome {
  sent: number;
  /** Products whose store did not answer, by id. */
  leftOut: string[];
}

const NAMES = ["visitors", "sessions", "pages", "sources", "rage", "ragePage", "dead"] as const;

/** One product's week, or null when its store did not answer one of the questions. */
async function readWeek(
  env: Cloudflare.Env,
  deps: Deps,
  project: { id: string; name: string; settings: Parameters<typeof runProjectQuery>[2]["settings"] },
): Promise<ProductWeek | null> {
  const week = lastWeeks(deps.now(), project.settings.timezone).now;
  const specs = weekQueries(week);
  const answers = await Promise.all(
    NAMES.map((name) => runProjectQuery(env, deps, project, specs[name])),
  );
  const results: Partial<Record<(typeof NAMES)[number], TrendResult | TopResult>> = {};
  for (const [index, name] of NAMES.entries()) {
    const answer = answers[index];
    if (answer === undefined || !answer.ok) return null;
    results[name] = answer.value.result as TrendResult | TopResult;
  }
  return productWeekOf(project, week, results as WeekAnswers);
}

/** Reads every product's week and sends the weekly email to each recipient. */
export async function sendWeeklyEmails(
  env: Cloudflare.Env,
  deps: Deps,
  run: WeeklyRun,
): Promise<Result<WeeklyOutcome, string>> {
  if (run.recipients.length === 0) return err("no alert address: the site file lists none");
  const listed = await listProjects(env.REGISTRY);
  if (!listed.ok) return err(`the registry did not answer: ${listed.error.message}`);
  const weeks: ProductWeek[] = [];
  const leftOut: string[] = [];
  for (const project of listed.value.filter((p) => p.deletedAt === null)) {
    // One product at a time keeps each store's load to one question set.
    // oxlint-disable-next-line no-await-in-loop
    const week = await readWeek(env, deps, project);
    if (week === null) {
      deps.log.error("weekly_product_left_out", { project: project.id });
      leftOut.push(project.id);
    } else {
      weeks.push(week);
    }
  }
  const email = weeklyEmail(weeks, run.origin);
  if (email === null) return ok({ sent: 0, leftOut });
  let sent = 0;
  for (const to of run.recipients) {
    // oxlint-disable-next-line no-await-in-loop
    const result = await run.send({ to, subject: email.subject, text: email.text });
    if (result.ok) sent += 1;
    else deps.log.error("weekly_email_refused", { message: result.error });
  }
  return ok({ sent, leftOut });
}

/**
 * The weekly run with this deployment's configuration: the site file's alert
 * addresses, the dashboard's origin, and mail.ts. The scheduled handler runs
 * it through the kit's job, and the dashboard's "send it now" route directly.
 */
export async function runWeekly(env: Cloudflare.Env, deps: Deps): Promise<Result<WeeklyOutcome, string>> {
  const recipients = alertAddresses(env.ALERT_ADDRESSES);
  if (!recipients.ok) return err(recipients.error);
  return sendWeeklyEmails(env, deps, {
    recipients: recipients.value,
    origin: env.DASHBOARD_ORIGIN,
    send: (mail) => sendMail(env, mail),
  });
}

/** POST /api/emails/weekly: the owner sends this week's email now, to every alert address (alerts-08). */
export function mountWeekly(app: Hono<AppEnv>): void {
  app.all("/api/emails/weekly", requireAdmin(), requireSameOrigin(), async (c) => {
    if (c.req.method !== "POST") {
      return apiError(405, "method_not_allowed", "Only POST is allowed on this path.");
    }
    const outcome = await runWeekly(c.env, c.get("deps"));
    if (!outcome.ok) return apiError(503, "unavailable", outcome.error);
    return dashboardAnswer(outcome.value);
  });
}
