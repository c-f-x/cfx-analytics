import {
  bytesToBase64url,
  jsonPointer,
  type ProjectInfo,
  QUERY,
  STANDARD_TILES,
  tileCreate,
  tileUpdate,
} from "@cfanalytics/shared";
import type { Hono } from "hono";
import {
  type AppContext,
  type AppEnv,
  apiError,
  dashboardAnswer,
  REGISTRY_UNAVAILABLE,
  readJsonBody,
  sdkError,
} from "../../platform/http.ts";
import { err, ok, type Result } from "../../platform/result.ts";
import { requireAdmin, requireSameOrigin } from "../../platform/session.ts";
import {
  checkCreate,
  checkUpdate,
  projectIdFrom,
  type SettingsIssue,
  secretKeyFrom,
  tokenFrom,
} from "./core.ts";
import {
  addSecretKey,
  addTile,
  createProject,
  getProject,
  hashKey,
  listProjects,
  listSecretKeys,
  listTiles,
  markDeleted,
  type ResolvedProject,
  removeTile,
  resolveToken,
  restoreTiles,
  revokeSecretKey,
  type StoreError,
  updateSettings,
  updateTile,
} from "./store.ts";

// The dashboard's project routes, behind requireAdmin, and requireSameOrigin
// for every state change (projects-26):
//
//   GET    /api/projects                     list
//   POST   /api/projects                     create {name, settings?} -> project with its token
//   GET    /api/projects/:id                 one project
//   PATCH  /api/projects/:id                 partial settings update
//   DELETE /api/projects/:id                 mark deleted (needs {confirm: <project name>});
//                                            the purge is scheduled with privacy, in wave 4
//   GET    /api/projects/:id/keys            list keys
//   POST   /api/projects/:id/keys            create {label} -> the key, shown once
//   DELETE /api/projects/:id/keys/:keyId     revoke
//
// Bad input is 400 with the issues; an unknown id is 404 (projects-20, projects-21).
export function mountProjects(app: Hono<AppEnv>): void {
  const access = requireAdmin();
  const sameOrigin = requireSameOrigin();
  app.get("/api/projects", access, handleList);
  app.post("/api/projects", access, sameOrigin, handleCreate);
  app.get("/api/projects/:id", access, handleGet);
  app.patch("/api/projects/:id", access, sameOrigin, handleUpdate);
  app.delete("/api/projects/:id", access, sameOrigin, handleDelete);
  app.get("/api/projects/:id/keys", access, handleListKeys);
  app.post("/api/projects/:id/keys", access, sameOrigin, handleCreateKey);
  app.delete("/api/projects/:id/keys/:keyId", access, sameOrigin, handleRevokeKey);
  app.get("/api/projects/:id/tiles", access, handleListTiles);
  app.post("/api/projects/:id/tiles", access, sameOrigin, handleAddTile);
  app.post("/api/projects/:id/tiles/restore", access, sameOrigin, handleRestoreTiles);
  app.patch("/api/projects/:id/tiles/:tileId", access, sameOrigin, handleUpdateTile);
  app.delete("/api/projects/:id/tiles/:tileId", access, sameOrigin, handleRemoveTile);
}

/** List projects. */
export async function handleList(c: AppContext): Promise<Response> {
  const projects = await listProjects(c.env.REGISTRY);
  if (!projects.ok) return unavailable(c, projects.error);
  return dashboardAnswer({ projects: projects.value.map(projectAnswer) });
}

/** Create a project. */
export async function handleCreate(c: AppContext): Promise<Response> {
  const body = await bodyOf(c);
  if (!body.ok) return body.error;
  const checked = checkCreate(body.value);
  if (!checked.ok) return validationIssues(checked.error);

  const deps = c.get("deps");
  const id = projectIdFrom(deps.random(10));
  const token = tokenFrom(deps.random(32));
  if (!id.ok || !token.ok) {
    return apiError(503, "unavailable", "The random source returned the wrong number of bytes.");
  }
  const created = await createProject(c.env.REGISTRY, {
    id: id.value,
    name: checked.value.name,
    token: token.value,
    createdAt: deps.now(),
    settings: checked.value.settings,
    tileIds: STANDARD_TILES.map(() => tileIdOf(c)),
  });
  if (created.ok) return dashboardAnswer(projectAnswer(created.value), 201);
  if (created.error.kind === "conflict") {
    return apiError(
      503,
      "unavailable",
      "The registry refused a freshly drawn project id or token.",
    );
  }
  return unavailable(c, created.error);
}

