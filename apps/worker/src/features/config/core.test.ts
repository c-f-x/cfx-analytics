import { DEFAULT_SETTINGS, POSTHOG_JS_VERSION, type ProjectSettings } from "@cfanalytics/shared";
import { describe, expect, it } from "vitest";
import { err, ok } from "../../platform/result.ts";
import {
  cacheControlFor,
  configScript,
  flagsToken,
  type RecordingConfig,
  type RemoteConfig,
  remoteConfig,
  SCRIPT_KINDS,
  scriptOf,
} from "./core.ts";

// What the SDKs are told when they load, built from a project's settings
// (config-01 to config-32, posthog-protocol.md §6, §7.8, §10.2). The HTTP
// half of each behaviour is in http.test.ts.

/** The default settings with `change` applied. */
function settingsWith(change: Partial<ProjectSettings> = {}): ProjectSettings {
  return { ...DEFAULT_SETTINGS, ...change };
}

/** The recording block of a config known to hold one. */
function recordingOf(config: RemoteConfig): RecordingConfig {
  const recording = config.sessionRecording;
  if (recording === false) throw new Error("expected sessionRecording to be an object");
  return recording;
}

/** Every property name anywhere in `value`, nested ones included. */
function allKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, into);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      into.push(key);
      allKeys(item, into);
    }
  }
  return into;
}

/** A remote config written out by hand, so configScript is proved alone. */
function storedConfig(sampleRate: string | null = null): RemoteConfig {
  return {
    supportedCompression: ["gzip-js", "base64"],
    hasFeatureFlags: false,
    autocapture_opt_out: false,
    elementsChainAsString: true,
    analytics: { endpoint: "/e/" },
    heatmaps: false,
    captureDeadClicks: false,
    autocaptureExceptions: false,
    capturePerformance: false,
    surveys: false,
    sessionRecording: {
      endpoint: "/s/",
      sampleRate,
      minimumDurationMilliseconds: 2000,
      consoleLogRecordingEnabled: false,
      networkPayloadCapture: { recordHeaders: false, recordBody: false },
      masking: { maskAllInputs: true },
      recordCanvas: false,
    },
    defaultIdentifiedOnly: true,
    siteApps: [],
  };
}

/** Recording on for half the sessions, keeping sessions of five seconds or more. */
const RECORDING_ON = settingsWith({
  recording_enabled: true,
  recording_sample_rate: 0.5,
  recording_min_duration_ms: 5000,
});

