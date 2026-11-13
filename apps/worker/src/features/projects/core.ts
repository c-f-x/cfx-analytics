import {
  bytesToBase64url,
  DEFAULT_SETTINGS,
  fitsInStore,
  isJsonObject,
  type ProjectSettings,
  projectSettings,
  type SettingsUpdate,
  settingsUpdate,
} from "@cfanalytics/shared";
import { err, ok, type Result } from "../../platform/result.ts";

// Pure rules of the registry: ids, tokens and keys made from random bytes the
// caller passes in, the key shape, and settings checked against
// packages/shared (D-4, D-5, D-20).

export const SECRET_KEY_PREFIX = "cfa_sk_";
export const TOKEN_PREFIX = "cfa_pk_";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const SECRET_KEY_SHAPE = /^cfa_sk_[A-Za-z0-9_-]{43}$/;

/** "p_" and 16 base32 characters (lower case) from 10 random bytes; matches the D1 CHECK. */
export function projectIdFrom(bytes: Uint8Array): Result<string, "need 10 bytes"> {
  if (bytes.length !== 10) return err("need 10 bytes");
  let bits = 0;
  let value = 0;
  let id = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      id += BASE32.charAt((value >>> bits) & 31);
    }
    value &= (1 << bits) - 1;
  }
  return ok(`p_${id}`);
}

/** TOKEN_PREFIX and 43 base64url characters from 32 random bytes (projects-02). */
export function tokenFrom(bytes: Uint8Array): Result<string, "need 32 bytes"> {
  if (bytes.length !== 32) return err("need 32 bytes");
  return ok(`${TOKEN_PREFIX}${bytesToBase64url(bytes)}`);
}

/** SECRET_KEY_PREFIX and 43 base64url characters from 32 random bytes (projects-14). */
export function secretKeyFrom(bytes: Uint8Array): Result<string, "need 32 bytes"> {
  if (bytes.length !== 32) return err("need 32 bytes");
  return ok(`${SECRET_KEY_PREFIX}${bytesToBase64url(bytes)}`);
}

/** Whether a presented key has the secret key's shape; anything else is 401 before the registry is read (projects-24). */
export function isSecretKeyShape(key: string): boolean {
  return SECRET_KEY_SHAPE.test(key);
}

