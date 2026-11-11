import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mirroredOrigin, sdkCorsHeaders } from "./cors.ts";

/** The headers as an HTTP answer carries them, so their spelling does not matter. */
function headersOf(origin: string | null, requestedHeaders: string | null, preflight: boolean) {
  return new Response(null, { headers: sdkCorsHeaders(origin, requestedHeaders, preflight) })
    .headers;
}

describe("mirroredOrigin", () => {
  it("intake-12 · the origin is lower-cased and carries no path, query or default port", () => {
    expect(mirroredOrigin("HTTPS://Example.COM/Path?Q=1")).toBe("https://example.com");
    expect(mirroredOrigin("http://Example.com:80")).toBe("http://example.com");
    expect(mirroredOrigin("https://Example.com:443")).toBe("https://example.com");
    expect(mirroredOrigin("https://Example.com:8443/Path")).toBe("https://example.com:8443");
  });

  it("intake-12 · a missing or non-URL origin mirrors nothing", () => {
    expect(mirroredOrigin(null)).toBeNull();
    expect(mirroredOrigin("")).toBeNull();
    expect(mirroredOrigin("null")).toBeNull();
    expect(mirroredOrigin("not a url")).toBeNull();
    expect(mirroredOrigin("ftp://example.com")).toBeNull();
  });
});

describe("sdkCorsHeaders", () => {
  it("intake-12 · a preflight mirrors the origin, allows credentials and echoes the request", () => {
    const headers = headersOf("https://app.test", "content-type, x-custom", true);
    expect(headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(headers.get("access-control-allow-credentials")).toBe("true");
    expect(headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(headers.get("access-control-allow-headers")).toBe("content-type, x-custom");
    expect(headers.get("access-control-max-age")).toBe("86400");
    expect(headers.get("vary")).toBe("Origin");
  });

  it("intake-12 · an ordinary answer carries the same headers without the preflight age", () => {
    const headers = headersOf("https://app.test", "content-type", false);
    expect(headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(headers.get("access-control-allow-credentials")).toBe("true");
    expect(headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(headers.get("access-control-allow-headers")).toBe("content-type");
    expect(headers.get("access-control-max-age")).toBeNull();
    expect(headers.get("vary")).toBe("Origin");
  });

  it("intake-12 · with no origin there is no allow-origin header, never a wildcard", () => {
    const headers = headersOf(null, null, true);
    expect(headers.get("access-control-allow-origin")).toBeNull();
    expect(headers.get("access-control-allow-credentials")).toBeNull();
    expect(headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect(headers.get("access-control-allow-headers")).toBeNull();
    expect(headers.get("access-control-max-age")).toBe("86400");
    expect(headers.get("vary")).toBe("Origin");
  });
});

describe("dashboard paths", () => {
  it("platform-11 · a preflight on a dashboard path carries no allow-origin header", async () => {
    const paths = ["/", "/api/projects/0190f3b0-7c00-7000-8000-000000000000"];
    const responses = await Promise.all(
      ["https://one.test", "https://two.test"].flatMap((origin) =>
        paths.map((path) =>
          SELF.fetch(`https://intake.test${path}`, { method: "OPTIONS", headers: { origin } }),
        ),
      ),
    );
    for (const [index, response] of responses.entries()) {
      // "/" serves the dashboard's page (D-27); only the API needs a session.
      if (paths[index % paths.length] !== "/") expect(response.status).toBe(401);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
});
