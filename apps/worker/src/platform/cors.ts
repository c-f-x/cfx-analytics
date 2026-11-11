// CORS for the paths SDKs call: capture, /s/, /flags, remote config and the
// scripts (intake-12, posthog-protocol.md §2.4). Dashboard and external query
// paths get no CORS headers at all (platform-11).

/**
 * The origin to mirror: scheme and host lower-cased, default port and path
 * dropped, as `https://example.com`. Null when the Origin header is absent or
 * not an http(s) URL, and then no allow-origin header is sent.
 */
export function mirroredOrigin(origin: string | null): string | null {
  if (origin === null) return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // URL.origin lower-cases the host and leaves out a default port and any path.
  return url.origin;
}

/**
 * The headers every answer on an SDK path carries, preflight or not, including
 * 401 and 413: Access-Control-Allow-Origin (the mirrored origin, never "*",
 * left out when null), Access-Control-Allow-Credentials "true" (only with an
 * origin), Access-Control-Allow-Methods "GET, POST, OPTIONS",
 * Access-Control-Allow-Headers echoing `requestedHeaders` when given, and
 * Vary "Origin". A preflight also carries Access-Control-Max-Age "86400".
 */
export function sdkCorsHeaders(
  origin: string | null,
  requestedHeaders: string | null,
  preflight: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    Vary: "Origin",
  };
  if (origin !== null) {
    headers["Access-Control-Allow-Origin"] = origin;
    // sendBeacon sends credentials, and a browser refuses a wildcard origin in that mode.
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  if (requestedHeaders !== null) headers["Access-Control-Allow-Headers"] = requestedHeaders;
  if (preflight) headers["Access-Control-Max-Age"] = "86400";
  return headers;
}