/** The Bearer credential of an Authorization header, the scheme read without case; null otherwise (projects-23). */
export function bearerOf(authorization: string | null): string | null {
  const match = authorization === null ? null : /^Bearer +(\S+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

export type SettingsIssue = { setting: string; rule: string };

/**
 * A new project's name and optional settings, merged over DEFAULT_SETTINGS and
 * checked with `projectSettings` and fitsInStore (projects-01, projects-03 to
 * projects-05, projects-07, events-11). A name is trimmed and 1 to 200 characters.
 */
export function checkCreate(
  input: unknown,
): Result<{ name: string; settings: ProjectSettings }, SettingsIssue[]> {
  if (!isJsonObject(input)) return err([{ setting: "body", rule: "expected a JSON object" }]);
  const issues: SettingsIssue[] = [];
  for (const key of Object.keys(input)) {
    if (key !== "name" && key !== "settings") issues.push({ setting: key, rule: "unknown field" });
  }
  const name = nameOf(input.name, issues);
  const provided = input.settings === undefined ? {} : input.settings;
  const settings = fullSettings(provided, issues);
  if (name === null || settings === null) return err(issues);
  return ok({ name, settings });
}

/**
 * A partial update applied to the current settings: unknown names are issues,
 * named settings change, the rest keep their values, and the result must pass
 * `projectSettings` and fitsInStore (projects-08, events-11).
 */
export function checkUpdate(
  current: ProjectSettings,
  update: unknown,
): Result<ProjectSettings, SettingsIssue[]> {
  if (!isJsonObject(update)) return err([{ setting: "body", rule: "expected a JSON object" }]);
  const partial = settingsUpdate.safeParse(update);
  if (!partial.success) return err(issuesOf(partial.error));
  const merged = projectSettings.safeParse({ ...current, ...partial.data });
  if (!merged.success) return err(issuesOf(merged.error));
  const unfit = fitIssue(merged.data);
  if (unfit !== null) return err([unfit]);
  return ok(merged.data);
}

/** A `projects` row's settings columns (integers for switches, JSON text for rules) as settings. */
export function settingsFromRow(row: Readonly<Record<string, unknown>>): Result<ProjectSettings> {
  const rules = jsonColumn(row.internal_rules);
  if (!rules.ok) return err("settings row: internal_rules is not valid JSON");
  const off = jsonColumn(row.email_off);
  if (!off.ok) return err("settings row: email_off is not valid JSON");
  const parsed = projectSettings.safeParse({
    timezone: row.timezone,
    events_retention_days: row.events_retention_days,
    recordings_retention_days: row.recordings_retention_days,
    heatmaps_retention_days: row.heatmaps_retention_days,
    daily_event_cap: row.daily_event_cap,
    daily_recording_bytes_cap: row.daily_recording_bytes_cap,
    recording_enabled: switchOf(row.recording_enabled),
    recording_sample_rate: row.recording_sample_rate,
    recording_min_duration_ms: row.recording_min_duration_ms,
    heatmaps_enabled: switchOf(row.heatmaps_enabled),
    autocapture_enabled: switchOf(row.autocapture_enabled),
    dead_clicks_enabled: switchOf(row.dead_clicks_enabled),
    internal_rules: rules.value,
    weekly_email: switchOf(row.weekly_email),
    email_off: off.value,
  });
  if (!parsed.success) {
    const [issue] = issuesOf(parsed.error);
    return err(`settings row: ${issue?.setting ?? "settings"} ${issue?.rule ?? "is invalid"}`);
  }
  return ok(parsed.data);
}

/** Settings as the `projects` row's column values, in the order of SETTINGS_COLUMNS. */
export function settingsToRow(settings: ProjectSettings): (string | number)[] {
  const values: Record<(typeof SETTINGS_COLUMNS)[number], string | number> = {
    timezone: settings.timezone,
    events_retention_days: settings.events_retention_days,
    recordings_retention_days: settings.recordings_retention_days,
    heatmaps_retention_days: settings.heatmaps_retention_days,
    daily_event_cap: settings.daily_event_cap,
    daily_recording_bytes_cap: settings.daily_recording_bytes_cap,
    recording_enabled: Number(settings.recording_enabled),
    recording_sample_rate: settings.recording_sample_rate,
    recording_min_duration_ms: settings.recording_min_duration_ms,
    heatmaps_enabled: Number(settings.heatmaps_enabled),
    autocapture_enabled: Number(settings.autocapture_enabled),
    dead_clicks_enabled: Number(settings.dead_clicks_enabled),
    internal_rules: JSON.stringify(settings.internal_rules),
    weekly_email: Number(settings.weekly_email),
    email_off: JSON.stringify(settings.email_off),
  };
  return SETTINGS_COLUMNS.map((column) => values[column]);
}

/** The settings columns of `projects`, in one place for store.ts. */
export const SETTINGS_COLUMNS = [
  "timezone",
  "events_retention_days",
  "recordings_retention_days",
  "heatmaps_retention_days",
  "daily_event_cap",
  "daily_recording_bytes_cap",
  "recording_enabled",
  "recording_sample_rate",
  "recording_min_duration_ms",
  "heatmaps_enabled",
  "autocapture_enabled",
  "dead_clicks_enabled",
  "internal_rules",
  "weekly_email",
  "email_off",
] as const;

/** A JSON text column read back, or the value as it came when it is not text. */
function jsonColumn(value: unknown): Result<unknown> {
  if (typeof value !== "string") return ok(value);
  try {
    return ok(JSON.parse(value));
  } catch {
    return err("not valid JSON");
  }
}

/** The day a key was last used, as YYYY-MM-DD in UTC; written at most once a day (projects-17). */
export function usedDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export type { SettingsUpdate };

function nameOf(value: unknown, issues: SettingsIssue[]): string | null {
  if (typeof value !== "string") {
    issues.push({ setting: "name", rule: "expected text" });
    return null;
  }
  const name = value.trim();
  if (name.length === 0) {
    issues.push({ setting: "name", rule: "must not be empty" });
    return null;
  }
  if (name.length > 200) {
    issues.push({ setting: "name", rule: "at most 200 characters" });
    return null;
  }
  return name;
}

/** Settings merged over the defaults and checked as a whole; null with the issues pushed. */
function fullSettings(input: unknown, issues: SettingsIssue[]): ProjectSettings | null {
  if (!isJsonObject(input)) {
    issues.push({ setting: "settings", rule: "expected a JSON object" });
    return null;
  }
  const parsed = projectSettings.safeParse({ ...DEFAULT_SETTINGS, ...input });
  if (!parsed.success) {
    issues.push(...issuesOf(parsed.error));
    return null;
  }
  const unfit = fitIssue(parsed.data);
  if (unfit !== null) {
    issues.push(unfit);
    return null;
  }
  return parsed.data;
}

function fitIssue(settings: ProjectSettings): SettingsIssue | null {
  const { daily_event_cap: cap, events_retention_days: days } = settings;
  if (fitsInStore(cap, days)) return null;
  return {
    setting: "daily_event_cap",
    rule: `a cap of ${cap} for ${days} days holds more events than the store has room for`,
  };
}

/** Registry switches are integers; anything else is left for the schema to refuse. */
function switchOf(value: unknown): unknown {
  if (value === 1 || value === true) return true;
  if (value === 0 || value === false) return false;
  return value;
}

interface ZodIssueView {
  code: string;
  path: readonly PropertyKey[];
  message: string;
  keys?: readonly PropertyKey[];
}

interface ZodIssuesView {
  issues: readonly ZodIssueView[];
}

function issuesOf(error: ZodIssuesView): SettingsIssue[] {
  const issues: SettingsIssue[] = [];
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      if (issue.path.length > 0) {
        issues.push({ setting: settingOf(issue), rule: issue.message });
      } else {
        for (const key of issue.keys ?? []) {
          issues.push({ setting: String(key), rule: "unknown setting" });
        }
      }
      continue;
    }
    issues.push({ setting: settingOf(issue), rule: ruleOf(issue) });
  }
  return issues;
}

