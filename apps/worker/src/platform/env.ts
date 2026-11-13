import type { ProjectStore } from "./project-store.ts";

// The Worker's bindings (apps/worker/wrangler.jsonc) and secrets. Values that
// differ per deployment are secrets set with `wrangler secret put`, never vars
// in wrangler.jsonc; local runs and tests set them as Miniflare bindings.
declare global {
  namespace Cloudflare {
    interface Env {
      REGISTRY: D1Database;
      PROJECT_STORE: DurableObjectNamespace<ProjectStore>;
      RECORDINGS: R2Bucket;
      /** The pinned posthog-js scripts under assets/posthog/ (D-15, config-25). */
      ASSETS: Fetcher;
      /** Signs the dashboard's session and sign-in cookies with HMAC-SHA256 (D-27). A secret. */
      AUTH_SECRET: string;
      /** The one Cloudflare login admitted to the dashboard, such as owner@example.com (D-27). A secret. */
      ADMIN_EMAIL: string;
      /** The private Cloudflare OAuth client the owner creates (D-27). Unset until they do: sign-in is then 503. */
      CLOUDFLARE_CLIENT_ID?: string;
      CLOUDFLARE_CLIENT_SECRET?: string;
      /** The dashboard's own origin, for the same-origin check on state changes (projects-26). */
      DASHBOARD_ORIGIN: string;
      /** Where the stores live, from the site file's jurisdiction; unset for the default placement (D-38). */
      STORE_JURISDICTION?: "eu";
      /** The send_email binding mail.ts sends through, to the site file's alert addresses only (#23). */
      MAIL: SendEmail;
      /** The verified address mail comes from: the site file's watch.from. */
      MAIL_FROM?: string;
      /** The site file's alert_addresses, as a JSON list (#23). */
      ALERT_ADDRESSES?: string;
      /** The Cloudflare account, for its Email Routing addresses (D-40). From the site file. */
      CLOUDFLARE_ACCOUNT_ID?: string;
      /** A token with Email Routing Addresses Write, made by the owner (D-40). A secret. */
      CLOUDFLARE_EMAIL_TOKEN?: string;
    }
  }
}

export type Env = Cloudflare.Env;
