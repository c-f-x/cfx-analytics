// Referrer cleaning (enrich-19 to enrich-22). The query string is dropped,
// since search words can hold personal data. Written to the specification;
// the idea comes from traks' referrer cleaner (docs/donors.md), and no code is
// copied, so no notice is needed.

import { normaliseHost, parseUrl } from "./page.ts";

export interface CleanReferrer {
  /** The referrer without query string and fragment, or "$direct". */
  referrer: string;
  /** The referrer's host, or "$direct". */
  referringDomain: string;
  /** "bluesky", "x", "hn", "reddit" or "facebook" for a known source, else null. */
  source: string | null;
}

const SOURCES: ReadonlyArray<readonly [domain: string, source: string]> = [
  ["bsky.app", "bluesky"],
  ["x.com", "x"],
  ["news.ycombinator.com", "hn"],
  ["reddit.com", "reddit"],
  ["facebook.com", "facebook"],
];

/**
 * Cleans a referrer seen on a page of `pageHost`. Empty, unparseable, `file:`,
 * `javascript:` and same-host referrers are direct; a URL with user info or a
 * look-alike domain (`reddit.com.evil.example`) names no source. Pure.
 */
export function cleanReferrer(referrer: string | null, pageHost: string | null): CleanReferrer {
  if (referrer === null || referrer === "") return direct();

  const parsed = parseUrl(referrer);
  if (parsed === null) return direct();
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return direct();

  const host = normaliseHost(parsed.hostname);
  if (host === "") return direct();
  if (pageHost !== null && host === normaliseHost(pageHost)) return direct();

  // `origin` drops user info and the default port, so neither is stored.
  const hasUserInfo = parsed.username !== "" || parsed.password !== "";
  return {
    referrer: `${parsed.origin}${parsed.pathname}`,
    referringDomain: host,
    source: hasUserInfo ? null : sourceOf(host),
  };
}

function direct(): CleanReferrer {
  return { referrer: "$direct", referringDomain: "$direct", source: null };
}

function sourceOf(host: string): string | null {
  for (const [domain, source] of SOURCES) {
    if (host === domain || host.endsWith(`.${domain}`)) return source;
  }
  return null;
}
