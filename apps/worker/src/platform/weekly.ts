import type { ProjectInfo, TopResult, TrendResult } from "@cfanalytics/shared";
import type { Hono } from "hono";
import {
  lastWeeks,
  type ProductWeek,
  productWeekOf,
  type WeekAnswers,
  weeklyEmail,
  weekQueries,
} from "../features/alerts/index.ts";
import { listProjects } from "../features/projects/index.ts";
import { runProjectQuery } from "../features/query/index.ts";
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
  send: (mail: OutgoingMail) => Promise<Result<string>>;
}

export interface WeeklyOutcome {
  sent: number;
  /** Products whose store did not answer, by id. */
  leftOut: string[];
}

type Answered = Awaited<ReturnType<typeof runProjectQuery>>;

const isTrend = (result: unknown): result is TrendResult =>
  typeof result === "object" && result !== null && "series" in result && "buckets" in result;

const isTop = (result: unknown): result is TopResult =>
  typeof result === "object" &&
  result !== null &&
  "rows" in result &&
  Array.isArray(result.rows) &&
  result.rows.every((row: unknown) => typeof row === "object" && row !== null && "count" in row);

const trendOf = (answer: Answered): TrendResult | null =>
  answer.ok && isTrend(answer.value.result) ? answer.value.result : null;
const topOf = (answer: Answered): TopResult | null =>
  answer.ok && isTop(answer.value.result) ? answer.value.result : null;

/** One product's week, or null when its store did not answer one of the questions. */
async function readWeek(
  env: Cloudflare.Env,
  deps: Deps,
  project: ProjectInfo,
): Promise<ProductWeek | null> {
  const week = lastWeeks(deps.now(), project.settings.timezone).now;
  const specs = weekQueries(week);
  const ask = (name: keyof typeof specs) => runProjectQuery(env, deps, project, specs[name]);
  const [visitors, sessions, pages, sources, rage, ragePage, dead] = await Promise.all([
    ask("visitors"),
    ask("sessions"),
    ask("pages"),
    ask("sources"),
    ask("rage"),
    ask("ragePage"),
    ask("dead"),
  ]);
  const answers: Record<keyof WeekAnswers, TrendResult | TopResult | null> = {
    visitors: trendOf(visitors),
    sessions: trendOf(sessions),
    pages: topOf(pages),
    sources: topOf(sources),
    rage: trendOf(rage),
    ragePage: topOf(ragePage),
    dead: trendOf(dead),
  };
  const read = complete(answers);
  return read === null ? null : productWeekOf(project, week, read);
}

/** The answers when every one came back in its expected shape, else null. */
function complete(
  answers: Record<keyof WeekAnswers, TrendResult | TopResult | null>,
): WeekAnswers | null {
  const { visitors, sessions, pages, sources, rage, ragePage, dead } = answers;
  if (!isTrend(visitors) || !isTrend(sessions) || !isTop(pages) || !isTop(sources)) return null;
  if (!isTrend(rage) || !isTop(ragePage) || !isTrend(dead)) return null;
  return { visitors, sessions, pages, sources, rage, ragePage, dead };
}

/** Reads every product's week and sends the weekly email to each recipient. */
export async function sendWeeklyEmails(
  env: Cloudflare.Env,
  deps: Deps,
  run: WeeklyRun,
): Promise<Result<WeeklyOutcome>> {
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
export async function runWeekly(env: Cloudflare.Env, deps: Deps): Promise<Result<WeeklyOutcome>> {
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
