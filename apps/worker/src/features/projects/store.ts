import {
  type KeyInfo,
  missingStandardTiles,
  type ProjectInfo,
  type ProjectSettings,
  projectSettings,
  REGISTRY_CACHE_MS,
  STANDARD_TILES,
  TILE_LIMIT,
  type Tile,
  type TileSpec,
  tileSpec,
  tileSpecKey,
} from "@cfanalytics/shared";
import { err, messageOf, ok, type Result } from "../../platform/result.ts";
import { SETTINGS_COLUMNS, settingsFromRow, settingsToRow, usedDay } from "./core.ts";

// The D1 registry and its Cache API entries (D-4). Every statement binds its
// parameters. Cache entries live 60 s, are keyed by the token or by the key's
// hash, and never hold a plaintext key (projects-10, projects-12, projects-19).

/** A project's registry row, as the dashboard's API answers it (one shape, in packages/shared). */

/** What a capture request needs about its project: never the whole row. */
export interface ResolvedProject {
  id: string;
  settings: ProjectSettings;
}

export type StoreError = { kind: "unavailable"; message: string };

/**
 * The project of a public token, through a 60 s Cache API entry keyed by the
 * token, unknown answers included (projects-09 to projects-13). A deleted
 * project resolves to null. `now` stamps the entry, so a test needs no wait.
 * A registry failure is "unavailable" (intake-28).
 */
export async function resolveToken(
  db: D1Database,
  cache: Cache,
  token: string,
  now: number,
): Promise<Result<ResolvedProject | null, StoreError>> {
  if (token.trim() === "") return ok(null);
  const request = tokenCacheRequest(token);
  const cached = await readEntry(cache, request, now);
  if (cached !== null) {
    const hit = cachedProject(cached.value);
    if (hit !== undefined) return ok(hit);
  }

  let row: SettingsRow | null;
  try {
    row = await db
      .prepare(
        `SELECT id, ${SETTINGS_COLUMNS.join(", ")} FROM projects WHERE token = ? AND deleted_at IS NULL`,
      )
      .bind(token)
      .first<SettingsRow>();
  } catch (cause) {
    return unavailable(cause);
  }

  let resolved: ResolvedProject | null = null;
  if (row !== null) {
    const settings = settingsFromRow(row);
    if (!settings.ok) return err({ kind: "unavailable", message: settings.error });
    resolved = { id: row.id, settings: settings.value };
  }
  await writeEntry(cache, request, resolved, now);
  return ok(resolved);
}

/**
 * The project of a secret key, looked up by the SHA-256 hash of the key
 * through a 60 s cache entry keyed by the hash, whose value holds the project
 * id only (projects-15, projects-19). Writes `last_used_day` at most once a
 * day (projects-17). Revoked keys and deleted projects resolve to null.
 */
export async function resolveSecretKey(
  db: D1Database,
  cache: Cache,
  key: string,
  now: number,
): Promise<Result<ResolvedProject | null, StoreError>> {
  const hash = await hashKey(key);
  const request = keyCacheRequest(hash);
  const cached = await readEntry(cache, request, now);
  const cachedId = cachedProjectId(cached?.value);

  let projectId: string | null;
  if (cachedId !== undefined) {
    projectId = cachedId;
  } else {
    let keyRow: { project_id: string } | null;
    try {
      keyRow = await db
        .prepare("SELECT project_id FROM secret_keys WHERE hash = ?")
        .bind(hash)
        .first<{ project_id: string }>();
    } catch (cause) {
      return unavailable(cause);
    }
    projectId = keyRow?.project_id ?? null;
    await writeEntry(cache, request, { projectId }, now);
  }
  if (projectId === null) return ok(null);

  const day = usedDay(now);
  try {
    await db
      .prepare(
        "UPDATE secret_keys SET last_used_day = ? WHERE hash = ? AND (last_used_day IS NULL OR last_used_day <> ?)",
      )
      .bind(day, hash, day)
      .run();
  } catch (cause) {
    return unavailable(cause);
  }

  // The registry owns settings, so they are read live even when the key came
  // from the cache (projects-19).
  let row: SettingsRow | null;
  try {
    row = await db
      .prepare(
        `SELECT id, ${SETTINGS_COLUMNS.join(", ")} FROM projects WHERE id = ? AND deleted_at IS NULL`,
      )
      .bind(projectId)
      .first<SettingsRow>();
  } catch (cause) {
    return unavailable(cause);
  }
  if (row === null) return ok(null);

  const settings = settingsFromRow(row);
  if (!settings.ok) return err({ kind: "unavailable", message: settings.error });
  return ok({ id: row.id, settings: settings.value });
}

