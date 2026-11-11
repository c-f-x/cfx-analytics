// Traffic channels (enrich-40): one fixed map from a visit's cleaned
// referring domain and its campaign tags, applied once at intake and stored
// as `$channel`, so breakdowns and filters read one value (query-127). Written
// to the specification after InsightFlare's channel rules (docs/donors.md);
// no code is copied. Pure.

export type Channel =
  | "paid_search"
  | "paid_social"
  | "email"
  | "social"
  | "organic_search"
  | "referral"
  | "direct"
  | "other";

const PAID_SEARCH_MEDIA: readonly string[] = [
  "cpc",
  "ppc",
  "paid",
  "paidsearch",
  "paid_search",
  "paid-search",
  "sem",
];
const PAID_SOCIAL_MEDIA: readonly string[] = [
  "paid_social",
  "paidsocial",
  "paid-social",
  "social_paid",
  "cpm",
];
const EMAIL_TAGS: readonly string[] = ["email", "e-mail", "newsletter"];
const SOCIAL_MEDIA: readonly string[] = [
  "social",
  "social-network",
  "social_network",
  "social-media",
  "sm",
];
const SOCIAL_SOURCES: readonly string[] = [
  "facebook",
  "fb",
  "instagram",
  "ig",
  "twitter",
  "x",
  "linkedin",
  "reddit",
  "youtube",
  "tiktok",
  "pinterest",
  "bluesky",
  "threads",
  "mastodon",
];
const SOCIAL_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "t.co",
  "x.com",
  "twitter.com",
  "linkedin.com",
  "lnkd.in",
  "reddit.com",
  "youtube.com",
  "tiktok.com",
  "pinterest.com",
  "bsky.app",
  "threads.net",
  "mastodon.social",
  "news.ycombinator.com",
];
const SEARCH_DOMAINS = [
  "bing.com",
  "duckduckgo.com",
  "yahoo.com",
  "baidu.com",
  "ecosia.org",
  "search.brave.com",
  "startpage.com",
  "kagi.com",
  "qwant.com",
];
/** Search engines with a domain per country, matched as a whole label before any TLD: www.google.co.uk. */
const SEARCH_LABELS = /(^|\.)(google|yandex)\.[a-z.]+$/;

/** A tag lower-cased and trimmed; blank is none. */
function tagOf(value: string | null): string | null {
  const tag = value?.trim().toLowerCase() ?? "";
  return tag === "" ? null : tag;
}

/** The host is `domain` or one of its subdomains, never a look-alike such as notgoogle.com. */
const onDomain = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

/**
 * The channel of a visit, in this order: a paid medium (paid social when its
 * medium, source or referrer is social, else paid search); an email medium or
 * source; a social medium; a social site's or a search engine's domain; any
 * other domain as referral; a campaign tag alone as other; else direct.
 * `referringDomain` is cleanReferrer's, "$direct" when there is none.
 */
export function channelOf(
  referringDomain: string,
  utmSource: string | null,
  utmMedium: string | null,
): Channel {
  const source = tagOf(utmSource);
  const medium = tagOf(utmMedium);
  const host = referringDomain === "$direct" ? null : referringDomain.toLowerCase();
  const socialHost = host !== null && SOCIAL_DOMAINS.some((domain) => onDomain(host, domain));
  const socialSource = source !== null && SOCIAL_SOURCES.includes(source);

  if (medium !== null && PAID_SOCIAL_MEDIA.includes(medium)) return "paid_social";
  if (medium !== null && PAID_SEARCH_MEDIA.includes(medium)) {
    return socialSource || socialHost ? "paid_social" : "paid_search";
  }
  if (
    (medium !== null && EMAIL_TAGS.includes(medium)) ||
    (source !== null && EMAIL_TAGS.includes(source))
  ) {
    return "email";
  }
  if (medium !== null && SOCIAL_MEDIA.includes(medium)) return "social";
  if (host !== null) {
    if (socialHost) return "social";
    if (SEARCH_LABELS.test(host) || SEARCH_DOMAINS.some((domain) => onDomain(host, domain))) {
      return "organic_search";
    }
    return "referral";
  }
  if (source !== null || medium !== null) return "other";
  return "direct";
}