/** One project. */
export async function handleGet(c: AppContext): Promise<Response> {
  const project = await getProject(c.env.REGISTRY, routeParam(c, "id"));
  if (!project.ok) return unavailable(c, project.error);
  if (project.value === null) return projectNotFound();
  return dashboardAnswer(projectAnswer(project.value));
}

/** Update settings. */
export async function handleUpdate(c: AppContext): Promise<Response> {
  const body = await bodyOf(c);
  if (!body.ok) return body.error;
  const id = routeParam(c, "id");
  const current = await getProject(c.env.REGISTRY, id);
  if (!current.ok) return unavailable(c, current.error);
  if (current.value === null) return projectNotFound();

  const checked = checkUpdate(current.value.settings, body.value);
  if (!checked.ok) return validationIssues(checked.error);
  const saved = await updateSettings(c.env.REGISTRY, id, checked.value);
  if (!saved.ok) return unavailable(c, saved.error);
  if (saved.value === null) return projectNotFound();
  return dashboardAnswer(projectAnswer(saved.value));
}

/** Mark the project deleted. */
export async function handleDelete(c: AppContext): Promise<Response> {
  const id = routeParam(c, "id");
  const project = await getProject(c.env.REGISTRY, id);
  if (!project.ok) return unavailable(c, project.error);
  if (project.value === null) return projectNotFound();

  const body = await bodyOf(c);
  const confirm = body.ok ? confirmOf(body.value) : null;
  if (confirm !== project.value.name) {
    return apiError(400, "validation_failed", "confirm must be the project's name.");
  }
  const marked = await markDeleted(c.env.REGISTRY, id, c.get("deps").now());
  if (!marked.ok) return unavailable(c, marked.error);
  if (marked.value === null) return projectNotFound();
  return dashboardAnswer(projectAnswer(marked.value));
}

/** List keys. */
export async function handleListKeys(c: AppContext): Promise<Response> {
  const id = routeParam(c, "id");
  const project = await getProject(c.env.REGISTRY, id);
  if (!project.ok) return unavailable(c, project.error);
  if (project.value === null) return projectNotFound();

  const keys = await listSecretKeys(c.env.REGISTRY, id);
  if (!keys.ok) return unavailable(c, keys.error);
  return dashboardAnswer({ keys: keys.value });
}

/** Create a key, shown once. */
export async function handleCreateKey(c: AppContext): Promise<Response> {
  const id = routeParam(c, "id");
  const project = await getProject(c.env.REGISTRY, id);
  if (!project.ok) return unavailable(c, project.error);
  if (project.value === null) return projectNotFound();

  const body = await bodyOf(c);
  if (!body.ok) return body.error;
  const label = labelOf(body.value);
  if (label === null) {
    return apiError(400, "validation_failed", "label must be 1 to 100 characters.");
  }

  const deps = c.get("deps");
  const key = secretKeyFrom(deps.random(32));
  if (!key.ok) {
    return apiError(503, "unavailable", "The random source returned the wrong number of bytes.");
  }
  const added = await addSecretKey(c.env.REGISTRY, {
    hash: await hashKey(key.value),
    projectId: id,
    label,
    createdAt: deps.now(),
  });
  if (added.ok) return dashboardAnswer({ key: key.value, ...added.value }, 201);
  if (added.error.kind === "conflict") {
    return apiError(503, "unavailable", "The registry refused a freshly drawn key.");
  }
  return unavailable(c, added.error);
}

