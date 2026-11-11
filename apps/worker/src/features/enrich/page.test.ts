import { expect, it } from "vitest";
import { pageKey, utmFromUrl } from "./page.ts";

it("enrich-23 · the page key is the lower-cased host plus the path", () => {
  expect(pageKey("https://Example.COM/a/b")).toEqual({
    host: "example.com",
    path: "/a/b",
    key: "example.com/a/b",
  });
});

it("enrich-23 · a trailing dot comes off the host", () => {
  expect(pageKey("https://Example.COM./a")).toEqual({
    host: "example.com",
    path: "/a",
    key: "example.com/a",
  });
});

it("enrich-23 · repeated slashes collapse", () => {
  expect(pageKey("https://example.com//a///b")).toEqual({
    host: "example.com",
    path: "/a/b",
    key: "example.com/a/b",
  });
});

it("enrich-23 · the query string and fragment are dropped", () => {
  expect(pageKey("https://example.com/a/b?utm_source=x&p=2#section")).toEqual({
    host: "example.com",
    path: "/a/b",
    key: "example.com/a/b",
  });
});

it("enrich-23 · the default port and user info are dropped", () => {
  expect(pageKey("https://user:secret@example.com:443/a")).toEqual({
    host: "example.com",
    path: "/a",
    key: "example.com/a",
  });
  expect(pageKey("http://example.com:80/a")).toEqual({
    host: "example.com",
    path: "/a",
    key: "example.com/a",
  });
});

it("enrich-23 · a query-only URL has the path /", () => {
  expect(pageKey("https://example.com?utm_source=x")).toEqual({
    host: "example.com",
    path: "/",
    key: "example.com/",
  });
});

it("enrich-23 · the root keeps its slash", () => {
  expect(pageKey("https://example.com/")).toEqual({
    host: "example.com",
    path: "/",
    key: "example.com/",
  });
  expect(pageKey("https://example.com")).toEqual({
    host: "example.com",
    path: "/",
    key: "example.com/",
  });
});

it("enrich-23 · a URL that cannot be parsed has no page key", () => {
  expect(pageKey("not a url")).toBeNull();
});

it("enrich-23 · a URL that is not http(s) has no page key", () => {
  expect(pageKey("file:///tmp/notes.html")).toBeNull();
  expect(pageKey("javascript:alert(1)")).toBeNull();
});

it("enrich-24 · a utm property missing from the event is filled from the URL", () => {
  expect(
    utmFromUrl(
      "https://example.com/?utm_source=newsletter&utm_medium=email&utm_campaign=spring",
      {},
    ),
  ).toEqual({ utm_source: "newsletter", utm_medium: "email", utm_campaign: "spring" });
});

it("enrich-24 · an explicit property wins over the URL", () => {
  const filled = utmFromUrl("https://example.com/?utm_source=newsletter&utm_medium=email", {
    utm_source: "affiliate",
  });

  expect(filled).not.toHaveProperty("utm_source");
  expect(filled.utm_medium).toBe("email");
});

it("enrich-24 · an explicit empty property still wins over the URL", () => {
  expect(
    utmFromUrl("https://example.com/?utm_source=newsletter", { utm_source: "" }),
  ).not.toHaveProperty("utm_source");
});

it("enrich-24 · an empty value in the URL fills nothing", () => {
  expect(utmFromUrl("https://example.com/?utm_source=&utm_medium=", {})).toEqual({});
});

it("enrich-24 · a URL that cannot be parsed fills nothing", () => {
  expect(utmFromUrl("not a url", {})).toEqual({});
});

it.each(["javascript:alert(1)", "ftp://example.com/foo", "data:text/plain,hi"])(
  "enrich-37 · %s is not a web page, so it has no page key",
  (url) => {
    expect(pageKey(url)).toBeNull();
  },
);

it("enrich-38 · a trailing slash comes off a path, so /pricing/ and /pricing are one page", () => {
  expect(pageKey("https://example.com/pricing/")?.key).toBe("example.com/pricing");
  expect(pageKey("https://example.com/pricing")?.key).toBe("example.com/pricing");
  expect(pageKey("https://example.com/a//b//")?.key).toBe("example.com/a/b");
  expect(pageKey("https://example.com/")?.path).toBe("/");
});