function settingOf(issue: ZodIssueView): string {
  const [first] = issue.path;
  return first === undefined ? "settings" : String(first);
}

function ruleOf(issue: ZodIssueView): string {
  if (issue.code === "too_small" || issue.code === "too_big") {
    const { min, max } = boundsOf(settingOf(issue));
    if (min !== null && max !== null) return `between ${min} and ${max}`;
    if (min !== null) return `at least ${min}`;
    if (max !== null) return `at most ${max}`;
  }
  return issue.message;
}

/** The schema's field for a setting; unknown when no setting has that name. */
function fieldOf(setting: string): unknown {
  for (const [name, field] of Object.entries(projectSettings.shape)) {
    if (name === setting) return field;
  }
  return undefined;
}

/** The lowest and highest value the schema accepts for a number setting. */
function boundsOf(setting: string): { min: number | null; max: number | null } {
  const field = fieldOf(setting);
  if (typeof field !== "object" || field === null) return { min: null, max: null };
  const { minValue, maxValue } = field as { minValue?: unknown; maxValue?: unknown };
  return {
    min: typeof minValue === "number" && minValue > -Number.MAX_SAFE_INTEGER ? minValue : null,
    max: typeof maxValue === "number" && maxValue < Number.MAX_SAFE_INTEGER ? maxValue : null,
  };
}
