import { isJsonObject, POSTHOG_JS_VERSION, type ProjectSettings } from "@cfanalytics/shared";
import { err, ok, type Result } from "../../platform/result.ts";

// What posthog-js and posthog-ios are told on load, built from the project's
// settings, and which pinned script a /static/ path names (config-01 to
// config-32; posthog-protocol.md §6, §7.1, §7.8, §10.2, §11 item 10). Spike
// S2 proved the config's shape against the real SDKs. Pure.

/** The lazy script kinds we serve (config-25). Every one is served whatever the settings (config-28). */
export const SCRIPT_KINDS = [
  "recorder",
  "lazy-recorder",
  "surveys",
  "dead-clicks-autocapture",
  "exception-autocapture",
  "web-vitals",
] as const;
export type ScriptKind = (typeof SCRIPT_KINDS)[number];

/**
 * The SHA-256, in lower-case hex, of each script of POSTHOG_JS_VERSION as
 * npm publishes it in posthog-js's dist folder (config-27).
 * scripts/posthog-scripts.mjs copies the files to apps/worker/assets/posthog/
 * and prints these values.
 */
export const SCRIPT_SHA256: Readonly<Record<ScriptKind, string>> = {
  recorder: "7bc7abbaf339513f01a43eea70dc06b5627dd0a6b2f4108c3bfe8d2b0aa26290",
  "lazy-recorder": "6ab567d0e2c8e054fdbfc5eaac4716f43f124cdfe0935853ebca588d9d3ea539",
  surveys: "daf2e5f40411a852751012da24e375cb46d349584b7c210f659a8528136a020d",
  "dead-clicks-autocapture": "1d0b2faf5145fc6c24e30287e186741dee00d1fedc75c1d063e3cd874b5b0b03",
  "exception-autocapture": "5413b0cc7110d756f41b1a6ec81dd8790f5dca8c28bf58b552e6963d577a3f8b",
  "web-vitals": "3c6ab8a4e21f4d7c63d523109e480930845952e816dd27d4a0bbf215865f107e",
};

/** The session recording block of a config with recording on (config-01, config-16 to config-19). */
export interface RecordingConfig {
  endpoint: "/s/";
  /** null at a rate of 1.0, else the rate as a string, such as "0.5" (config-16). */
  sampleRate: string | null;
  minimumDurationMilliseconds: number;
  consoleLogRecordingEnabled: false;
  networkPayloadCapture: { recordHeaders: false; recordBody: false };
  masking: { maskAllInputs: true };
  recordCanvas: false;
}

/** The remote config, exactly these keys and no others (config-11, config-18). */
export interface RemoteConfig {
  supportedCompression: ["gzip-js", "base64"];
  hasFeatureFlags: false;
  autocapture_opt_out: boolean;
  elementsChainAsString: true;
  analytics: { endpoint: "/e/" };
  heatmaps: boolean;
  captureDeadClicks: boolean;
  autocaptureExceptions: false;
  capturePerformance: false;
  surveys: false;
  sessionRecording: false | RecordingConfig;
  defaultIdentifiedOnly: true;
  siteApps: [];
}

/**
 * The remote config of a project, with exactly the keys of RemoteConfig
 * (posthog-protocol.md §6.2, §7.8):
 * - supportedCompression ["gzip-js", "base64"] (config-08);
 * - hasFeatureFlags false, while /flags is still served (config-03);
 * - autocapture_opt_out: the opposite of autocapture_enabled (config-04,
 *   config-13); elementsChainAsString true (config-09);
 * - analytics.endpoint "/e/" (config-10);
 * - heatmaps: heatmaps_enabled (config-14, intake-08); captureDeadClicks:
 *   dead_clicks_enabled (config-15);
 * - autocaptureExceptions, capturePerformance and surveys false, siteApps []
 *   and defaultIdentifiedOnly true (config-11);
 * - sessionRecording: the boolean false with recording_enabled off, never
 *   absent (config-02, intake-08); else a RecordingConfig with endpoint "/s/",
 *   sampleRate from recording_sample_rate (config-16),
 *   minimumDurationMilliseconds from recording_min_duration_ms, all inputs
 *   masked and no maskTextSelector or blockSelector (config-01), no console
 *   log, network payload, canvas or performance capture (config-17), and no
 *   linkedFlag, urlTriggers, eventTriggers, triggerGroups, quotaLimited or
 *   push key (config-18, config-19).
 */
export function remoteConfig(settings: ProjectSettings): RemoteConfig {
  return {
    supportedCompression: ["gzip-js", "base64"],
    hasFeatureFlags: false,
    autocapture_opt_out: !settings.autocapture_enabled,
    elementsChainAsString: true,
    analytics: { endpoint: "/e/" },
    heatmaps: settings.heatmaps_enabled,
    captureDeadClicks: settings.dead_clicks_enabled,
    autocaptureExceptions: false,
    capturePerformance: false,
    surveys: false,
    sessionRecording: settings.recording_enabled ? recordingConfig(settings) : false,
    defaultIdentifiedOnly: true,
    siteApps: [],
  };
}

