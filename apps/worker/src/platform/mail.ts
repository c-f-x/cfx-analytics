import { notify } from "@c-f-x/kit/worker";
import { err, ok, type Result } from "./result.ts";
import type { OutgoingMail } from "./weekly.ts";

// The one module that sends mail (cfx-kit conventions, section 6; checked by
// `c-f-x check architecture`). It sends through the Worker's send_email
// binding to the site file's verified alert addresses, which is free and does
// not depend on cfx-mail (#23).

/** Sends one plain-text email, answering its message id or why it was refused. */
export async function sendMail(env: Cloudflare.Env, mail: OutgoingMail): Promise<Result<string>> {
  const from = env.MAIL_FROM;
  if (from === undefined || from === "") return err("MAIL_FROM is not set");
  const sent = await notify(env.MAIL, {
    from: { email: from, name: "cfx-analytics" },
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
  });
  return sent.ok ? ok(sent.value.messageId) : err(sent.problems.join("; "));
}

/** The site file's alert addresses, as the deploy writes them: a JSON list of strings. */
export function alertAddresses(value: unknown): Result<string[]> {
  if (typeof value !== "string" || value === "") return err("ALERT_ADDRESSES is not set");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return err("ALERT_ADDRESSES is not JSON");
  }
  if (!Array.isArray(parsed) || !parsed.every((a): a is string => typeof a === "string")) {
    return err("ALERT_ADDRESSES is not a list of addresses");
  }
  return ok(parsed);
}