/** SHA-256 of a key, as 64 lower-case hex characters (projects-15). */
export async function hashKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createProject(
  db: D1Database,
  project: {
    id: string;
    name: string;
    token: string;
    createdAt: number;
    settings: ProjectSettings;
    /** One id per standard tile, in STANDARD_TILES' order (projects-40). */
    tileIds: readonly string[];
  },
): Promise<Result<ProjectInfo, StoreError | { kind: "conflict" }>> {
  const columns = ["id", "name", "token", "created_at", ...SETTINGS_COLUMNS];
  const placeholders = columns.map(() => "?").join(", ");
  try {
    // One batch, so a project never exists without its standard board.
    await db.batch([
      db
        .prepare(`INSERT INTO projects (${columns.join(", ")}) VALUES (${placeholders})`)
        .bind(
          project.id,
          project.name,
          project.token,
          project.createdAt,
          ...settingsToRow(project.settings),
        ),
      ...STANDARD_TILES.map((tile, position) =>
        insertTile(db, project.id, {
          id: project.tileIds[position] ?? "",
          title: tile.title,
          spec: tile.spec,
          standard: true,
          position,
          createdAt: project.createdAt,
        }),
      ),
    ]);
  } catch (cause) {
    return writeError(cause);
  }
  return ok({
    id: project.id,
    name: project.name,
    token: project.token,
    createdAt: project.createdAt,
    deletedAt: null,
    settings: project.settings,
  });
}

export async function getProject(
  db: D1Database,
  id: string,
): Promise<Result<ProjectInfo | null, StoreError>> {
  let row: ProjectRow | null;
  try {
    row = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<ProjectRow>();
  } catch (cause) {
    return unavailable(cause);
  }
  if (row === null) return ok(null);
  return projectFromRow(row);
}

/** Every project that is not deleted, by name. */
export async function listProjects(db: D1Database): Promise<Result<ProjectInfo[], StoreError>> {
  let rows: D1Result<ProjectRow>;
  try {
    rows = await db
      .prepare("SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY name")
      .all<ProjectRow>();
  } catch (cause) {
    return unavailable(cause);
  }
  const projects: ProjectInfo[] = [];
  for (const row of rows.results) {
    const project = projectFromRow(row);
    if (!project.ok) return project;
    projects.push(project.value);
  }
  return ok(projects);
}

export async function updateSettings(
  db: D1Database,
  id: string,
  settings: ProjectSettings,
): Promise<Result<ProjectInfo | null, StoreError>> {
  const assignments = SETTINGS_COLUMNS.map((column) => `${column} = ?`).join(", ");
  try {
    await db
      .prepare(`UPDATE projects SET ${assignments} WHERE id = ?`)
      .bind(...settingsToRow(settings), id)
      .run();
  } catch (cause) {
    return unavailable(cause);
  }
  return getProject(db, id);
}

