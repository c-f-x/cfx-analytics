import { type BuiltinDimension, builtinDimension } from "@cfanalytics/shared";

// The words the dashboard uses for what the API names in code.

export const DIMENSION_LABELS: Record<BuiltinDimension, string> = {
  event: "Event",
  page: "Page",
  referring_domain: "Referring site",
  country: "Country",
  device_type: "Device",
  browser: "Browser",
  os: "System",
  utm_source: "Campaign source",
  utm_medium: "Campaign medium",
  utm_campaign: "Campaign",
  channel: "Channel",
};

const CHANNELS: Record<string, string> = {
  paid_search: "Paid search",
  paid_social: "Paid social",
  email: "Email",
  social: "Social",
  organic_search: "Search",
  referral: "Other sites",
  direct: "Direct",
  other: "Other campaigns",
};

const countries = new Intl.DisplayNames(["en"], { type: "region" });

/** A page key (host plus path, enrich-23) as its path, which is how a page reads on screen. */
export const pathOf = (pageKey: string): string => pageKey.replace(/^[^/]*/, "") || "/";

/** A dimension's value as the owner reads it: a channel's name, a country's name, "(none)" for null. */
export function valueLabel(
  dimension: BuiltinDimension | null,
  key: string | number | boolean | null | undefined,
): string {
  if (key === null || key === undefined || key === "") return "(none)";
  const text = String(key);
  if (dimension === "channel") return CHANNELS[text] ?? text;
  if (dimension === "country" && /^[A-Z]{2}$/.test(text)) {
    try {
      return countries.of(text) ?? text;
    } catch {
      return text;
    }
  }
  if (dimension === "referring_domain" && text === "DIRECT") return "Direct";
  if (dimension === "page") return pathOf(text);
  return text;
}

/** The event property a dimension's row filters on. */
const FILTER_PROPERTIES: Partial<Record<BuiltinDimension, string>> = {
  page: "$pathname",
  channel: "$channel",
  country: "$geoip_country_code",
  device_type: "$device_type",
  browser: "$browser",
  os: "$os",
  referring_domain: "$referring_domain",
  utm_source: "utm_source",
  utm_medium: "utm_medium",
  utm_campaign: "utm_campaign",
};

/** A filter's property as the owner reads it: the dimension's name when a row made it, else the property itself. */
export function propertyLabel(property: string): string {
  const dimension = builtinDimension.options.find((each) => FILTER_PROPERTIES[each] === property);
  return dimension === undefined ? property : DIMENSION_LABELS[dimension];
}

/** The property a breakdown row filters on when clicked, and the value it compares; null for none. */
export function filterOf(
  dimension: BuiltinDimension,
  key: unknown,
): { property: string; value: string } | null {
  if (typeof key !== "string" || key === "") return null;
  if (dimension === "page") return { property: "$pathname", value: pathOf(key) };
  if (dimension === "referring_domain" && key === "DIRECT")
    return { property: "$referring_domain", value: "$direct" };
  const property = FILTER_PROPERTIES[dimension];
  return property === undefined ? null : { property, value: key };
}