/** Revoke a key. */
export async function handleRevokeKey(c: AppContext): Promise<Response> {
  const id = routeParam(c, "id");
  const project = await getProject(c.env.REGISTRY, id);
  if (!project.ok) return unavailable(c, project.error);
  if (project.value === null) return projectNotFound();

  const keyId = routeParam(c, "keyId");
  const revoked = await revokeSecretKey(c.env.REGISTRY, id, keyId);
  if (!revoked.ok) return unavailable(c, revoked.error);
  if (revoked.value === "not found") return apiError(404, "not_found", "No such key.");
  return dashboardAnswer({ id: keyId, revoked: true });
}

function projectAnswer(project: ProjectInfo): ProjectInfo {
  return {
    id: project.id,
    name: project.name,
    token: project.token,
    createdAt: project.createdAt,
    deletedAt: project.deletedAt,
    settings: project.settings,
  };
}

/** The request body as JSON, at most QUERY.bodyBytes (projects-39); an empty body is null. */
function bodyOf(c: AppContext): Promise<Result<unknown, Response>> {
  return readJsonBody(c.req.raw, QUERY.bodyBytes, "null");
}

function labelOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const { label } = body as { label?: unknown };
  if (typeof label !== "string") return null;
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > 100) return null;
  return trimmed;
}

function confirmOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const { confirm } = body as { confirm?: unknown };
  return typeof confirm === "string" ? confirm : null;
}

/** The database's message goes to the log, never to the caller (platform-42). */
function unavailable(c: AppContext, error: StoreError): Response {
  c.get("deps").log.error("registry_unavailable", { message: error.message });
  return apiError(503, "unavailable", "The registry is unavailable.");
}

function projectNotFound(): Response {
  return apiError(404, "not_found", "No such project.");
}

/** One sentence naming the first problem, and every problem with the body (platform-34). */
function validationIssues(issues: SettingsIssue[]): Response {
  const [first] = issues;
  const message =
    first === undefined ? "The body is not valid." : `${first.setting}: ${first.rule}.`;
  return apiError(
    400,
    "validation_failed",
    message,
    issues.map((issue) => ({
      path: jsonPointer([issue.setting]),
      code: "invalid",
      message: issue.rule,
    })),
  );
}

/** The router matched the route, so the parameter is there; an empty id finds no project. */
function routeParam(c: AppContext, name: "id" | "keyId" | "tileId"): string {
  return c.req.param(name) ?? "";
}

/**
 * The project of an SDK path's token, for intake, recordings and config:
 * resolveToken through the Cache API at `now`. A registry failure is 503 and
 * an unknown token 401, each an sdkError with the path's CORS headers; the
 * registry's own message goes to the log only (intake-02, intake-28,
 * config-07, platform-42). One home for the rule, so every SDK path answers
 * alike.
 */
export async function sdkProject(
  c: AppContext,
  token: string,
  now: number,
  cors: Record<string, string>,
): Promise<Result<ResolvedProject, Response>> {
  const project = await resolveToken(c.env.REGISTRY, caches.default, token, now);
  if (!project.ok) {
    c.get("deps").log.error("registry_unavailable", { message: project.error.message });
    return err(sdkError(cors, 503, "unavailable", REGISTRY_UNAVAILABLE));
  }
  if (project.value === null) {
    return err(sdkError(cors, 401, "unauthorized", "No project has this token."));
  }
  return ok(project.value);
}

/**
 * The project a dashboard path names in `:id`, for recordings and heatmaps:
 * 503 when the registry fails, its message logged only, and 404 when the
 * project is unknown or marked deleted (projects-21, platform-42).
 */
export async function dashboardProject(c: AppContext): Promise<Result<ResolvedProject, Response>> {
  const project = await getProject(c.env.REGISTRY, c.req.param("id") ?? "");
  if (!project.ok) {
    c.get("deps").log.error("registry_unavailable", { message: project.error.message });
    return err(apiError(503, "unavailable", REGISTRY_UNAVAILABLE));
  }
  if (project.value === null || project.value.deletedAt !== null) return err(projectNotFound());
  return ok({ id: project.value.id, settings: project.value.settings });
}

