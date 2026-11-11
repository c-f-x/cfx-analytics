import { env } from "cloudflare:test";
import { DEFAULT_SETTINGS, STANDARD_TILES } from "@cfanalytics/shared";
import { describe, expect, it } from "vitest";
import {
  newProjectId as projectId,
  newToken as publicToken,
  newSecretKey as secretKey,
  seedProject,
  sha256Hex,
} from "../../../test/helpers/registry.ts";
import { SETTINGS_COLUMNS, settingsToRow } from "./core.ts";
import {
  addSecretKey,
  createProject,
  getProject,
  hashKey,
  listSecretKeys,
  markDeleted,
  removeProjectRows,
  resolveSecretKey,
  resolveToken,
  revokeSecretKey,
} from "./store.ts";

/** Fresh ids for a project's standard tiles (projects-40). */
const freshTileIds = (): string[] => STANDARD_TILES.map(() => crypto.randomUUID());

// The D1 registry and its Cache API entries, against the real env.REGISTRY and
// caches.default. Every test uses its own project ids, tokens and keys, and
// passes `now` in, so nothing waits.

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) {
    throw new Error(`expected a value, was refused with ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

const NOW = 1_700_000_000_000;

describe("the registry's schema", () => {
  it("projects-06 · every registry CHECK refuses its out-of-range value", async () => {
    const id = projectId();
    const token = publicToken();
    const values = settingsToRow(DEFAULT_SETTINGS);
    await env.REGISTRY.prepare(
      `INSERT INTO projects (id, name, token, created_at, ${SETTINGS_COLUMNS.join(", ")})
       VALUES (?, ?, ?, ?, ${SETTINGS_COLUMNS.map(() => "?").join(", ")})`,
    )
      .bind(id, "Test project", token, NOW, ...values)
      .run();

    const refused: [column: string, value: string | number][] = [
      ["id", "nope"],
      ["id", "p_abcdefghijklmnopq"],
      ["name", ""],
      ["name", "   "],
      ["name", "x".repeat(201)],
      ["token", `cfa_sk_${"A".repeat(43)}`],
      ["token", `cfa_pk_${"A".repeat(42)}`],
      ["timezone", ""],
      ["timezone", "x".repeat(65)],
      ["events_retention_days", 0],
      ["events_retention_days", 3651],
      ["recordings_retention_days", 0],
      ["recordings_retention_days", 366],
      ["heatmaps_retention_days", 0],
      ["heatmaps_retention_days", 3651],
      ["daily_event_cap", 0],
      ["daily_recording_bytes_cap", 0],
      ["recording_enabled", 2],
      ["recording_sample_rate", -0.1],
      ["recording_sample_rate", 1.1],
      ["recording_min_duration_ms", -1],
      ["recording_min_duration_ms", 600_001],
      ["heatmaps_enabled", 2],
      ["autocapture_enabled", 2],
      ["dead_clicks_enabled", 2],
      ["internal_rules", "not json"],
      ["internal_rules", '{"kind":"event_property"}'],
    ];
    for (const [column, value] of refused) {
      await expect(
        env.REGISTRY.prepare(`UPDATE projects SET ${column} = ? WHERE id = ?`)
          .bind(value, id)
          .run(),
      ).rejects.toThrow();
    }

    // The pair fits under 9 GB at 530 bytes an event, or it is refused (events-11).
    await expect(
      env.REGISTRY.prepare(
        "UPDATE projects SET daily_event_cap = ?, events_retention_days = ? WHERE id = ?",
      )
        .bind(40_000, 500, id)
        .run(),
    ).rejects.toThrow();

    const row = await env.REGISTRY.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
    expect(row?.events_retention_days).toBe(395);
    expect(row?.daily_event_cap).toBe(40_000);
    expect(row?.internal_rules).toBe("[]");
  });

  it("projects-22 · a duplicate token or key hash is refused", async () => {
    const id = projectId();
    const token = publicToken();
    const created = await createProject(env.REGISTRY, {
      id,
      name: "First",
      token,
      createdAt: NOW,
      settings: DEFAULT_SETTINGS,
      tileIds: freshTileIds(),
    });
    expect(created.ok).toBe(true);

    await expect(
      env.REGISTRY.prepare("INSERT INTO projects (id, name, token, created_at) VALUES (?, ?, ?, ?)")
        .bind(projectId(), "Second", token, NOW)
        .run(),
    ).rejects.toThrow();

    const hash = await hashKey(secretKey());
    expect(
      (
        await addSecretKey(env.REGISTRY, {
          hash,
          projectId: id,
          label: "First key",
          createdAt: NOW,
        })
      ).ok,
    ).toBe(true);
    await expect(
      env.REGISTRY.prepare(
        "INSERT INTO secret_keys (hash, project_id, label, created_at) VALUES (?, ?, ?, ?)",
      )
        .bind(hash, id, "Second key", NOW)
        .run(),
    ).rejects.toThrow();
  });
});

describe("resolving a token", () => {
  it("projects-09 · a token answers the project id and its settings, and nothing else", async () => {
    const seeded = await seedProject({
      settings: {
        daily_event_cap: 1234,
        recording_enabled: true,
        internal_rules: [{ kind: "person_property", property: "plan", value: "team" }],
      },
    });
    expect(await resolveToken(env.REGISTRY, caches.default, seeded.token, NOW)).toEqual({
      ok: true,
      value: { id: seeded.id, settings: seeded.settings },
    });
  });

  it("projects-10 · a token answer is cached for 60 seconds and read again after", async () => {
    const seeded = await seedProject({ settings: { daily_event_cap: 1000 } });
    expect(unwrap(await resolveToken(env.REGISTRY, caches.default, seeded.token, NOW))).toEqual({
      id: seeded.id,
      settings: { ...seeded.settings, daily_event_cap: 1000 },
    });

    await env.REGISTRY.prepare("UPDATE projects SET daily_event_cap = ? WHERE id = ?")
      .bind(2000, seeded.id)
      .run();

    expect(await resolveToken(env.REGISTRY, caches.default, seeded.token, NOW + 59_999)).toEqual({
      ok: true,
      value: { id: seeded.id, settings: { ...seeded.settings, daily_event_cap: 1000 } },
    });
    expect(await resolveToken(env.REGISTRY, caches.default, seeded.token, NOW + 60_000)).toEqual({
      ok: true,
      value: { id: seeded.id, settings: { ...seeded.settings, daily_event_cap: 2000 } },
    });
  });

  it("projects-11 · a blank token resolves to nothing", async () => {
    for (const blank of ["", "   ", "\n\t "]) {
      expect(await resolveToken(env.REGISTRY, caches.default, blank, NOW)).toEqual({
        ok: true,
        value: null,
      });
    }
  });

  it("projects-12 · an unknown token is cached as unknown for 60 seconds", async () => {
    const token = publicToken();
    expect(await resolveToken(env.REGISTRY, caches.default, token, NOW)).toEqual({
      ok: true,
      value: null,
    });

    const seeded = await seedProject({ token });
    expect(await resolveToken(env.REGISTRY, caches.default, token, NOW + 30_000)).toEqual({
      ok: true,
      value: null,
    });
    expect(await resolveToken(env.REGISTRY, caches.default, token, NOW + 60_000)).toEqual({
      ok: true,
      value: { id: seeded.id, settings: seeded.settings },
    });
  });

  it("projects-13 · a deleted project's token and keys are refused after the cached minute", async () => {
    const seeded = await seedProject();
    const key = secretKey();
    const added = await addSecretKey(env.REGISTRY, {
      hash: await hashKey(key),
      projectId: seeded.id,
      label: "CLI",
      createdAt: NOW,
    });
    expect(added.ok).toBe(true);

    expect(await resolveToken(env.REGISTRY, caches.default, seeded.token, NOW)).toEqual({
      ok: true,
      value: { id: seeded.id, settings: seeded.settings },
    });
    expect((await resolveSecretKey(env.REGISTRY, caches.default, key, NOW)).ok).toBe(true);

    await env.REGISTRY.prepare("UPDATE projects SET deleted_at = ? WHERE id = ?")
      .bind(NOW, seeded.id)
      .run();

    expect(
      unwrap(await resolveToken(env.REGISTRY, caches.default, seeded.token, NOW + 59_999)),
    ).toEqual({ id: seeded.id, settings: seeded.settings });
    expect(await resolveToken(env.REGISTRY, caches.default, seeded.token, NOW + 60_000)).toEqual({
      ok: true,
      value: null,
    });
    expect(await resolveSecretKey(env.REGISTRY, caches.default, key, NOW + 60_000)).toEqual({
      ok: true,
      value: null,
    });
  });
});

describe("secret keys", () => {
  it("projects-14 · a new key's plaintext is not stored, only its SHA-256 hash", async () => {
    const seeded = await seedProject();
    const key = secretKey();
    const hash = await sha256Hex(key);
    expect(
      await addSecretKey(env.REGISTRY, {
        hash,
        projectId: seeded.id,
        label: "Production",
        createdAt: NOW,
      }),
    ).toEqual({
      ok: true,
      value: { id: hash.slice(0, 12), label: "Production", createdAt: NOW, lastUsedDay: null },
    });

    const rows = await env.REGISTRY.prepare("SELECT * FROM secret_keys WHERE project_id = ?")
      .bind(seeded.id)
      .all();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]?.hash).toBe(hash);
    expect(JSON.stringify(rows.results)).not.toContain(key);
  });

  it("projects-15 · a key is hashed and looked up by its hash", async () => {
    const seeded = await seedProject();
    const key = secretKey();
    const other = secretKey();
    const hash = await hashKey(key);
    expect(await hashKey(key)).toBe(hash);
    expect(await hashKey(other)).not.toBe(hash);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(await sha256Hex(key));

    expect(
      (
        await addSecretKey(env.REGISTRY, {
          hash,
          projectId: seeded.id,
          label: "CLI",
          createdAt: NOW,
        })
      ).ok,
    ).toBe(true);
    expect(await resolveSecretKey(env.REGISTRY, caches.default, key, NOW)).toEqual({
      ok: true,
      value: { id: seeded.id, settings: seeded.settings },
    });
    expect(await resolveSecretKey(env.REGISTRY, caches.default, other, NOW)).toEqual({
      ok: true,
      value: null,
    });
  });

  it("projects-16 · listing keys answers label, creation and last-used dates, never the hash or plaintext", async () => {
    const seeded = await seedProject();
    const first = secretKey();
    const second = secretKey();
    const firstHash = await hashKey(first);
    const secondHash = await hashKey(second);
    expect(
      (
        await addSecretKey(env.REGISTRY, {
          hash: firstHash,
          projectId: seeded.id,
          label: "First",
          createdAt: NOW,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await addSecretKey(env.REGISTRY, {
          hash: secondHash,
          projectId: seeded.id,
          label: "Second",
          createdAt: NOW + 100_000,
        })
      ).ok,
    ).toBe(true);
    await env.REGISTRY.prepare("UPDATE secret_keys SET last_used_day = ? WHERE hash = ?")
      .bind("2026-10-20", secondHash)
      .run();

    const keys = unwrap(await listSecretKeys(env.REGISTRY, seeded.id));
    expect(keys).toHaveLength(2);
    expect(keys).toContainEqual({
      id: firstHash.slice(0, 12),
      label: "First",
      createdAt: NOW,
      lastUsedDay: null,
    });
    expect(keys).toContainEqual({
      id: secondHash.slice(0, 12),
      label: "Second",
      createdAt: NOW + 100_000,
      lastUsedDay: "2026-10-20",
    });
    expect(JSON.stringify(keys)).not.toContain(first);
    expect(JSON.stringify(keys)).not.toContain(second);
    expect(JSON.stringify(keys)).not.toContain(firstHash);
  });

  it("projects-17 · last-used is written at most once a day and again the next day", async () => {
    await env.REGISTRY.prepare("CREATE TABLE key_updates (count INTEGER NOT NULL)").run();
    await env.REGISTRY.prepare("INSERT INTO key_updates VALUES (0)").run();
    await env.REGISTRY.prepare(
      "CREATE TRIGGER count_key_updates AFTER UPDATE ON secret_keys BEGIN UPDATE key_updates SET count = count + 1; END",
    ).run();

    const seeded = await seedProject();
    const key = secretKey();
    const hash = await hashKey(key);
    const day = Date.UTC(2026, 9, 20, 8, 0, 0);
    expect(
      (
        await addSecretKey(env.REGISTRY, {
          hash,
          projectId: seeded.id,
          label: "CLI",
          createdAt: day,
        })
      ).ok,
    ).toBe(true);

    expect((await resolveSecretKey(env.REGISTRY, caches.default, key, day)).ok).toBe(true);
    expect(await updateCount()).toBe(1);
    expect(await lastUsedDay(hash)).toBe("2026-10-20");

    expect(
      (await resolveSecretKey(env.REGISTRY, caches.default, key, day + 60 * 60 * 1000)).ok,
    ).toBe(true);
    expect(await updateCount()).toBe(1);

    expect(
      (await resolveSecretKey(env.REGISTRY, caches.default, key, day + 24 * 60 * 60 * 1000)).ok,
    ).toBe(true);
    expect(await updateCount()).toBe(2);
    expect(await lastUsedDay(hash)).toBe("2026-10-21");
  });

  it("projects-18 · a revoked key is gone and refused after the cached minute", async () => {
    const seeded = await seedProject();
    const key = secretKey();
    const added = unwrap(
      await addSecretKey(env.REGISTRY, {
        hash: await hashKey(key),
        projectId: seeded.id,
        label: "CLI",
        createdAt: NOW,
      }),
    );
    expect((await resolveSecretKey(env.REGISTRY, caches.default, key, NOW)).ok).toBe(true);

    expect(await revokeSecretKey(env.REGISTRY, seeded.id, added.id)).toEqual({
      ok: true,
      value: "revoked",
    });
    expect(await keyCount(seeded.id)).toBe(0);
    expect(await resolveSecretKey(env.REGISTRY, caches.default, key, NOW + 60_000)).toEqual({
      ok: true,
      value: null,
    });
  });

  it("projects-19 · the key cache holds the project id only, so settings are read live", async () => {
    const seeded = await seedProject({ settings: { daily_event_cap: 1000 } });
    const key = secretKey();
    expect(
      (
        await addSecretKey(env.REGISTRY, {
          hash: await hashKey(key),
          projectId: seeded.id,
          label: "CLI",
          createdAt: NOW,
        })
      ).ok,
    ).toBe(true);
    expect(
      unwrap(await resolveSecretKey(env.REGISTRY, caches.default, key, NOW))?.settings
        .daily_event_cap,
    ).toBe(1000);

    await env.REGISTRY.prepare("UPDATE projects SET daily_event_cap = ? WHERE id = ?")
      .bind(2000, seeded.id)
      .run();

    expect(
      unwrap(await resolveSecretKey(env.REGISTRY, caches.default, key, NOW + 59_999))?.settings
        .daily_event_cap,
    ).toBe(2000);
  });

  it("projects-20 · another project's key is not found and stays", async () => {
    const first = await seedProject();
    const second = await seedProject();
    const added = unwrap(
      await addSecretKey(env.REGISTRY, {
        hash: await hashKey(secretKey()),
        projectId: second.id,
        label: "Second project's key",
        createdAt: NOW,
      }),
    );

    expect(await revokeSecretKey(env.REGISTRY, first.id, added.id)).toEqual({
      ok: true,
      value: "not found",
    });
    expect(await keyCount(second.id)).toBe(1);
  });
});

describe("deleting a project", () => {
  it("projects-21 · a delete marks the row, a second delete changes nothing, and the purge removes it", async () => {
    const seeded = await seedProject();
    const hash = await hashKey(secretKey());
    await env.REGISTRY.prepare(
      "INSERT INTO secret_keys (hash, project_id, label, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(hash, seeded.id, "CLI", NOW)
      .run();

    expect(unwrap(await markDeleted(env.REGISTRY, seeded.id, NOW))?.deletedAt).toBe(NOW);
    expect(unwrap(await markDeleted(env.REGISTRY, seeded.id, NOW + 100_000))?.deletedAt).toBe(NOW);
    expect(await getProject(env.REGISTRY, seeded.id)).toEqual({
      ok: true,
      value: expect.objectContaining({ id: seeded.id, deletedAt: NOW }),
    });
    expect(await markDeleted(env.REGISTRY, projectId(), NOW)).toEqual({ ok: true, value: null });

    expect(await removeProjectRows(env.REGISTRY, seeded.id)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await getProject(env.REGISTRY, seeded.id)).toEqual({ ok: true, value: null });
    expect(await keyCount(seeded.id)).toBe(0);
  });

  it("projects-25 · deleting one project leaves the other's token, settings and keys alone", async () => {
    const first = await seedProject({ name: "First", settings: { daily_event_cap: 1111 } });
    const second = await seedProject({ name: "Second", settings: { daily_event_cap: 2222 } });
    const key = secretKey();
    const added = unwrap(
      await addSecretKey(env.REGISTRY, {
        hash: await hashKey(key),
        projectId: second.id,
        label: "Second project's key",
        createdAt: NOW,
      }),
    );

    expect(unwrap(await markDeleted(env.REGISTRY, first.id, NOW))?.deletedAt).toBe(NOW);

    expect(await resolveToken(env.REGISTRY, caches.default, second.token, NOW)).toEqual({
      ok: true,
      value: { id: second.id, settings: second.settings },
    });
    expect(await resolveSecretKey(env.REGISTRY, caches.default, key, NOW)).toEqual({
      ok: true,
      value: { id: second.id, settings: second.settings },
    });
    const keys = unwrap(await listSecretKeys(env.REGISTRY, second.id));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toEqual(
      expect.objectContaining({ id: added.id, label: added.label, createdAt: added.createdAt }),
    );
    const row = await env.REGISTRY.prepare("SELECT token FROM projects WHERE id = ?")
      .bind(second.id)
      .first<{ token: string }>();
    expect(row?.token).toBe(second.token);
  });
});

describe("store failures", () => {
  it("platform-35 · a failing store write answers an error value and throws nothing", async () => {
    const token = publicToken();
    expect(
      (
        await createProject(env.REGISTRY, {
          id: projectId(),
          name: "First",
          token,
          createdAt: NOW,
          settings: DEFAULT_SETTINGS,
          tileIds: freshTileIds(),
        })
      ).ok,
    ).toBe(true);

    expect(
      await createProject(env.REGISTRY, {
        id: projectId(),
        name: "Second",
        token,
        createdAt: NOW,
        settings: DEFAULT_SETTINGS,
        tileIds: freshTileIds(),
      }),
    ).toEqual({ ok: false, error: { kind: "conflict" } });

    const seeded = await seedProject();
    const hash = await hashKey(secretKey());
    expect(
      (
        await addSecretKey(env.REGISTRY, {
          hash,
          projectId: seeded.id,
          label: "First",
          createdAt: NOW,
        })
      ).ok,
    ).toBe(true);
    expect(
      await addSecretKey(env.REGISTRY, {
        hash,
        projectId: seeded.id,
        label: "Again",
        createdAt: NOW,
      }),
    ).toEqual({ ok: false, error: { kind: "conflict" } });
  });
});

async function keyCount(id: string): Promise<number> {
  const row = await env.REGISTRY.prepare(
    "SELECT COUNT(*) AS count FROM secret_keys WHERE project_id = ?",
  )
    .bind(id)
    .first<{ count: number }>();
  return row?.count ?? -1;
}

async function updateCount(): Promise<number> {
  const row = await env.REGISTRY.prepare("SELECT count FROM key_updates").first<{
    count: number;
  }>();
  return row?.count ?? -1;
}

async function lastUsedDay(hash: string): Promise<string | null> {
  const row = await env.REGISTRY.prepare("SELECT last_used_day FROM secret_keys WHERE hash = ?")
    .bind(hash)
    .first<{ last_used_day: string | null }>();
  return row?.last_used_day ?? null;
}

it("projects-36 · a key of the right shape with one character wrong resolves to no project", async () => {
  const seeded = await seedProject();
  const key = secretKey();
  await addSecretKey(env.REGISTRY, {
    hash: await hashKey(key),
    projectId: seeded.id,
    label: "CLI",
    createdAt: NOW,
  });
  // The last character changed: same length, same prefix, another key.
  const last = key.at(-1) === "A" ? "B" : "A";
  const near = `${key.slice(0, -1)}${last}`;

  expect((await resolveSecretKey(env.REGISTRY, caches.default, key, NOW)).ok).toBe(true);
  expect(await resolveSecretKey(env.REGISTRY, caches.default, near, NOW)).toEqual({
    ok: true,
    value: null,
  });
});