describe("remoteConfig", () => {
  it("config-01 · recording on sets the rate, duration and masking", () => {
    const recording = recordingOf(remoteConfig(RECORDING_ON));
    expect(recording.endpoint).toBe("/s/");
    expect(recording.sampleRate).toBe("0.5");
    expect(recording.minimumDurationMilliseconds).toBe(5000);
    expect(recording.masking).toEqual({ maskAllInputs: true });
    const keys = allKeys(recording);
    expect(keys).not.toContain("maskTextSelector");
    expect(keys).not.toContain("blockSelector");
  });

  it("config-02 · both switches off are false and the key is present", () => {
    const config = remoteConfig(settingsWith());
    expect("sessionRecording" in config).toBe(true);
    expect(config.sessionRecording).toBe(false);
    expect(config.heatmaps).toBe(false);
  });

  it("config-03 · the config says hasFeatureFlags false", () => {
    expect(remoteConfig(settingsWith()).hasFeatureFlags).toBe(false);
  });

  it("config-04 · autocapture on leaves autocapture_opt_out false", () => {
    const config = remoteConfig(settingsWith({ autocapture_enabled: true }));
    expect(config.autocapture_opt_out).toBe(false);
  });

  it("config-05 · another version's script path is null", () => {
    expect(scriptOf("/static/1.0.0/lazy-recorder.js")).toBeNull();
  });

  it("config-08 · supportedCompression is gzip-js and base64", () => {
    expect(remoteConfig(settingsWith()).supportedCompression).toEqual(["gzip-js", "base64"]);
  });

  it("config-09 · elementsChainAsString is true", () => {
    expect(remoteConfig(settingsWith()).elementsChainAsString).toBe(true);
  });

  it("config-10 · analytics.endpoint is /e/", () => {
    expect(remoteConfig(settingsWith()).analytics).toEqual({ endpoint: "/e/" });
  });

  it("config-11 · exactly RemoteConfig's keys, with the extra switches off", () => {
    const config = remoteConfig(settingsWith());
    const expected: readonly (keyof RemoteConfig)[] = [
      "supportedCompression",
      "hasFeatureFlags",
      "autocapture_opt_out",
      "elementsChainAsString",
      "analytics",
      "heatmaps",
      "captureDeadClicks",
      "autocaptureExceptions",
      "capturePerformance",
      "surveys",
      "sessionRecording",
      "defaultIdentifiedOnly",
      "siteApps",
    ];
    expect(Object.keys(config).toSorted()).toEqual([...expected].toSorted());
    expect(config.surveys).toBe(false);
    expect(config.capturePerformance).toBe(false);
    expect(config.autocaptureExceptions).toBe(false);
    expect(config.siteApps).toEqual([]);
  });

  it("config-13 · autocapture off sets autocapture_opt_out true", () => {
    const config = remoteConfig(settingsWith({ autocapture_enabled: false }));
    expect(config.autocapture_opt_out).toBe(true);
  });

  it("config-14 · heatmaps follows the setting, with no capture_heatmaps", () => {
    const on = allKeys(remoteConfig(settingsWith({ heatmaps_enabled: true })));
    const off = allKeys(remoteConfig(settingsWith({ heatmaps_enabled: false })));
    expect(remoteConfig(settingsWith({ heatmaps_enabled: true })).heatmaps).toBe(true);
    expect(remoteConfig(settingsWith({ heatmaps_enabled: false })).heatmaps).toBe(false);
    expect(on).not.toContain("capture_heatmaps");
    expect(off).not.toContain("capture_heatmaps");
  });

  it("config-15 · dead clicks follow the setting, with no capture_dead_clicks", () => {
    const on = remoteConfig(settingsWith({ dead_clicks_enabled: true }));
    const off = remoteConfig(settingsWith({ dead_clicks_enabled: false }));
    expect(on.captureDeadClicks).toBe(true);
    expect(off.captureDeadClicks).toBe(false);
    expect(allKeys(on)).not.toContain("capture_dead_clicks");
    expect(allKeys(off)).not.toContain("capture_dead_clicks");
  });

  it("config-16 · sampleRate is null at 1.0 and 0.5 as a string at 0.5", () => {
    const full = settingsWith({ recording_enabled: true, recording_sample_rate: 1 });
    const half = settingsWith({ recording_enabled: true, recording_sample_rate: 0.5 });
    expect(recordingOf(remoteConfig(full)).sampleRate).toBe(null);
    expect(recordingOf(remoteConfig(half)).sampleRate).toBe("0.5");
  });

  it("config-17 · console, payload, canvas and performance capture are off", () => {
    const config = remoteConfig(RECORDING_ON);
    const recording = recordingOf(config);
    expect(recording.consoleLogRecordingEnabled).toBe(false);
    expect(recording.networkPayloadCapture).toEqual({
      recordHeaders: false,
      recordBody: false,
    });
    expect(recording.recordCanvas).toBe(false);
    expect(config.capturePerformance).toBe(false);
  });

  it("config-18 · no trigger key appears anywhere in the config", () => {
    const keys = allKeys(remoteConfig(RECORDING_ON));
    const triggers = [
      "linkedFlag",
      "urlTriggers",
      "urlBlocklist",
      "eventTriggers",
      "triggerGroups",
    ];
    for (const trigger of triggers) {
      expect(keys).not.toContain(trigger);
    }
  });

  it("config-19 · the recording keys are present and iOS's keys are not", () => {
    const config = remoteConfig(settingsWith({ recording_enabled: true }));
    const recording = recordingOf(config);
    expect(recording.endpoint).toBe("/s/");
    expect("sampleRate" in recording).toBe(true);
    expect(recording.minimumDurationMilliseconds).toBe(2000);
    const keys = allKeys(config);
    expect(keys).not.toContain("linkedFlag");
    expect(keys).not.toContain("quotaLimited");
    expect(keys).not.toContain("push");
  });

  it("config-25 · each kind is named at both its paths", () => {
    for (const kind of SCRIPT_KINDS) {
      const atVersion = `/static/${POSTHOG_JS_VERSION}/${kind}.js`;
      const plain = `/static/${kind}.js`;
      expect(scriptOf(atVersion)).toEqual({ kind, versioned: true });
      expect(scriptOf(plain)).toEqual({ kind, versioned: false });
    }
  });

  it("config-26 · another version, kind, file name or depth is null", () => {
    expect(scriptOf("/static/9.9.9/recorder.js")).toBeNull();
    expect(scriptOf("/static/unknown.js")).toBeNull();
    expect(scriptOf(`/static/${POSTHOG_JS_VERSION}/recorder.js.map`)).toBeNull();
    expect(scriptOf("/static/recorder.js.map")).toBeNull();
    expect(scriptOf(`/static/${POSTHOG_JS_VERSION}/more/recorder.js`)).toBeNull();
    expect(scriptOf("/static/recorder.js/more")).toBeNull();
  });
});

describe("configScript", () => {
  it("config-20 · configScript assigns the token's config and siteApps", () => {
    const token = "cfa_pk_script";
    const config = storedConfig();
    const script = configScript(token, config);
    expect(script).toContain(
      "window._POSTHOG_REMOTE_CONFIG = window._POSTHOG_REMOTE_CONFIG || {};",
    );
    expect(script).toContain(`[${JSON.stringify(token)}]`);
    expect(script).toContain(JSON.stringify(config));
    expect(script).toMatch(/config"?\s*:\s*\{/);
    expect(script).toMatch(/siteApps"?\s*:\s*\[\s*\]/);
  });

  it("config-21 · a value holding </script> is written with no <", () => {
    const token = 'cfa_pk_"</script>';
    const config = storedConfig("</script><script>alert(1)</script>");
    expect(configScript(token, config)).not.toContain("<");
  });
});

describe("flagsToken", () => {
  it("config-07 · flagsToken reads token, then api_key", () => {
    expect(flagsToken({ token: "pk_token" })).toEqual(ok("pk_token"));
    expect(flagsToken({ api_key: "pk_api" })).toEqual(ok("pk_api"));
    expect(flagsToken({ token: "pk_token", api_key: "pk_api" })).toEqual(ok("pk_token"));
    expect(flagsToken({ token: "", api_key: "pk_api" })).toEqual(ok("pk_api"));
    expect(flagsToken({ distinct_id: "user-1" })).toEqual(ok(null));
    expect(flagsToken({ token: "" })).toEqual(ok(null));
  });

  it("config-07 · flagsToken refuses a body that is not an object", () => {
    for (const body of [null, 7, true, "text", ["token"]]) {
      expect(flagsToken(body)).toEqual(err("not an object"));
    }
  });
});

describe("cacheControlFor", () => {
  it("config-31 · each answer gets its own cache lifetime", () => {
    expect(cacheControlFor("versioned script")).toBe("public, max-age=31536000, immutable");
    expect(cacheControlFor("unversioned script")).toBe("public, max-age=3600");
    expect(cacheControlFor("config")).toBe("public, max-age=60");
  });
});