/** A new tile's id: 12 random bytes as base64url. */
function tileIdOf(c: AppContext): string {
  return bytesToBase64url(c.get("deps").random(12));
}

/** A zod refusal as one sentence naming the first bad path, and every issue (platform-34). */
function schemaIssues(issues: readonly { path: PropertyKey[]; message: string }[]): Response {
  const [first] = issues;
  const path = first === undefined ? "" : jsonPointer(first.path);
  return apiError(
    400,
    "validation_failed",
    first === undefined ? "The body is not valid." : `${path || "The body"}: ${first.message}.`,
    issues.map((issue) => ({
      path: jsonPointer(issue.path),
      code: "validation_failed",
      message: issue.message,
    })),
  );
}

/** The route's project when it exists; else the 404 or 503 to answer. */
async function tileProject(c: AppContext): Promise<Result<string, Response>> {
  const id = routeParam(c, "id");
  const project = await getProject(c.env.REGISTRY, id);
  if (!project.ok) return err(unavailable(c, project.error));
  if (project.value === null) return err(projectNotFound());
  return ok(id);
}

function tileNotFound(): Response {
  return apiError(404, "not_found", "No such tile on this board.");
}

/** The board's tiles in order (projects-41). */
export async function handleListTiles(c: AppContext): Promise<Response> {
  const project = await tileProject(c);
  if (!project.ok) return project.error;
  const tiles = await listTiles(c.env.REGISTRY, project.value);
  if (!tiles.ok) return unavailable(c, tiles.error);
  return dashboardAnswer({ tiles: tiles.value });
}

/** Adds a saved question at the end of the board (projects-42). */
export async function handleAddTile(c: AppContext): Promise<Response> {
  const project = await tileProject(c);
  if (!project.ok) return project.error;
  const body = await bodyOf(c);
  if (!body.ok) return body.error;
  const parsed = tileCreate.safeParse(body.value);
  if (!parsed.success) return schemaIssues(parsed.error.issues);
  const added = await addTile(c.env.REGISTRY, project.value, {
    id: tileIdOf(c),
    title: parsed.data.title,
    spec: parsed.data.spec,
    standard: false,
    createdAt: c.get("deps").now(),
  });
  if (added.ok) return dashboardAnswer({ tile: added.value }, 201);
  if (added.error.kind === "full") {
    return apiError(400, "validation_failed", "A board holds at most 40 tiles.");
  }
  return unavailable(c, added.error);
}

/** Renames or moves a tile (projects-43). */
export async function handleUpdateTile(c: AppContext): Promise<Response> {
  const project = await tileProject(c);
  if (!project.ok) return project.error;
  const body = await bodyOf(c);
  if (!body.ok) return body.error;
  const parsed = tileUpdate.safeParse(body.value);
  if (!parsed.success) return schemaIssues(parsed.error.issues);
  const updated = await updateTile(
    c.env.REGISTRY,
    project.value,
    routeParam(c, "tileId"),
    parsed.data,
  );
  if (!updated.ok) return unavailable(c, updated.error);
  if (updated.value === null) return tileNotFound();
  return dashboardAnswer({ tile: updated.value });
}

/** Removes a tile (projects-43). */
export async function handleRemoveTile(c: AppContext): Promise<Response> {
  const project = await tileProject(c);
  if (!project.ok) return project.error;
  const removed = await removeTile(c.env.REGISTRY, project.value, routeParam(c, "tileId"));
  if (!removed.ok) return unavailable(c, removed.error);
  if (!removed.value) return tileNotFound();
  return new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } });
}

/** Adds back the standard tiles the board lacks (projects-44). */
export async function handleRestoreTiles(c: AppContext): Promise<Response> {
  const project = await tileProject(c);
  if (!project.ok) return project.error;
  const tiles = await restoreTiles(
    c.env.REGISTRY,
    project.value,
    () => tileIdOf(c),
    c.get("deps").now(),
  );
  if (!tiles.ok) return unavailable(c, tiles.error);
  return dashboardAnswer({ tiles: tiles.value });
}