/** The recording block of a project with recording on (config-16, config-17). */
function recordingConfig(settings: ProjectSettings): RecordingConfig {
  return {
    endpoint: "/s/",
    // The SDK reads 1.0 as no sampling, and a string keeps 0.5 from rounding (config-16).
    sampleRate:
      settings.recording_sample_rate === 1 ? null : String(settings.recording_sample_rate),
    minimumDurationMilliseconds: settings.recording_min_duration_ms,
    consoleLogRecordingEnabled: false,
    networkPayloadCapture: { recordHeaders: false, recordBody: false },
    masking: { maskAllInputs: true },
    recordCanvas: false,
  };
}

/**
 * The config.js body (posthog-protocol.md §6.1): it assigns
 * `window._POSTHOG_REMOTE_CONFIG = window._POSTHOG_REMOTE_CONFIG || {};` and
 * then `window._POSTHOG_REMOTE_CONFIG[<token>] = { config: <config>, siteApps: [] };`,
 * with the token and the config written as JSON in which every `<` and the
 * line separators U+2028 and U+2029 are written as JSON unicode escapes, so
 * no value can close the script or break the line (config-21). It names no host and holds no
 * placeholder text, so it is the same on every host (config-20).
 */
export function configScript(token: string, config: RemoteConfig): string {
  return `window._POSTHOG_REMOTE_CONFIG = window._POSTHOG_REMOTE_CONFIG || {};
window._POSTHOG_REMOTE_CONFIG[${jsonForScript(token)}] = { config: ${jsonForScript(config)}, siteApps: [] };
`;
}

/** JSON safe inside a script tag: every `<` and the two JavaScript line separators escaped (config-21). */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(String.fromCharCode(0x2028), "\\u2028")
    .replaceAll(String.fromCharCode(0x2029), "\\u2029");
}

/** The /flags answer when no flags exist: all four keys, empty (config-03, posthog-protocol.md §6.3, §10.6). */
export const FLAGS_ANSWER = {
  flags: {},
  featureFlags: {},
  featureFlagPayloads: {},
  errorsWhileComputingFlags: false,
} as const;

/**
 * The project key of a decoded /flags body: `token` (posthog-js, posthog-node),
 * else `api_key` (posthog-ios), when it is a non-empty string; null when the
 * body names neither (posthog-protocol.md §1.3, §6.3, §10.6). Every other key,
 * such as `flag_keys` or `distinct_id`, is ignored. A body that is not a JSON
 * object is "not an object" (config-07).
 */
export function flagsToken(body: unknown): Result<string | null, "not an object"> {
  if (!isJsonObject(body)) return err("not an object");
  const token = body.token;
  if (typeof token === "string" && token !== "") return ok(token);
  const apiKey = body.api_key;
  if (typeof apiKey === "string" && apiKey !== "") return ok(apiKey);
  return ok(null);
}

/**
 * The script a URL path asks for (config-05, config-25, config-26, D-15):
 * `/static/<POSTHOG_JS_VERSION>/<kind>.js` is the versioned script and
 * `/static/<kind>.js` the unversioned one, for each of SCRIPT_KINDS. Any other
 * version, an unknown kind, another file name or a deeper path is null. The
 * path is the URL's pathname, without its query, so posthog-js's fallback
 * `/static/<kind>.js?v=<version>` names the unversioned script.
 */
export function scriptOf(path: string): { kind: ScriptKind; versioned: boolean } | null {
  if (!path.startsWith("/static/")) return null;
  const parts = path.slice("/static/".length).split("/");
  if (parts.length === 1) {
    const kind = kindOf(parts[0] ?? "");
    return kind === null ? null : { kind, versioned: false };
  }
  if (parts.length === 2 && parts[0] === POSTHOG_JS_VERSION) {
    const kind = kindOf(parts[1] ?? "");
    return kind === null ? null : { kind, versioned: true };
  }
  return null;
}

/** The kind a file name names, or null for any other name (config-26). */
function kindOf(file: string): ScriptKind | null {
  if (!file.endsWith(".js")) return null;
  const name = file.slice(0, -".js".length);
  return SCRIPT_KINDS.find((kind) => kind === name) ?? null;
}

/**
 * Cache-Control per answer (config-31): "public, max-age=31536000, immutable"
 * for a versioned script, "public, max-age=3600" for an unversioned one, and
 * "public, max-age=60" for the config and config.js, so a settings change
 * reaches the SDK within the registry cache's minute (config-12).
 */
export function cacheControlFor(
  answer: "versioned script" | "unversioned script" | "config",
): string {
  const lifetimes = {
    "versioned script": "public, max-age=31536000, immutable",
    "unversioned script": "public, max-age=3600",
    config: "public, max-age=60",
  } as const;
  return lifetimes[answer];
}
