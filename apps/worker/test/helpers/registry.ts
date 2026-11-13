import { env } from "cloudflare:test";
import { DEFAULT_SETTINGS, type ProjectSettings } from "@cfanalytics/shared";
import { SETTINGS_COLUMNS } from "../../src/features/projects/core.ts";

// Registry rows as tests need them: ids, tokens and keys of the right shape,
// and projects written with plain SQL, as the registry's own writer would.
// Random values here are test data, never the code under test's input.

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32.charAt((value >>> bits) & 31);
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31);
  return out;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export const newProjectId = (): string => `p_${base32(crypto.getRandomValues(new Uint8Array(10)))}`;
export const newToken = (): string =>
  `cfa_pk_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
export const newSecretKey = (): string =>
  `cfa_sk_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface ProjectSeed {
  id?: string;
  name?: string;
  token?: string;
  createdAt?: number;
  deletedAt?: number | null;
  settings?: Partial<ProjectSettings>;
}

/** Writes a `projects` row with plain SQL and answers what it wrote. */
export async function seedProject(seed: ProjectSeed = {}) {
  const id = seed.id ?? newProjectId();
  const name = seed.name ?? "Test project";
  const token = seed.token ?? newToken();
  const settings: ProjectSettings = { ...DEFAULT_SETTINGS, ...seed.settings };
  await env.REGISTRY.prepare(
    `INSERT INTO projects (id, name, token, created_at, deleted_at, ${SETTINGS_COLUMNS.join(", ")})
     VALUES (?, ?, ?, ?, ?, ${SETTINGS_COLUMNS.map(() => "?").join(", ")})`,
  )
    .bind(
      id,
      name,
      token,
      seed.createdAt ?? 1_700_000_000_000,
      seed.deletedAt ?? null,
      settings.timezone,
      settings.events_retention_days,
      settings.recordings_retention_days,
      settings.heatmaps_retention_days,
      settings.daily_event_cap,
      settings.daily_recording_bytes_cap,
      Number(settings.recording_enabled),
      settings.recording_sample_rate,
      settings.recording_min_duration_ms,
      Number(settings.heatmaps_enabled),
      Number(settings.autocapture_enabled),
      Number(settings.dead_clicks_enabled),
      JSON.stringify(settings.internal_rules),
      Number(settings.weekly_email),
      JSON.stringify(settings.email_off),
    )
    .run();
  return { id, name, token, settings };
}