/** Marks a project deleted at `now`; a second call changes nothing (projects-21). */
export async function markDeleted(
  db: D1Database,
  id: string,
  now: number,
): Promise<Result<ProjectInfo | null, StoreError>> {
  try {
    await db
      .prepare("UPDATE projects SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
      .bind(now, id)
      .run();
  } catch (cause) {
    return unavailable(cause);
  }
  return getProject(db, id);
}

/** Removes the project's `secret_keys` rows and then its `projects` row: the purge's last step (privacy-03). */
export async function removeProjectRows(
  db: D1Database,
  id: string,
): Promise<Result<void, StoreError>> {
  try {
    // One batch, so a half-removed project never outlives a crash.
    await db.batch([
      db.prepare("DELETE FROM secret_keys WHERE project_id = ?").bind(id),
      db.prepare("DELETE FROM board_tiles WHERE project_id = ?").bind(id),
      db.prepare("DELETE FROM projects WHERE id = ?").bind(id),
    ]);
  } catch (cause) {
    return unavailable(cause);
  }
  return ok(undefined);
}

/** Stores a new key's hash; the plaintext is never stored (projects-14). */
export async function addSecretKey(
  db: D1Database,
  key: { hash: string; projectId: string; label: string; createdAt: number },
): Promise<Result<KeyInfo, StoreError | { kind: "conflict" }>> {
  try {
    await db
      .prepare("INSERT INTO secret_keys (hash, project_id, label, created_at) VALUES (?, ?, ?, ?)")
      .bind(key.hash, key.projectId, key.label, key.createdAt)
      .run();
  } catch (cause) {
    return writeError(cause);
  }
  return ok({
    id: key.hash.slice(0, 12),
    label: key.label,
    createdAt: key.createdAt,
    lastUsedDay: null,
  });
}

/** A project's keys, without hashes or plaintext (projects-16). */
export async function listSecretKeys(
  db: D1Database,
  projectId: string,
): Promise<Result<KeyInfo[], StoreError>> {
  let rows: D1Result<KeyRow>;
  try {
    rows = await db
      .prepare(
        "SELECT hash, label, created_at, last_used_day FROM secret_keys WHERE project_id = ? ORDER BY created_at",
      )
      .bind(projectId)
      .all<KeyRow>();
  } catch (cause) {
    return unavailable(cause);
  }
  return ok(
    rows.results.map((row) => ({
      id: row.hash.slice(0, 12),
      label: row.label,
      createdAt: row.created_at,
      lastUsedDay: row.last_used_day,
    })),
  );
}

/** Deletes a key of this project; a key of another project, or none, is "not found" (projects-18, projects-20). */
export async function revokeSecretKey(
  db: D1Database,
  projectId: string,
  keyId: string,
): Promise<Result<"revoked" | "not found", StoreError>> {
  let result: D1Result;
  try {
    result = await db
      .prepare("DELETE FROM secret_keys WHERE project_id = ? AND substr(hash, 1, 12) = ?")
      .bind(projectId, keyId)
      .run();
  } catch (cause) {
    return unavailable(cause);
  }
  return ok(result.meta.changes > 0 ? "revoked" : "not found");
}

// The cache lives in the Cache API, never in module state (D-4), and an entry
// is stamped with the caller's clock so its age can be judged without waiting.
const REGISTRY_ORIGIN = "https://registry.cfanalytics.internal";
const CACHE_SECONDS = Math.floor(REGISTRY_CACHE_MS / 1000);

interface SettingsRow extends Readonly<Record<string, unknown>> {
  readonly id: string;
}

interface ProjectRow extends SettingsRow {
  readonly name: string;
  readonly token: string;
  readonly created_at: number;
  readonly deleted_at: number | null;
}

interface KeyRow {
  readonly hash: string;
  readonly label: string;
  readonly created_at: number;
  readonly last_used_day: string | null;
}

function tokenCacheRequest(token: string): Request {
  return new Request(`${REGISTRY_ORIGIN}/tokens/${encodeURIComponent(token)}`);
}

function keyCacheRequest(hash: string): Request {
  return new Request(`${REGISTRY_ORIGIN}/keys/${hash}`);
}

/** The project a token cache entry holds; undefined when the entry cannot be trusted. */
function cachedProject(value: unknown): ResolvedProject | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || !("id" in value) || !("settings" in value)) return undefined;
  if (typeof value.id !== "string") return undefined;
  const settings = projectSettings.safeParse(value.settings);
  if (!settings.success) return undefined;
  return { id: value.id, settings: settings.data };
}

/** The project id a key cache entry holds; undefined when the entry cannot be trusted. */
function cachedProjectId(value: unknown): string | null | undefined {
  if (typeof value !== "object" || value === null || !("projectId" in value)) return undefined;
  const { projectId } = value;
  if (projectId === null || typeof projectId === "string") return projectId;
  return undefined;
}

