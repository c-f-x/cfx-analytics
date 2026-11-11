// Browser, OS and device from a user agent, only where the SDK sent none
// (enrich-07 to enrich-12). The names are posthog-js's own, so a breakdown
// does not split one browser into two labels.

export type Browser =
  | "Chrome"
  | "Edge"
  | "Opera"
  | "Firefox"
  | "Safari"
  | "Mobile Safari"
  | "Other";
export type Os = "Windows" | "macOS" | "iOS" | "Android" | "Linux" | "ChromeOS" | "Other";
export type DeviceType = "Mobile" | "Tablet" | "Desktop";

export interface Agent {
  browser: Browser;
  /** The major version only, or null when none is found (enrich-12). */
  browserVersion: number | null;
  os: Os;
  deviceType: DeviceType;
}

const SDK_AGENT = /^posthog-(?:node|ios)\//i;

/** Whether the user agent is posthog-node's or posthog-ios's. Pure. */
export function isSdkAgent(userAgent: string): boolean {
  return SDK_AGENT.test(userAgent);
}

/**
 * Parses a browser user agent. Edge (`Edg/`) and Opera (`OPR/`) win over
 * Chrome; an iPad is Tablet and iOS; an Android user agent with `Mobile` is
 * Mobile, without it Tablet. Returns null for posthog-node and posthog-ios
 * agents, which name no browser (enrich-13). Pure.
 */
export function parseAgent(userAgent: string): Agent | null {
  if (isSdkAgent(userAgent)) return null;

  const browser = browserOf(userAgent);
  return {
    browser: browser.name,
    browserVersion: browser.version,
    os: osOf(userAgent),
    deviceType: deviceOf(userAgent),
  };
}

function browserOf(userAgent: string): { name: Browser; version: number | null } {
  const edge = /Edg\/(\d+)/.exec(userAgent);
  if (edge !== null) return { name: "Edge", version: majorOf(edge[1]) };

  const opera = /OPR\/(\d+)/.exec(userAgent);
  if (opera !== null) return { name: "Opera", version: majorOf(opera[1]) };

  const chrome = /Chrome\/(\d+)/.exec(userAgent);
  if (chrome !== null) return { name: "Chrome", version: majorOf(chrome[1]) };

  const firefox = /Firefox\/(\d+)/.exec(userAgent);
  if (firefox !== null) return { name: "Firefox", version: majorOf(firefox[1]) };

  if (/Safari\//.test(userAgent)) {
    return {
      name: /iPhone|iPad|iPod/.test(userAgent) ? "Mobile Safari" : "Safari",
      version: majorOf(/Version\/(\d+)/.exec(userAgent)?.[1]),
    };
  }

  return { name: "Other", version: null };
}

function osOf(userAgent: string): Os {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "iOS";
  if (/Windows/.test(userAgent)) return "Windows";
  if (/CrOS/.test(userAgent)) return "ChromeOS";
  if (/Android/.test(userAgent)) return "Android";
  if (/Mac OS X|Macintosh/.test(userAgent)) return "macOS";
  if (/Linux/.test(userAgent)) return "Linux";
  return "Other";
}

function deviceOf(userAgent: string): DeviceType {
  if (/iPad/.test(userAgent)) return "Tablet";
  if (/Android/.test(userAgent)) return /Mobile/.test(userAgent) ? "Mobile" : "Tablet";
  if (/iPhone|iPod/.test(userAgent)) return "Mobile";
  return "Desktop";
}

function majorOf(digits: string | undefined): number | null {
  if (digits === undefined) return null;
  const version = Number.parseInt(digits, 10);
  return Number.isNaN(version) ? null : version;
}
