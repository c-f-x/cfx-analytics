import type { JsonObject } from "@cfanalytics/shared";
import { type Agent, parseAgent } from "./agent.ts";
import { isBot } from "./bots.ts";
import { channelOf } from "./channel.ts";
import { normaliseHost, pageKey, utmFromUrl } from "./page.ts";
import { type CleanReferrer, cleanReferrer } from "./referrer.ts";

// Everything enrich derives for one event, from the event's properties and
// what the request says (architecture.md, "An event", step 3). Pure: the
// request facts arrive as values.

/** The parts of the request enrich reads. Never the IP. */
export interface RequestFacts {
  /** request.cf.country, or null with no request.cf (enrich-02). */
  country: string | null;
  verifiedBotCategory: string | null;
  /** The User-Agent header. */
  userAgent: string | null;
  /** request.cf.timezone; the client's $timezone wins over it (enrich-26). */
  timezone: string | null;
}

export interface Enriched {
  /** The properties to store: cleaned, with derived values added and IP fields removed. */
  properties: JsonObject;
  bot: boolean;
  /** events.page, or null. */
  page: string | null;
}

/**
 * Enriches one event's properties (enrich-01 to enrich-28):
 * - `$geoip_country_code` set from `country`, unless `$geoip_disable` is true,
 *   when every `$geoip_*` property is removed; a client-sent `$geoip_*` is
 *   replaced (enrich-04, enrich-05); `XX` and `T1` set none (enrich-03).
 * - `$ip`, `ip` and every IP-bearing field removed (enrich-06, intake-07).
 * - `$browser`, `$browser_version`, `$os`, `$device_type` kept as sent, or
 *   filled from parseAgent when absent, reading `$raw_user_agent`, else the
 *   request's User-Agent header (enrich-07, enrich-08).
 * - `$referrer`, `$referring_domain` replaced by cleanReferrer's values, and
 *   `$referrer_source` added when it names one; `$channel` from channelOf,
 *   after the utm_* below, replacing any the client sent (enrich-40).
 * - `$host` normalised (enrich-25), utm_* filled from `$current_url` (enrich-24),
 *   `$timezone` from the request only when the client sent none.
 * - client-sent `bot` and `$bot` removed; `bot` decided by isBot (enrich-16).
 * - `page` from pageKey(`$current_url`).
 * Never stores region, city, coordinates or the AS organisation (enrich-01).
 */
export function enrich(properties: Readonly<JsonObject>, request: RequestFacts): Enriched {
  const geolocationDisabled = properties.$geoip_disable === true;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!isRemoved(key)) out[key] = value;
  }

  if (!geolocationDisabled) {
    const country = countryOf(request.country);
    if (country !== null) out.$geoip_country_code = country;
  }

  const currentUrl = typeof properties.$current_url === "string" ? properties.$current_url : null;
  const page = currentUrl === null ? null : pageKey(currentUrl);
  const userAgent = userAgentOf(properties, request);

  fillAgent(out, userAgent === null ? null : parseAgent(userAgent));

  const host = out.$host;
  if (typeof host === "string") out.$host = normaliseHost(host);

  const referrer = typeof properties.$referrer === "string" ? properties.$referrer : null;
  const pageHost = page?.host ?? (typeof properties.$host === "string" ? properties.$host : null);
  applyReferrer(out, cleanReferrer(referrer, pageHost));

  if (currentUrl !== null) {
    for (const [key, value] of Object.entries(utmFromUrl(currentUrl, out))) out[key] = value;
  }
  out.$channel = channelOf(
    typeof out.$referring_domain === "string" ? out.$referring_domain : "$direct",
    typeof out.utm_source === "string" ? out.utm_source : null,
    typeof out.utm_medium === "string" ? out.utm_medium : null,
  );

  if (out.$timezone === undefined && request.timezone !== null) out.$timezone = request.timezone;

  return {
    properties: out,
    bot: isBot(userAgent, request.verifiedBotCategory),
    page: page === null ? null : page.key,
  };
}

// Client fields the server decides itself, and location finer than the country.
function isRemoved(key: string): boolean {
  return (
    key === "$ip" ||
    key === "ip" ||
    key === "bot" ||
    key === "$bot" ||
    key === "$referrer_source" ||
    key === "$channel" ||
    key === "$as_organization" ||
    key.startsWith("$geoip_")
  );
}

function countryOf(country: string | null): string | null {
  if (country === null || country === "XX" || country === "T1") return null;
  return country;
}

function userAgentOf(properties: Readonly<JsonObject>, request: RequestFacts): string | null {
  const raw = properties.$raw_user_agent;
  if (typeof raw === "string" && raw !== "") return raw;
  return request.userAgent;
}

function fillAgent(properties: JsonObject, agent: Agent | null): void {
  if (agent === null) return;
  if (properties.$browser === undefined) properties.$browser = agent.browser;
  if (properties.$os === undefined) properties.$os = agent.os;
  if (properties.$device_type === undefined) properties.$device_type = agent.deviceType;
  if (properties.$browser_version === undefined && agent.browserVersion !== null) {
    properties.$browser_version = agent.browserVersion;
  }
}

function applyReferrer(properties: JsonObject, cleaned: CleanReferrer): void {
  properties.$referrer = cleaned.referrer;
  properties.$referring_domain = cleaned.referringDomain;
  if (cleaned.source !== null) properties.$referrer_source = cleaned.source;
}

export type { Agent, CleanReferrer };
