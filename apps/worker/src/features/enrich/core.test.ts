import { expect, it } from "vitest";
import { enrich, type RequestFacts } from "./core.ts";

// User agents as the SDKs and real browsers send them (posthog-protocol.md
// §3.3, §9.1, §10.3).
const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.109 Safari/537.36";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const GPTBOT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot";
const POSTHOG_NODE = "posthog-node/5.56.2";
const POSTHOG_IOS = "posthog-ios/3.92.0";

/** A plain browser request's facts, none of them set. */
function facts(overrides: Partial<RequestFacts> = {}): RequestFacts {
  return {
    country: null,
    verifiedBotCategory: null,
    userAgent: null,
    timezone: null,
    ...overrides,
  };
}

it("enrich-01 · the country from request.cf is stored and no finer location is", () => {
  const out = enrich({ $current_url: "https://example.com/" }, facts({ country: "NO" }));

  expect(out.properties.$geoip_country_code).toBe("NO");
  for (const finer of [
    "$geoip_city_name",
    "$geoip_subdivision_1_name",
    "$geoip_postal_code",
    "$geoip_metro_code",
    "$geoip_latitude",
    "$geoip_longitude",
    "$as_organization",
  ]) {
    expect(out.properties).not.toHaveProperty(finer);
  }
});

it("enrich-02 · with no request.cf the country is empty and the event is still stored", () => {
  const out = enrich({ answer: 42 }, facts({ country: null }));

  expect(out.properties.$geoip_country_code ?? "").toBe("");
  expect(out.properties.answer).toBe(42);
});

it.each(["XX", "T1"])("enrich-03 · %s is not a country, so no country is stored", (country) => {
  const out = enrich({}, facts({ country }));

  expect(out.properties.$geoip_country_code ?? "").toBe("");
});

it("enrich-04 · $geoip_disable on the event stops the country being set", () => {
  const out = enrich({ $geoip_disable: true }, facts({ country: "NO" }));

  expect(out.properties.$geoip_country_code ?? "").toBe("");
});

it("enrich-04 · without $geoip_disable, or with it false, the country is set", () => {
  expect(enrich({}, facts({ country: "NO" })).properties.$geoip_country_code).toBe("NO");
  expect(
    enrich({ $geoip_disable: false }, facts({ country: "NO" })).properties.$geoip_country_code,
  ).toBe("NO");
});

it("enrich-05 · the server's country replaces the client's", () => {
  const out = enrich({ $geoip_country_code: "US" }, facts({ country: "NO" }));

  expect(out.properties.$geoip_country_code).toBe("NO");
});

it("enrich-05 · a client $geoip_ property the server cannot fill is removed", () => {
  const out = enrich(
    { $geoip_city_name: "Oslo", $geoip_latitude: 59.91 },
    facts({ country: "NO" }),
  );

  expect(out.properties).not.toHaveProperty("$geoip_city_name");
  expect(out.properties).not.toHaveProperty("$geoip_latitude");
});

it("enrich-05 · with geolocation off, every client $geoip_ property is removed", () => {
  const out = enrich(
    { $geoip_disable: true, $geoip_country_code: "US", $geoip_city_name: "Oslo" },
    facts({ country: "NO" }),
  );

  expect(out.properties).not.toHaveProperty("$geoip_country_code");
  expect(out.properties).not.toHaveProperty("$geoip_city_name");
});

it("enrich-06 · IP properties are removed before the event is stored", () => {
  const out = enrich(
    { $ip: "203.0.113.7", ip: "203.0.113.7", $current_url: "https://example.com/" },
    facts(),
  );

  expect(out.properties).not.toHaveProperty("$ip");
  expect(out.properties).not.toHaveProperty("ip");
  expect(JSON.stringify(out.properties)).not.toContain("203.0.113.7");
});

it("enrich-07 · browser, OS, device and user agent from the SDK are stored as sent", () => {
  const out = enrich(
    {
      $browser: "Firefox",
      $browser_version: 121,
      $os: "Linux",
      $device_type: "Mobile",
      $raw_user_agent: SAFARI_MAC,
    },
    // The header disagrees with every stored value, so a value that survives
    // proves the event's own fields were not parsed again.
    facts({ userAgent: CHROME_WINDOWS }),
  );

  expect(out.properties.$browser).toBe("Firefox");
  expect(out.properties.$browser_version).toBe(121);
  expect(out.properties.$os).toBe("Linux");
  expect(out.properties.$device_type).toBe("Mobile");
  expect(out.properties.$raw_user_agent).toBe(SAFARI_MAC);
});

it("enrich-08 · browser, OS and device missing from the event are parsed from its user agent", () => {
  const out = enrich({ $raw_user_agent: CHROME_WINDOWS }, facts());

  expect(out.properties.$browser).toBe("Chrome");
  expect(out.properties.$browser_version).toBe(120);
  expect(out.properties.$os).toBe("Windows");
  expect(out.properties.$device_type).toBe("Desktop");
});

it("enrich-08 · an iPhone user agent fills in Mobile Safari, iOS and Mobile", () => {
  const out = enrich({ $raw_user_agent: SAFARI_IPHONE }, facts());

  expect(out.properties.$browser).toBe("Mobile Safari");
  expect(out.properties.$os).toBe("iOS");
  expect(out.properties.$device_type).toBe("Mobile");
});

it("enrich-08 · with no user agent at all they stay absent", () => {
  const out = enrich({}, facts({ userAgent: null }));

  expect(out.properties).not.toHaveProperty("$browser");
  expect(out.properties).not.toHaveProperty("$browser_version");
  expect(out.properties).not.toHaveProperty("$os");
  expect(out.properties).not.toHaveProperty("$device_type");
});

