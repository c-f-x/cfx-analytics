import { expect, it } from "vitest";
import { channelOf } from "./channel.ts";

// One fixed map from a visit's referring domain and campaign tags to its
// traffic channel (enrich-40). The cases walk the map in its order.

it("enrich-40 · a paid medium is paid search, or paid social when its source or referrer is social", () => {
  expect(channelOf("www.google.com", "google", "cpc")).toBe("paid_search");
  expect(channelOf("$direct", "bing", "ppc")).toBe("paid_search");
  expect(channelOf("$direct", "newsletter", "paid")).toBe("paid_search");
  expect(channelOf("$direct", "facebook", "cpc")).toBe("paid_social");
  expect(channelOf("l.instagram.com", null, "paid")).toBe("paid_social");
  expect(channelOf("$direct", "linkedin", "paid_social")).toBe("paid_social");
});

it("enrich-40 · an email medium or source is email, ahead of the referrer", () => {
  expect(channelOf("mail.google.com", "newsletter", "email")).toBe("email");
  expect(channelOf("$direct", "newsletter", null)).toBe("email");
  expect(channelOf("$direct", null, "e-mail")).toBe("email");
});

it("enrich-40 · a social medium, or a social site's domain, is social", () => {
  expect(channelOf("$direct", "mastodon", "social")).toBe("social");
  expect(channelOf("t.co", null, null)).toBe("social");
  expect(channelOf("www.reddit.com", null, null)).toBe("social");
  expect(channelOf("bsky.app", null, null)).toBe("social");
  expect(channelOf("news.ycombinator.com", null, null)).toBe("social");
});

it("enrich-40 · a search engine's domain is organic search, matched on the whole label", () => {
  expect(channelOf("www.google.com", null, null)).toBe("organic_search");
  expect(channelOf("www.google.co.uk", null, null)).toBe("organic_search");
  expect(channelOf("duckduckgo.com", null, null)).toBe("organic_search");
  expect(channelOf("www.bing.com", null, null)).toBe("organic_search");
  expect(channelOf("search.brave.com", null, null)).toBe("organic_search");
  // A look-alike is a referral, not a search engine.
  expect(channelOf("notgoogle.com", null, null)).toBe("referral");
});

it("enrich-40 · any other domain is referral, a campaign tag alone is other, and nothing is direct", () => {
  expect(channelOf("blog.example.com", null, null)).toBe("referral");
  expect(channelOf("$direct", "partner", "affiliate")).toBe("other");
  expect(channelOf("$direct", "partner", null)).toBe("other");
  expect(channelOf("$direct", null, null)).toBe("direct");
  expect(channelOf("$direct", "", "  ")).toBe("direct");
});

it("enrich-40 · tags are read without case or surrounding blanks", () => {
  expect(channelOf("$direct", " Google ", " CPC ")).toBe("paid_search");
  expect(channelOf("$direct", null, "Email")).toBe("email");
});
