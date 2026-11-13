import { z } from "zod";
import { BYTES_PER_EVENT, STORE_GUARD_BYTES } from "./limits.ts";

// A project's settings: their defaults and their ranges, in one place
// (data-model.md, "Project settings"). The D1 CHECK constraints in
// apps/worker/migrations repeat these ranges, and projects-06 tests that they
// agree.

/** Whether `name` is an IANA time zone this runtime knows. Pure: Intl's data is the only input. */
export function isTimeZone(name: string): boolean {
  if (name.trim() === "" || name !== name.trim()) return false;
  try {
    const format = new Intl.DateTimeFormat("en-US", { timeZone: name });
    return format.resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

/** The calendar day of `ts` in `timeZone`, as YYYY-MM-DD. The cap's day and the cookieless salt's day both read it (events-07, cookieless-09). */
export function calendarDay(ts: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ts));
  const partOf = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${partOf("year")}-${partOf("month")}-${partOf("day")}`;
}

const propertyName = z.string().min(1).max(200);
const ruleValue = z.union([z.string().max(1000), z.number(), z.boolean()]);

/** The two kinds of internal-traffic rule (D-20, query-08). Matched at query time, exactly as written. */
export const internalRule = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("event_property"), property: propertyName, value: ruleValue }),
  z.strictObject({ kind: z.literal("person_property"), property: propertyName, value: ruleValue }),
]);
export type InternalRule = z.infer<typeof internalRule>;

const days = z.number().int().min(1);

export const projectSettings = z.strictObject({
  timezone: z.string().refine(isTimeZone, "not an IANA time zone"),
  events_retention_days: days.max(3650),
  recordings_retention_days: days.max(365),
  heatmaps_retention_days: days.max(3650),
  daily_event_cap: z.number().int().min(1),
  daily_recording_bytes_cap: z.number().int().min(1),
  recording_enabled: z.boolean(),
  recording_sample_rate: z.number().min(0).max(1),
  recording_min_duration_ms: z.number().int().min(0).max(600_000),
  heatmaps_enabled: z.boolean(),
  autocapture_enabled: z.boolean(),
  dead_clicks_enabled: z.boolean(),
  internal_rules: z.array(internalRule).max(50),
  /** Whether this product is in the weekly email (alerts-09, D-40). */
  weekly_email: z.boolean(),
  /** Confirmed addresses that do not get this product in their weekly email. */
  email_off: z.array(z.email()).max(50),
});
export type ProjectSettings = z.infer<typeof projectSettings>;

/** The body of adding an address to the weekly email (alerts-11). */
export const addAddressBody = z.strictObject({ address: z.email().max(254) });

/** A partial update names only the settings it changes (projects-08). */
export const settingsUpdate = projectSettings.partial();
export type SettingsUpdate = z.infer<typeof settingsUpdate>;

/** Defaults for a new project (projects-01, D-20). */
export const DEFAULT_SETTINGS: ProjectSettings = {
  timezone: "Europe/Oslo",
  events_retention_days: 395,
  recordings_retention_days: 30,
  heatmaps_retention_days: 90,
  daily_event_cap: 40_000,
  daily_recording_bytes_cap: 500_000_000,
  recording_enabled: false,
  recording_sample_rate: 1,
  recording_min_duration_ms: 2000,
  heatmaps_enabled: false,
  autocapture_enabled: true,
  dead_clicks_enabled: false,
  internal_rules: [],
  weekly_email: true,
  email_off: [],
};

/**
 * Whether a full cap for every day of the retention fits under the store's
 * guard size (events-11). Create and update refuse a pair that does not fit.
 */
export function fitsInStore(dailyEventCap: number, eventsRetentionDays: number): boolean {
  return dailyEventCap * eventsRetentionDays * BYTES_PER_EVENT <= STORE_GUARD_BYTES;
}

/** A project as the dashboard's API answers it (projects-01). */
export interface ProjectInfo {
  id: string;
  name: string;
  /** The public token the product's SDKs send with. */
  token: string;
  createdAt: number;
  deletedAt: number | null;
  settings: ProjectSettings;
}

/** A secret key as the dashboard's API lists it; its plaintext is shown once, at creation. */
export interface KeyInfo {
  /** The first 12 characters of the hash, which identify the key in the dashboard. */
  id: string;
  label: string;
  createdAt: number;
  lastUsedDay: string | null;
}