it.each([POSTHOG_NODE, POSTHOG_IOS])(
  "enrich-13 · %s derives no browser, OS or device and is not a bot",
  (userAgent) => {
    const out = enrich({}, facts({ userAgent }));

    expect(out.properties).not.toHaveProperty("$browser");
    expect(out.properties).not.toHaveProperty("$browser_version");
    expect(out.properties).not.toHaveProperty("$os");
    expect(out.properties).not.toHaveProperty("$device_type");
    expect(out.bot).toBe(false);
  },
);

it("enrich-16 · a client-sent bot or $bot is removed and the server's value stands", () => {
  const out = enrich({ bot: true, $bot: true }, facts({ userAgent: SAFARI_MAC }));

  expect(out.properties).not.toHaveProperty("bot");
  expect(out.properties).not.toHaveProperty("$bot");
  expect(out.bot).toBe(false);
});

it("enrich-16 · a client claim of no bot does not hide a bot user agent", () => {
  const out = enrich({ bot: false, $bot: false }, facts({ userAgent: GOOGLEBOT }));

  expect(out.bot).toBe(true);
  expect(out.properties).not.toHaveProperty("bot");
  expect(out.properties).not.toHaveProperty("$bot");
});

it.each([
  [GOOGLEBOT, true],
  [POSTHOG_NODE, false],
  [SAFARI_MAC, false],
])(
  "enrich-17 · %s gives the same bot answer from the property and the header",
  (userAgent, bot) => {
    const fromProperty = enrich({ $raw_user_agent: userAgent }, facts({ userAgent: null }));
    const fromHeader = enrich({}, facts({ userAgent }));

    expect(fromProperty.bot).toBe(bot);
    expect(fromHeader.bot).toBe(bot);
  },
);

it("enrich-19 · a referrer on the same host is direct", () => {
  const out = enrich(
    {
      $current_url: "https://example.com/article",
      $referrer: "https://example.com/other?x=1",
      $referring_domain: "example.com",
    },
    facts(),
  );

  expect(out.properties.$referrer).toBe("$direct");
  expect(out.properties.$referring_domain).toBe("$direct");
  expect(out.properties).not.toHaveProperty("$referrer_source");
});

it("enrich-19 · another host's referrer keeps that host", () => {
  const out = enrich(
    {
      $current_url: "https://example.com/article",
      $referrer: "https://blog.example.net/post?ref=1",
      $referring_domain: "blog.example.net",
    },
    facts(),
  );

  expect(out.properties.$referrer).toBe("https://blog.example.net/post");
  expect(out.properties.$referring_domain).toBe("blog.example.net");
});

it("enrich-21 · a known referrer source is stored as a name, not a post id", () => {
  const out = enrich(
    {
      $current_url: "https://example.com/article",
      $referrer: "https://www.reddit.com/r/programming/comments/abc123/a_title/",
      $referring_domain: "www.reddit.com",
    },
    facts(),
  );

  expect(out.properties.$referrer_source).toBe("reddit");
});

it("enrich-23 · the page is the page key of $current_url", () => {
  const out = enrich({ $current_url: "https://Example.COM./a/b?utm_source=x#top" }, facts());

  expect(out.page).toBe("example.com/a/b");
});

it("enrich-23 · no $current_url leaves the page empty", () => {
  expect(enrich({}, facts()).page).toBeNull();
});

it("enrich-23 · a URL that cannot be parsed leaves the page empty and the event stored", () => {
  const out = enrich({ $current_url: "not a url", answer: 42 }, facts());

  expect(out.page).toBeNull();
  expect(out.properties.answer).toBe(42);
});

it("enrich-24 · utm properties are filled from $current_url, and the explicit one wins", () => {
  const out = enrich(
    {
      $current_url:
        "https://example.com/?utm_source=newsletter&utm_medium=email&utm_campaign=spring",
      utm_source: "affiliate",
    },
    facts(),
  );

  expect(out.properties.utm_source).toBe("affiliate");
  expect(out.properties.utm_medium).toBe("email");
  expect(out.properties.utm_campaign).toBe("spring");
});

it("enrich-25 · a host with capitals and a trailing dot is lower-cased without the dot", () => {
  const out = enrich({ $host: "Example.COM." }, facts());

  expect(out.properties.$host).toBe("example.com");
});

it("enrich-26 · the client's timezone wins over the request's", () => {
  const out = enrich({ $timezone: "Europe/Oslo" }, facts({ timezone: "America/New_York" }));

  expect(out.properties.$timezone).toBe("Europe/Oslo");
});

it("enrich-26 · the request's timezone is used only when the client sent none", () => {
  const out = enrich({}, facts({ timezone: "America/New_York" }));

  expect(out.properties.$timezone).toBe("America/New_York");
});

it("enrich-27 · an AI crawler sets the one bot flag and adds no actor or class", () => {
  const out = enrich({ answer: 42 }, facts({ userAgent: GPTBOT }));

  expect(out.bot).toBe(true);
  expect(Object.keys(out.properties).filter((key) => /bot|actor|class/i.test(key))).toEqual([]);
});

it("enrich-40 · the event gets its $channel from the cleaned referrer and the URL's campaign tags", () => {
  const search = enrich(
    { $current_url: "https://example.com/", $referrer: "https://www.google.com/search?q=x" },
    facts(),
  );
  expect(search.properties.$channel).toBe("organic_search");
  const paid = enrich(
    { $current_url: "https://example.com/?utm_source=google&utm_medium=cpc", $channel: "made up" },
    facts(),
  );
  expect(paid.properties.$channel).toBe("paid_search");
  expect(enrich({ $current_url: "https://example.com/" }, facts()).properties.$channel).toBe(
    "direct",
  );
});
