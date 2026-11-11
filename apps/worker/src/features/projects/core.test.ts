import { DEFAULT_SETTINGS, type ProjectSettings } from "@cfanalytics/shared";
import { describe, expect, it } from "vitest";
import {
  bearerOf,
  checkCreate,
  checkUpdate,
  isSecretKeyShape,
  SETTINGS_COLUMNS,
  secretKeyFrom,
  settingsFromRow,
  settingsToRow,
  tokenFrom,
  usedDay,
} from "./core.ts";

// The pure rules of the registry (docs/spec/behaviours.md, projects-01 to
// projects-24). Time, random bytes and settings all arrive as values.

const bytes = (start: number, length = 32): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => (start + index) % 256);

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) {
    throw new Error(`expected a value, was refused with ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

describe("project settings", () => {
  it("projects-01 · a new project keeps the documented settings", () => {
    expect(checkCreate({ name: "The owner's site" })).toEqual({
      ok: true,
      value: { name: "The owner's site", settings: DEFAULT_SETTINGS },
    });
  });

  it("projects-01 · settings round-trip through the registry row's columns", () => {
    const settings: ProjectSettings = {
      ...DEFAULT_SETTINGS,
      timezone: "Europe/London",
      daily_event_cap: 1234,
      recording_enabled: true,
      recording_sample_rate: 0.25,
      internal_rules: [
        { kind: "event_property", property: "$host", value: "internal.example.com" },
        { kind: "person_property", property: "plan", value: "team" },
      ],
    };
    const values = settingsToRow(settings);
    expect(values).toHaveLength(SETTINGS_COLUMNS.length);
    const row: Record<string, string | number | undefined> = {};
    SETTINGS_COLUMNS.forEach((column, index) => {
      row[column] = values[index];
    });
    expect(row.recording_enabled).toBe(1);
    expect(row.recording_sample_rate).toBe(0.25);
    expect(typeof row.internal_rules).toBe("string");
    expect(settingsFromRow(row)).toEqual({ ok: true, value: settings });
  });
});

describe("names and settings on create", () => {
  it("projects-03 · an empty or blank name is refused", () => {
    for (const name of ["", "   ", "\n\t "]) {
      const result = checkCreate({ name });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((issue) => issue.setting === "name")).toBe(true);
      }
    }
    expect(checkCreate({}).ok).toBe(false);
  });

  it("projects-03 · a name is trimmed", () => {
    expect(unwrap(checkCreate({ name: "  The owner's site  " })).name).toBe("The owner's site");
  });

  it("projects-04 · a time zone that is not an IANA name is refused", () => {
    const refused = checkCreate({ name: "Site", settings: { timezone: "Mars/Olympus" } });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toContainEqual(expect.objectContaining({ setting: "timezone" }));
    }
    expect(checkCreate({ name: "Site", settings: { timezone: "Europe/Oslo" } }).ok).toBe(true);
  });

  it("projects-05 · a setting outside its range is refused, naming the setting and the rule", () => {
    const cases: { settings: Record<string, unknown>; setting: string; words?: string[] }[] = [
      { settings: { events_retention_days: 0 }, setting: "events_retention_days", words: ["1"] },
      {
        settings: { events_retention_days: 3651 },
        setting: "events_retention_days",
        words: ["3650"],
      },
      {
        settings: { recordings_retention_days: 366 },
        setting: "recordings_retention_days",
        words: ["365"],
      },
      {
        settings: { recordings_retention_days: 0 },
        setting: "recordings_retention_days",
        words: ["1"],
      },
      {
        settings: { heatmaps_retention_days: 0 },
        setting: "heatmaps_retention_days",
        words: ["1"],
      },
      { settings: { daily_event_cap: 0 }, setting: "daily_event_cap", words: ["1"] },
      { settings: { daily_recording_bytes_cap: 0 }, setting: "daily_recording_bytes_cap" },
      {
        settings: { recording_sample_rate: 1.5 },
        setting: "recording_sample_rate",
        words: ["0", "1"],
      },
      {
        settings: { recording_sample_rate: -0.1 },
        setting: "recording_sample_rate",
        words: ["0"],
      },
      { settings: { recording_min_duration_ms: 600_001 }, setting: "recording_min_duration_ms" },
      { settings: { recording_min_duration_ms: -1 }, setting: "recording_min_duration_ms" },
      { settings: { events_retention_days: 1.5 }, setting: "events_retention_days" },
      { settings: { recording_enabled: "yes" }, setting: "recording_enabled" },
    ];
    for (const { settings, setting, words } of cases) {
      const result = checkCreate({ name: "Site", settings });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      const issue = result.error.find((candidate) => candidate.setting === setting);
      expect(issue).toBeDefined();
      expect(issue?.rule.length).toBeGreaterThan(0);
      for (const word of words ?? []) expect(issue?.rule).toContain(word);
    }
  });

  it("projects-07 · rules of both kinds are accepted and a bad rule is refused", () => {
    const rules = [
      { kind: "event_property", property: "$host", value: "internal.example.com" },
      { kind: "person_property", property: "plan", value: "team" },
    ];
    const created = unwrap(checkCreate({ name: "Site", settings: { internal_rules: rules } }));
    expect(created.settings.internal_rules).toEqual(rules);

    const refused: unknown[] = [
      [{ kind: "cookie", property: "$host", value: "x" }],
      [{ kind: "event_property", property: "$host", value: "x", extra: true }],
      { kind: "event_property", property: "$host", value: "x" },
    ];
    for (const internal_rules of refused) {
      const result = checkCreate({ name: "Site", settings: { internal_rules } });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((issue) => issue.setting === "internal_rules")).toBe(true);
      }
    }
  });

  it("projects-07 · rules sent as JSON text, not as a list, are refused", () => {
    const texts = [
      '[{"kind":"event_property","property":"$host","value":"internal.example.com"}]',
      '[{"kind":"event_property",',
    ];
    for (const internal_rules of texts) {
      const result = checkCreate({ name: "Site", settings: { internal_rules } });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((issue) => issue.setting === "internal_rules")).toBe(true);
      }
    }
  });

  it("projects-08 · a partial update changes only the setting it names", () => {
    const current: ProjectSettings = {
      ...DEFAULT_SETTINGS,
      daily_event_cap: 1000,
      recording_enabled: true,
    };
    expect(checkUpdate(current, { daily_event_cap: 2000 })).toEqual({
      ok: true,
      value: { ...current, daily_event_cap: 2000 },
    });
    expect(checkUpdate(current, {})).toEqual({ ok: true, value: current });
  });

  it("projects-08 · an unknown setting name is refused", () => {
    const result = checkUpdate(DEFAULT_SETTINGS, { retention_days: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.some((issue) => issue.setting === "retention_days")).toBe(true);
    }
  });

  it("events-11 · the default cap and retention fit in the store", () => {
    expect(checkCreate({ name: "Site" }).ok).toBe(true);
    const atTheLine = checkCreate({
      name: "Site",
      settings: { daily_event_cap: 4652, events_retention_days: 3650 },
    });
    expect(atTheLine.ok).toBe(true);
  });

  it("events-11 · a cap and retention pair over 9 GB is refused by create and update", () => {
    const created = checkCreate({
      name: "Site",
      settings: { daily_event_cap: 40_000, events_retention_days: 500 },
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.length).toBeGreaterThan(0);

    expect(checkUpdate(DEFAULT_SETTINGS, { events_retention_days: 500 }).ok).toBe(false);
    expect(checkUpdate(DEFAULT_SETTINGS, { daily_event_cap: 50_000 }).ok).toBe(false);
  });
});

describe("tokens and keys", () => {
  it("projects-02 · the public token is a pure function of 32 random bytes", () => {
    const first = unwrap(tokenFrom(bytes(0)));
    expect(tokenFrom(bytes(0))).toEqual({ ok: true, value: first });
    expect(first).toMatch(/^cfa_pk_[A-Za-z0-9_-]{43}$/);
    expect(first).toHaveLength(50);

    const second = unwrap(tokenFrom(bytes(1)));
    expect(second).not.toBe(first);

    expect(first).not.toBe(unwrap(secretKeyFrom(bytes(0))));
    expect(tokenFrom(bytes(0, 31))).toEqual({ ok: false, error: "need 32 bytes" });
  });

  it("projects-14 · a secret key is the prefix and 43 base64url characters from 32 bytes", () => {
    const key = unwrap(secretKeyFrom(bytes(0)));
    expect(key).toMatch(/^cfa_sk_[A-Za-z0-9_-]{43}$/);
    expect(key).toHaveLength(50);
    expect(secretKeyFrom(bytes(0))).toEqual({ ok: true, value: key });
    expect(unwrap(secretKeyFrom(bytes(1)))).not.toBe(key);
    expect(secretKeyFrom(bytes(0, 31))).toEqual({ ok: false, error: "need 32 bytes" });
  });

  it("projects-17 · the last-used day is the UTC date of the injected time", () => {
    expect(usedDay(Date.UTC(2026, 9, 20, 23, 59, 59, 999))).toBe("2026-10-20");
    expect(usedDay(Date.UTC(2026, 9, 21, 0, 0, 0, 0))).toBe("2026-10-21");
    expect(usedDay(Date.UTC(2026, 0, 1))).toBe("2026-01-01");
  });

  it("projects-23 · the Bearer scheme is read without regard to case", () => {
    expect(bearerOf("Bearer cfa_sk_abc")).toBe("cfa_sk_abc");
    expect(bearerOf("bearer cfa_sk_abc")).toBe("cfa_sk_abc");
    expect(bearerOf("BEARER cfa_sk_abc")).toBe("cfa_sk_abc");
    expect(bearerOf("BeArEr cfa_sk_abc")).toBe("cfa_sk_abc");
  });

  it("projects-23 · a missing header or another scheme is no credential", () => {
    expect(bearerOf(null)).toBeNull();
    expect(bearerOf("")).toBeNull();
    expect(bearerOf("Bearer")).toBeNull();
    expect(bearerOf("Basic abc")).toBeNull();
    expect(bearerOf("Token cfa_sk_abc")).toBeNull();
  });

  it("projects-24 · only the secret key shape is accepted", () => {
    expect(isSecretKeyShape(`cfa_sk_${"A".repeat(43)}`)).toBe(true);
    expect(isSecretKeyShape(`cfa_sk_${"aZ09-_".repeat(7)}x`)).toBe(true);

    const refused = [
      `cfa_pk_${"A".repeat(43)}`,
      `cfa_sk_${"A".repeat(42)}`,
      `cfa_sk_${"A".repeat(44)}`,
      `cfa_sk_${"A".repeat(42)}+`,
      `cfa_sk_${"A".repeat(42)}=`,
      `cfa_sk_${"A".repeat(42)} `,
      "",
      "not-a-key",
    ];
    for (const key of refused) expect(isSecretKeyShape(key)).toBe(false);
  });
});
