import { expect, it } from "vitest";
import { type Browser, type DeviceType, type Os, parseAgent } from "./agent.ts";

// Real user agents for each browser and OS the parser names (enrich-09 to
// enrich-13).
const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.109 Safari/537.36";
const EDGE_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.91";
const OPERA_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 OPR/105.0.0.0";
const FIREFOX_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";
const SAFARI_IPAD =
  "Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID_MOBILE =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
const CHROME_ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CHROME_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CHROMEOS =
  "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const UNKNOWN_CLIENT = "MyClient/1.0";

it.each<[string, string, Browser]>([
  ["Chrome on Windows", CHROME_WINDOWS, "Chrome"],
  ["Edge on Windows", EDGE_WINDOWS, "Edge"],
  ["Opera on Windows", OPERA_WINDOWS, "Opera"],
  ["Firefox on Windows", FIREFOX_WINDOWS, "Firefox"],
  ["Safari on macOS", SAFARI_MAC, "Safari"],
  ["Safari on an iPhone", SAFARI_IPHONE, "Mobile Safari"],
  ["an unknown client", UNKNOWN_CLIENT, "Other"],
])("enrich-09 · %s is the browser %s", (_name, userAgent, browser) => {
  expect(parseAgent(userAgent)?.browser).toBe(browser);
});

it.each<[string, string, Os]>([
  ["Chrome on Windows", CHROME_WINDOWS, "Windows"],
  ["Safari on a Mac", SAFARI_MAC, "macOS"],
  ["Safari on an iPhone", SAFARI_IPHONE, "iOS"],
  ["Chrome on an Android phone", CHROME_ANDROID_MOBILE, "Android"],
  ["Chrome on Linux", CHROME_LINUX, "Linux"],
  ["Chrome on a Chromebook", CHROMEOS, "ChromeOS"],
  ["an unknown client", UNKNOWN_CLIENT, "Other"],
])("enrich-10 · %s has the OS %s", (_name, userAgent, os) => {
  expect(parseAgent(userAgent)?.os).toBe(os);
});

it.each<[string, string, DeviceType]>([
  ["Safari on an iPhone", SAFARI_IPHONE, "Mobile"],
  ["Chrome on an Android phone", CHROME_ANDROID_MOBILE, "Mobile"],
  ["Safari on an iPad", SAFARI_IPAD, "Tablet"],
  ["Chrome on an Android tablet", CHROME_ANDROID_TABLET, "Tablet"],
  ["Chrome on Windows", CHROME_WINDOWS, "Desktop"],
  ["Safari on a Mac", SAFARI_MAC, "Desktop"],
])("enrich-11 · %s is the device %s", (_name, userAgent, deviceType) => {
  expect(parseAgent(userAgent)?.deviceType).toBe(deviceType);
});

it("enrich-11 · an iPad is Tablet and iOS", () => {
  const agent = parseAgent(SAFARI_IPAD);

  expect(agent?.deviceType).toBe("Tablet");
  expect(agent?.os).toBe("iOS");
});

it.each([
  ["Chrome on Windows", CHROME_WINDOWS, 120],
  ["Edge on Windows", EDGE_WINDOWS, 120],
  ["Firefox on Windows", FIREFOX_WINDOWS, 121],
  ["Safari on a Mac", SAFARI_MAC, 17],
])("enrich-12 · %s stores the major version %i only", (_name, userAgent, major) => {
  const version = parseAgent(userAgent)?.browserVersion;

  expect(version).toBe(major);
  expect(Number.isInteger(version)).toBe(true);
});

it("enrich-12 · a browser with no version number stores null", () => {
  expect(parseAgent(UNKNOWN_CLIENT)?.browserVersion).toBeNull();
});

it.each(["posthog-node/5.56.2", "posthog-ios/3.92.0"])(
  "enrich-13 · %s names no browser, so nothing is derived",
  (userAgent) => {
    expect(parseAgent(userAgent)).toBeNull();
  },
);