/** An entry younger than the registry's cache life, or null for a miss. */
async function readEntry(
  cache: Cache,
  request: Request,
  now: number,
): Promise<{ fetchedAt: number; value: unknown } | null> {
  const response = await cache.match(request);
  if (response === undefined) return null;
  let entry: unknown;
  try {
    entry = await response.json();
  } catch {
    return null;
  }
  if (typeof entry !== "object" || entry === null) return null;
  if (!("fetchedAt" in entry) || !("value" in entry)) return null;
  if (typeof entry.fetchedAt !== "number") return null;
  if (now - entry.fetchedAt >= REGISTRY_CACHE_MS) return null;
  return { fetchedAt: entry.fetchedAt, value: entry.value };
}

async function writeEntry(
  cache: Cache,
  request: Request,
  value: unknown,
  now: number,
): Promise<void> {
  const response = Response.json(
    { fetchedAt: now, value },
    { headers: { "cache-control": `max-age=${CACHE_SECONDS}` } },
  );
  await cache.put(request, response);
}

function projectFromRow(row: ProjectRow): Result<ProjectInfo, StoreError> {
  const settings = settingsFromRow(row);
  if (!settings.ok) return err({ kind: "unavailable", message: settings.error });
  return ok({
    id: row.id,
    name: row.name,
    token: row.token,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    settings: settings.value,
  });
}

/** A unique constraint is a conflict the caller can retry; anything else is the registry being unwell. */
function writeError(cause: unknown): Result<never, StoreError | { kind: "conflict" }> {
  const message = messageOf(cause);
  if (message.includes("UNIQUE constraint failed")) return err({ kind: "conflict" });
  return err({ kind: "unavailable", message });
}

function unavailable(cause: unknown): Result<never, StoreError> {
  return err({ kind: "unavailable", message: messageOf(cause) });
}

