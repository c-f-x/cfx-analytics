import { expect, it } from "vitest";
import { cleanReferrer } from "./referrer.ts";

it.each([
  ["no referrer", null],
  ["an empty referrer", ""],
])("enrich-19 · %s is direct", (_name, referrer) => {
  expect(cleanReferrer(referrer, "example.com")).toEqual({
    referrer: "$direct",
    referringDomain: "$direct",
    source: null,
  });
});

it("enrich-19 · a referrer on the same host is direct", () => {
  expect(cleanReferrer("https://example.com/other?x=1", "example.com")).toEqual({
    referrer: "$direct",
    referringDomain: "$direct",
    source: null,
  });
});

it("enrich-19 · another host's referrer is kept", () => {
  const cleaned = cleanReferrer("https://blog.example.net/post?ref=1", "example.com");

  expect(cleaned.referrer).toBe("https://blog.example.net/post");
  expect(cleaned.referringDomain).toBe("blog.example.net");
  expect(cleaned.source).toBeNull();
});

it("enrich-20 · the query string is removed from the referrer", () => {
  const cleaned = cleanReferrer("https://news.ycombinator.com/item?id=123&p=2", "example.com");

  expect(cleaned.referrer).toBe("https://news.ycombinator.com/item");
  expect(cleaned.referrer).not.toContain("?");
});

it("enrich-20 · the fragment is removed from the referrer", () => {
  expect(cleanReferrer("https://example.org/a#section", "example.com").referrer).toBe(
    "https://example.org/a",
  );
});

it("enrich-20 · direct is written as posthog-js writes it, $direct", () => {
  const cleaned = cleanReferrer(null, "example.com");

  expect(cleaned.referrer).toBe("$direct");
  expect(cleaned.referringDomain).toBe("$direct");
});

it.each([
  ["bluesky", "https://bsky.app/profile/alice.bsky.social/post/3kabc"],
  ["x", "https://x.com/alice/status/1234567890"],
  ["hn", "https://news.ycombinator.com/item?id=1234567"],
  ["reddit", "https://www.reddit.com/r/programming/comments/abc123/a_title/"],
  ["facebook", "https://www.facebook.com/someone/posts/123456"],
])("enrich-21 · %s is the source of %s, and no post id is stored", (source, referrer) => {
  const cleaned = cleanReferrer(referrer, "example.com");

  expect(cleaned.source).toBe(source);
  expect(cleaned.source).not.toMatch(/\d/);
});

it.each([
  ["user info", "https://user:secret@www.reddit.com/r/x/comments/abc123/"],
  ["a look-alike domain", "https://reddit.com.evil.example/r/x/comments/abc123/"],
  ["a file: URL", "file:///tmp/notes.html"],
  ["a javascript: URL", "javascript:alert(1)"],
  ["an unparseable URL", "not a url"],
])("enrich-22 · a referrer with %s names no source", (_case, referrer) => {
  expect(cleanReferrer(referrer, "example.com").source).toBeNull();
});

it.each(["file:///tmp/notes.html", "javascript:alert(1)", "not a url"])(
  "enrich-22 · %s is direct",
  (referrer) => {
    expect(cleanReferrer(referrer, "example.com").referrer).toBe("$direct");
  },
);
