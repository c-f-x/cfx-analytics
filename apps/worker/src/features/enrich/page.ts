import type { JsonObject } from "@cfanalytics/shared";

// One page key for events and heatmaps (enrich-23, enrich-25, heatmaps-01).

export interface PageKey {
  /** Lower-cased, with a trailing dot removed: `example.com`. */
  host: string;
  /** Repeated slashes collapsed, no trailing slash, no query or fragment; `/` for the root. */
  path: string;
  /** host + path, as stored in events.page. */
  key: string;
}

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign"] as const;

/** The page key of a URL, or null when it does not parse or is not http(s). Pure. */
export function pageKey(url: string): PageKey | null {
  const parsed = parseUrl(url);
  if (parsed === null) return null;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const host = normaliseHost(parsed.host);
  if (host === "") return null;

  // Repeated slashes collapse, and a trailing one comes off all but the root,
  // so /pricing/ and /pricing are one page (enrich-23, enrich-38).
  const collapsed = parsed.pathname.replace(/\/{2,}/g, "/");
  const path = collapsed.length > 1 ? collapsed.replace(/\/$/, "") : "/";
  return { host, path, key: `${host}${path}` };
}

/**
 * utm_source, utm_medium and utm_campaign from the URL's query, for the ones
 * `properties` does not already hold; an explicit property wins and an empty
 * value fills nothing, and a URL that does not parse fills nothing (enrich-24).
 * Pure.
 */
export function utmFromUrl(url: string, properties: Readonly<JsonObject>): Record<string, string> {
  const parsed = parseUrl(url);
  if (parsed === null) return {};

  const filled: Record<string, string> = {};
  for (const key of UTM_KEYS) {
    if (Object.hasOwn(properties, key)) continue;
    const value = parsed.searchParams.get(key);
    if (value !== null && value !== "") filled[key] = value;
  }
  return filled;
}

/** The URL, or null when it does not parse. Pure. */
export function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** A host lower-cased, trimmed, with a trailing dot removed (enrich-25). Pure. */
export function normaliseHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}
