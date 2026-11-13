import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { captureApp, fetchApp, iso, nodeBatch, nodeRequest } from "../../test/helpers/capture.ts";
import { seedProject } from "../../test/helpers/registry.ts";
import { dashboardHeaders, dashboardSession } from "../../test/helpers/session.ts";
import { lastWeeks } from "../features/alerts/index.ts";
import worker from "../index.ts";
import { realDeps } from "./deps.ts";
import { ok } from "./result.ts";
import { type OutgoingMail, sendWeeklyEmails } from "./weekly.ts";

// Monday 9 November 2026, 06:00 UTC: the week before is 2 to 8 November.
const MONDAY = Date.parse("2026-11-09T06:00:00Z");
const IN_WEEK = Date.parse("2026-11-04T12:00:00Z");
const ORIGIN = "https://analytics.example.com";

async function sendPageViews(token: string, people: string[]): Promise<void> {
  const app = captureApp(() => IN_WEEK + 60_000);
  const batch = people.map((person) => ({
    event: "$pageview",
    distinctId: person,
    timestamp: iso(IN_WEEK),
    properties: {
      $current_url: "https://shop.example.com/pricing",
      $process_person_profile: false,
    },
  }));
  const body = nodeBatch(token, batch, { sentAt: iso(IN_WEEK) });
  const response = await fetchApp(app, await nodeRequest(body));
  expect(response.status).toBe(200);
}

describe("sendWeeklyEmails", () => {
  it("alerts-07 · one email to each alert address, covering every product", async () => {
    const shop = await seedProject({ name: "Shop", settings: { timezone: "UTC" } });
    await seedProject({ name: "Quiet", settings: { timezone: "UTC" } });
    await seedProject({ name: "Gone", deletedAt: 1_700_000_000_000 });
    await sendPageViews(shop.token, ["ada", "bo", "cy"]);

    const sent: OutgoingMail[] = [];
    const outcome = await sendWeeklyEmails(
      env,
      { ...realDeps(), now: () => MONDAY },
      {
        recipients: ["one@example.com", "two@example.com"],
        origin: ORIGIN,
        send: async (mail) => {
          sent.push(mail);
          return ok("message-id");
        },
      },
    );

    expect(outcome).toEqual({ ok: true, value: { sent: 2, leftOut: [] } });
    expect(sent.map((mail) => mail.to)).toEqual(["one@example.com", "two@example.com"]);
    expect(sent[0]?.subject).toBe("Your products, 2 to 8 Nov: 3 visitors");
    expect(sent[0]?.text).toContain("Shop, 2 to 8 Nov");
    expect(sent[0]?.text).toContain("Visitors 3, none the week before");
    expect(sent[0]?.text).toContain("Top pages: /pricing 3");
    expect(sent[0]?.text).toContain(`${ORIGIN}/p/${shop.id}`);
    expect(sent[0]?.text).toContain("No visitors this week or the week before: Quiet.");
    expect(sent[0]?.text).not.toContain("Gone");
  });

  it("alerts-07 · with no alert address nothing is sent, and the outcome says so", async () => {
    const sent: OutgoingMail[] = [];
    const outcome = await sendWeeklyEmails(
      env,
      { ...realDeps(), now: () => MONDAY },
      {
        recipients: [],
        origin: ORIGIN,
        send: async (mail) => {
          sent.push(mail);
          return ok("message-id");
        },
      },
    );
    expect(outcome.ok).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("POST /api/emails/weekly", () => {
  const url = "https://dashboard.test/api/emails/weekly";
  const configured = {
    ...env,
    ALERT_ADDRESSES: '["owner@example.com"]',
    MAIL_FROM: "analytics@example.com",
  };

  it("alerts-08 · the owner sends this week's email now, through the real mail binding", async () => {
    const shop = await seedProject({ name: "Shop", settings: { timezone: "UTC" } });
    // The route reads the last whole week at the real clock, so the event is
    // dated two days into that week.
    const inLastWeek = lastWeeks(Date.now(), "UTC").now.from + 2 * 86_400_000;
    const app = captureApp(() => inLastWeek + 60_000);
    const body = nodeBatch(
      shop.token,
      [
        {
          event: "$pageview",
          distinctId: "ada",
          timestamp: iso(inLastWeek),
          properties: { $current_url: "https://shop.example.com/" },
        },
      ],
      { sentAt: iso(inLastWeek) },
    );
    expect((await fetchApp(app, await nodeRequest(body))).status).toBe(200);
    const session = await dashboardSession();
    const response = await fetchApp(
      worker,
      new Request(url, { method: "POST", headers: dashboardHeaders(session) }),
      configured,
    );
    expect(response.status).toBe(200);
    const answer = await response.json();
    // One alert address, and the local send_email binding accepted the email.
    expect(answer).toEqual({ sent: 1, leftOut: [] });
  });

  it("alerts-08 · refused without a session, from another origin, and for other methods", async () => {
    const session = await dashboardSession();
    const anonymous = await fetchApp(worker, new Request(url, { method: "POST" }), configured);
    expect(anonymous.status).toBe(401);
    const elsewhere = await fetchApp(
      worker,
      new Request(url, {
        method: "POST",
        headers: { ...dashboardHeaders(session), origin: "https://evil.example.com" },
      }),
      configured,
    );
    expect(elsewhere.status).toBe(403);
    const get = await fetchApp(
      worker,
      new Request(url, { headers: dashboardHeaders(session) }),
      configured,
    );
    expect(get.status).toBe(405);
  });
});
