import { err, messageOf, ok, type Result } from "./result.ts";

// Cloudflare's Email Routing destination addresses, for the weekly email's
// recipients (#23, D-40). A destination address is confirmed when the person
// clicks the link Cloudflare emails them; until then its `verified` time is
// null, and the Worker sends it nothing. The API is
// developers.cloudflare.com/api/resources/email_routing/subresources/addresses/,
// read 2026-11-13: GET and POST /accounts/{account_id}/email/routing/addresses,
// a Bearer token with Email Routing Addresses Write.

export interface Destination {
  email: string;
  verified: boolean;
}

export interface EmailRouting {
  /** Every destination address in the account, with whether it is confirmed. */
  list(): Promise<Result<Destination[]>>;
  /** Asks Cloudflare to add the address, which emails the person a link to confirm. */
  create(email: string): Promise<Result<void>>;
}

const BASE = "https://api.cloudflare.com/client/v4";
const PER_PAGE = 50;
const MAX_PAGES = 20;

interface Page {
  success: boolean;
  result: { email: unknown; verified: unknown }[];
  errors: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Cloudflare's answer read field by field; anything missing reads as a failure. */
function pageOf(value: unknown): Page {
  if (!isObject(value)) return { success: false, result: [], errors: ["not JSON"] };
  const rows = Array.isArray(value.result) ? value.result.filter(isObject) : [];
  const errors = Array.isArray(value.errors)
    ? value.errors.map((e) =>
        isObject(e) && typeof e.message === "string" ? e.message : "unknown",
      )
    : [];
  return {
    success: value.success === true,
    result: rows.map((row) => ({ email: row.email, verified: row.verified })),
    errors,
  };
}

const failure = (status: number, body: Page) =>
  `Cloudflare answered ${String(status)}: ${body.errors.join("; ") || "no reason"}`;

/** The client, with the account, the token and the fetch passed in. */
export function emailRouting(
  accountId: string,
  token: string,
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>,
): EmailRouting {
  const url = `${BASE}/accounts/${accountId}/email/routing/addresses`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return {
    async list() {
      const found: Destination[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        let response: Response;
        let body: Page;
        try {
          // Each page needs the one before it to know whether there is more.
          // oxlint-disable-next-line no-await-in-loop
          response = await fetchFn(`${url}?page=${String(page)}&per_page=${String(PER_PAGE)}`, {
            headers,
          });
          // oxlint-disable-next-line no-await-in-loop
          body = pageOf(await response.json());
        } catch (cause) {
          return err(`Cloudflare did not answer: ${messageOf(cause)}`);
        }
        if (!response.ok || !body.success) return err(failure(response.status, body));
        const rows = body.result;
        for (const row of rows) {
          if (typeof row.email === "string") {
            found.push({
              email: row.email.toLowerCase(),
              verified: typeof row.verified === "string",
            });
          }
        }
        if (rows.length < PER_PAGE) return ok(found);
      }
      return err(
        `${String(PER_PAGE * MAX_PAGES)} or more destination addresses; the list stops there`,
      );
    },
    async create(email) {
      let response: Response;
      let body: Page;
      try {
        response = await fetchFn(url, { method: "POST", headers, body: JSON.stringify({ email }) });
        body = pageOf(await response.json());
      } catch (cause) {
        return err(`Cloudflare did not answer: ${messageOf(cause)}`);
      }
      return response.ok && body.success ? ok(undefined) : err(failure(response.status, body));
    },
  };
}