/** One tile row's insert, at a position the caller chose. */
function insertTile(
  db: D1Database,
  projectId: string,
  tile: {
    id: string;
    title: string;
    spec: TileSpec;
    standard: boolean;
    position: number;
    createdAt: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO board_tiles (id, project_id, position, title, spec, standard, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      tile.id,
      projectId,
      tile.position,
      tile.title,
      JSON.stringify(tile.spec),
      tile.standard ? 1 : 0,
      tile.createdAt,
    );
}

/** A stored tile row as a Tile. A spec that no longer parses is a broken invariant of our own writes. */
function tileOf(row: Readonly<Record<string, unknown>>): Tile {
  const parsed = tileSpec.safeParse(JSON.parse(String(row.spec)));
  if (!parsed.success)
    throw new Error(`board tile ${String(row.id)} holds a spec that does not parse`);
  return {
    id: String(row.id),
    title: String(row.title),
    spec: parsed.data,
    standard: row.standard === 1,
  };
}

/** A project's tiles in position order (projects-41). */
export async function listTiles(
  db: D1Database,
  projectId: string,
): Promise<Result<Tile[], StoreError>> {
  try {
    const rows = await db
      .prepare(
        "SELECT id, title, spec, standard FROM board_tiles WHERE project_id = ? ORDER BY position, created_at, id",
      )
      .bind(projectId)
      .all();
    return ok(rows.results.map(tileOf));
  } catch (cause) {
    return unavailable(cause);
  }
}

/**
 * Adds a tile at the end of the board, in one statement that also checks the
 * board holds fewer than TILE_LIMIT tiles, so two adds never pass it together
 * (projects-42). "full" when it holds that many.
 */
export async function addTile(
  db: D1Database,
  projectId: string,
  tile: { id: string; title: string; spec: TileSpec; standard: boolean; createdAt: number },
): Promise<Result<Tile, StoreError | { kind: "full" }>> {
  try {
    const written = await db
      .prepare(
        `INSERT INTO board_tiles (id, project_id, position, title, spec, standard, created_at)
         SELECT ?, ?, COALESCE(MAX(position) + 1, 0), ?, ?, ?, ?
           FROM board_tiles WHERE project_id = ?
         HAVING COUNT(*) < ?`,
      )
      .bind(
        tile.id,
        projectId,
        tile.title,
        JSON.stringify(tile.spec),
        tile.standard ? 1 : 0,
        tile.createdAt,
        projectId,
        TILE_LIMIT,
      )
      .run();
    if (written.meta.changes === 0) return err({ kind: "full" });
  } catch (cause) {
    return unavailable(cause);
  }
  return ok({ id: tile.id, title: tile.title, spec: tile.spec, standard: tile.standard });
}

/**
 * Renames a tile, changes its spec, moves it to `position` (clamped to the
 * board), or several, in one batch that rewrites every position, so the
 * others keep their order around it (projects-43). A standard tile whose spec
 * changes stops being standard (projects-45). null when the project has no
 * such tile.
 */
export async function updateTile(
  db: D1Database,
  projectId: string,
  tileId: string,
  change: {
    title?: string | undefined;
    position?: number | undefined;
    spec?: TileSpec | undefined;
  },
): Promise<Result<Tile | null, StoreError>> {
  const listed = await listTiles(db, projectId);
  if (!listed.ok) return listed;
  const tiles = listed.value;
  const at = tiles.findIndex((tile) => tile.id === tileId);
  const found = tiles[at];
  if (found === undefined) return ok(null);
  // A standard tile asked a new question is the board's own from then on (projects-45).
  const respecified =
    change.spec !== undefined && tileSpecKey(change.spec) !== tileSpecKey(found.spec);
  const updated = {
    ...found,
    title: change.title ?? found.title,
    spec: change.spec ?? found.spec,
    standard: found.standard && !respecified,
  };
  const order = tiles.filter((tile) => tile.id !== tileId);
  const to = Math.min(change.position ?? at, order.length);
  order.splice(to, 0, updated);
  try {
    await db.batch(
      order.map((tile, position) =>
        db
          .prepare(
            "UPDATE board_tiles SET position = ?, title = ?, spec = ?, standard = ? WHERE id = ? AND project_id = ?",
          )
          .bind(
            position,
            tile.title,
            JSON.stringify(tile.spec),
            tile.standard ? 1 : 0,
            tile.id,
            projectId,
          ),
      ),
    );
  } catch (cause) {
    return unavailable(cause);
  }
  return ok(updated);
}

/** Removes a tile; false when the project has no such tile (projects-43). */
export async function removeTile(
  db: D1Database,
  projectId: string,
  tileId: string,
): Promise<Result<boolean, StoreError>> {
  try {
    const removed = await db
      .prepare("DELETE FROM board_tiles WHERE id = ? AND project_id = ?")
      .bind(tileId, projectId)
      .run();
    return ok(removed.meta.changes > 0);
  } catch (cause) {
    return unavailable(cause);
  }
}

/**
 * Adds back, at the end and in STANDARD_TILES' order, every standard tile
 * the board lacks by missingStandardTiles (projects-45); the board's own
 * tiles stay. Stops at TILE_LIMIT (projects-44). `newId` names each added tile.
 */
export async function restoreTiles(
  db: D1Database,
  projectId: string,
  newId: () => string,
  now: number,
): Promise<Result<Tile[], StoreError>> {
  const listed = await listTiles(db, projectId);
  if (!listed.ok) return listed;
  const missing = missingStandardTiles(listed.value);
  const room = Math.max(0, TILE_LIMIT - listed.value.length);
  // After deletions the positions have gaps, so the end is the highest one, not the count.
  let start: number;
  try {
    const last = await db
      .prepare(
        "SELECT COALESCE(MAX(position) + 1, 0) AS next FROM board_tiles WHERE project_id = ?",
      )
      .bind(projectId)
      .first<{ next: number }>();
    start = last?.next ?? 0;
  } catch (cause) {
    return unavailable(cause);
  }
  const added = missing.slice(0, room).map((tile, index) => ({
    id: newId(),
    title: tile.title,
    spec: tile.spec,
    standard: true,
    position: start + index,
    createdAt: now,
  }));
  if (added.length > 0) {
    try {
      await db.batch(added.map((tile) => insertTile(db, projectId, tile)));
    } catch (cause) {
      return unavailable(cause);
    }
  }
  return listTiles(db, projectId);
}
