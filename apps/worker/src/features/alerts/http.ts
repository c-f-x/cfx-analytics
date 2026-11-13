import { addAddressBody } from "@cfanalytics/shared";
import type { Hono } from "hono";
import { emailRouting } from "../../platform/email-routing.ts";
import {
  type AppContext,
  type AppEnv,
  apiError,
  dashboardAnswer,
  readJsonBody,
} from "../../platform/http.ts";
import { alertAddresses } from "../../platform/mail.ts";
import { requireAdmin, requireSameOrigin } from "../../platform/session.ts";
import { addAddress, listAddedAddresses, removeAddress } from "./store.ts";

// The weekly email's addresses in the dashboard (alerts-10 to alerts-12, D-40).
// The setup's addresses come from the site file and cannot be removed; the
// owner adds others here, and Cloudflare emails each a link to confirm.

const UNAVAILABLE = "Cloudflare's Email Routing did not answer.";
export interface AddressRow {
  address: string;
  confirmed: boolean;
  fromSetup: boolean;
}

function routingOf(c: AppContext) {
  const account = c.env.CLOUDFLARE_ACCOUNT_ID;
  const token = c.env.CLOUDFLARE_EMAIL_TOKEN;
  if (account === undefined || token === undefined) return null;
  return emailRouting(account, token, c.get("deps").fetch);
}

const setupOf = (c: AppContext) => {
  const setup = alertAddresses(c.env.ALERT_ADDRESSES);
  return setup.ok ? setup.value.map((a) => a.toLowerCase()) : [];
};

/**
 * GET: the setup's addresses and the added ones, each confirmed or waiting,
 * and whether addresses can be added. Without the Cloudflare token, only the
 * setup's are listed, as the site file says they are verified.
 */
async function handleList(c: AppContext): Promise<Response> {
  const routing = routingOf(c);
  if (routing === null) {
    const setupOnly = setupOf(c).map((a) => ({ address: a, confirmed: true, fromSetup: true }));
    return dashboardAnswer({ addresses: setupOnly, canAdd: false });
  }
  const [added, known] = await Promise.all([listAddedAddresses(c.env.REGISTRY), routing.list()]);
  if (!added.ok || !known.ok) {
    c.get("deps").log.error("email_addresses_failed", {
      message: added.ok ? (known.ok ? "" : known.error) : added.error,
    });
    return apiError(503, "unavailable", UNAVAILABLE);
  }
  const verified = new Set(known.value.filter((d) => d.verified).map((d) => d.email));
  const setup = setupOf(c);
  const rows: AddressRow[] = [
    ...setup.map((a) => ({ address: a, confirmed: verified.has(a), fromSetup: true })),
    ...added.value
      .filter((a) => !setup.includes(a))
      .map((a) => ({ address: a, confirmed: verified.has(a), fromSetup: false })),
  ];
  return dashboardAnswer({ addresses: rows, canAdd: true });
}

/** POST {address}: asks Cloudflare to add it, unless it already has it, and lists it. */
async function handleAdd(c: AppContext): Promise<Response> {
  const body = await readJsonBody(c.req.raw, 4096);
  if (!body.ok) return body.error;
  const parsed = addAddressBody.safeParse(body.value);
  if (!parsed.success)
    return apiError(400, "validation_failed", "address must be an email address.");
  const wanted = parsed.data.address.toLowerCase();
  const routing = routingOf(c);
  if (routing === null) return apiError(503, "unavailable", "Adding addresses is not set up yet.");
  const known = await routing.list();
  if (!known.ok) return apiError(503, "unavailable", UNAVAILABLE);
  if (!known.value.some((d) => d.email === wanted)) {
    const created = await routing.create(wanted);
    if (!created.ok) {
      c.get("deps").log.error("email_address_refused", { message: created.error });
      return apiError(503, "unavailable", UNAVAILABLE);
    }
  }
  const added = await addAddress(c.env.REGISTRY, wanted, c.get("deps").now());
  if (!added.ok) return apiError(503, "unavailable", "The registry did not answer.");
  return dashboardAnswer({ address: wanted }, 201);
}

/** DELETE: takes an added address off the list; Cloudflare's record stays for other tools. */
async function handleRemove(c: AppContext): Promise<Response> {
  const wanted = (c.req.param("address") ?? "").toLowerCase();
  if (setupOf(c).includes(wanted)) {
    return apiError(409, "conflict", "An address from the setup cannot be removed here.");
  }
  const removed = await removeAddress(c.env.REGISTRY, wanted);
  if (!removed.ok) return apiError(503, "unavailable", "The registry did not answer.");
  if (!removed.value) return apiError(404, "not_found", "No such address.");
  return new Response(null, { status: 204 });
}

export function mountEmails(app: Hono<AppEnv>): void {
  const access = requireAdmin();
  const sameOrigin = requireSameOrigin();
  app.get("/api/emails/addresses", access, handleList);
  app.post("/api/emails/addresses", access, sameOrigin, handleAdd);
  app.delete("/api/emails/addresses/:address", access, sameOrigin, handleRemove);
}
