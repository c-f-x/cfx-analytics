import { expect, it } from "vitest";
import { isBot } from "./bots.ts";

// User agents as the crawlers, scripts and browsers send them (D-20).
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const BINGBOT = "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)";
const YANDEXBOT = "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)";
const GPTBOT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot";
const CHATGPT_USER =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const OAI_SEARCHBOT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot";
const CLAUDEBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0)";
const PERPLEXITYBOT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)";
const GOOGLE_EXTENDED =
  "Mozilla/5.0 (compatible; Google-Extended/1.0; +http://www.google.com/bot.html)";
const APPLEBOT_EXTENDED = "Mozilla/5.0 (compatible; Applebot-Extended/1.0)";
const HEADLESS_CHROME =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36";
const CURL = "curl/8.4.0";
const PYTHON_REQUESTS = "python-requests/2.31.0";
const MYSTERY_BOT = "Mozilla/5.0 (compatible; MysteryBot/2.0)";
const AHREFS_BOT = "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)";
const FACEBOOK_EXTERNALHIT =
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
const LIGHTHOUSE =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Chrome-Lighthouse";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15";
const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.109 Safari/537.36";
const POSTHOG_NODE = "posthog-node/5.56.2";
const POSTHOG_IOS = "posthog-ios/3.92.0";

it.each([
  ["Googlebot", GOOGLEBOT],
  ["bingbot", BINGBOT],
  ["YandexBot", YANDEXBOT],
  ["GPTBot", GPTBOT],
  ["ClaudeBot", CLAUDEBOT],
  ["PerplexityBot", PERPLEXITYBOT],
  ["HeadlessChrome", HEADLESS_CHROME],
  ["curl", CURL],
  ["python-requests", PYTHON_REQUESTS],
])("enrich-14 · %s is a bot", (_name, userAgent) => {
  expect(isBot(userAgent, null)).toBe(true);
});

it("enrich-14 · a Cloudflare verified-bot category marks the event a bot", () => {
  expect(isBot(SAFARI_MAC, "Search Engine")).toBe(true);
  expect(isBot(null, "AI Crawler")).toBe(true);
});

it("enrich-15 · an ordinary Safari user agent is not a bot", () => {
  expect(isBot(SAFARI_MAC, null)).toBe(false);
});

it("enrich-15 · a missing user agent alone is not a bot", () => {
  expect(isBot(null, null)).toBe(false);
});

// A browser with many extensions can send a user agent this long.
const LONG_SAFARI = `${SAFARI_MAC}${" Extension/1.0".repeat(40)}`;

it("enrich-15 · a user agent over 512 characters alone is not a bot", () => {
  expect(LONG_SAFARI.length).toBeGreaterThan(512);
  expect(isBot(LONG_SAFARI, null)).toBe(false);
});

it("enrich-15 · a user agent over 512 characters that names a bot is a bot", () => {
  const longGooglebot = `${GOOGLEBOT}${" Extension/1.0".repeat(40)}`;
  expect(longGooglebot.length).toBeGreaterThan(512);
  expect(isBot(longGooglebot, null)).toBe(true);
});

it.each([POSTHOG_NODE, POSTHOG_IOS])(
  "enrich-13 · %s is never a bot, whatever the provenance",
  (userAgent) => {
    expect(isBot(userAgent, null)).toBe(false);
    expect(isBot(userAgent, "Search Engine")).toBe(false);
  },
);

it("enrich-18 · an ordinary Chrome user agent is not a bot without provenance", () => {
  expect(isBot(CHROME_WINDOWS, null)).toBe(false);
});

it("enrich-18 · an ordinary Safari user agent is not a bot without provenance", () => {
  expect(isBot(SAFARI_MAC, null)).toBe(false);
});

it.each([
  ["GPTBot", GPTBOT],
  ["ChatGPT-User", CHATGPT_USER],
  ["OAI-SearchBot", OAI_SEARCHBOT],
  ["ClaudeBot", CLAUDEBOT],
  ["PerplexityBot", PERPLEXITYBOT],
  ["Google-Extended", GOOGLE_EXTENDED],
  ["Applebot-Extended", APPLEBOT_EXTENDED],
  ["Googlebot and Google-Extended", `${GOOGLEBOT} Google-Extended`],
])("enrich-27 · %s is a bot and the answer is one flag", (_name, userAgent) => {
  expect(isBot(userAgent, null)).toBe(true);
});

it("enrich-28 · a bot name inside a longer token is still a bot", () => {
  expect(isBot("Mozilla/5.0 (compatible; gptbotmalicious/1.0)", null)).toBe(true);
});

it.each([
  ["MysteryBot", MYSTERY_BOT],
  ["AhrefsBot", AHREFS_BOT],
  ["facebookexternalhit", FACEBOOK_EXTERNALHIT],
  ["Lighthouse", LIGHTHOUSE],
])("enrich-28 · %s is a bot", (_name, userAgent) => {
  expect(isBot(userAgent, null)).toBe(true);
});

it.each([
  "Mozilla/5.0 (Linux; Android 9; SM-G960F) BaiduBrowser/11.4",
  "Mozilla/5.0 (Windows NT 10.0) YandexTranslate/1.0",
])("enrich-36 · %s names a crawler's vendor but is not a crawler", (userAgent) => {
  expect(isBot(userAgent, null)).toBe(false);
});
