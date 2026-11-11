import {
  DISTINCT_ID_MAX,
  EXPORT_TABLES,
  eraseRequest,
  IMPORT_BODY_BYTES,
  IMPORT_LINES_MAX,
  IMPORT_ORDER,
  isJsonObject,
  PURGE_DELAY_MS,
  type PurgeAnswer,
} from "@cfanalytics/shared";
import type { Hono } from "hono";
import {
  type AppContext,
  type AppEnv,
  apiError,
  dashboardAnswer,
  REGISTRY_UNAVAILABLE,
  readJsonBody,
  STORE_UNAVAILABLE,
} from "../../platform/http.ts";
import { projectStore } from "../../platform/project-store-id.ts";
import { messageOf } from "../../platform/result.ts";
import { requireAdmin, requireSameOrigin } from "../../platform/session.ts";
import { dashboardProject, getProject } from "../projects/index.ts";
import { type EraseOutcome, eraseAnswer } from "./core.ts";

// The dashboard's privacy routes, behind requireAdmin, and requireSameOrigin
// for each that changes state (projects-26). A secret key is 401 on every one
// (platform-07). No CORS headers (platform-11).
//
//   POST /api/projects/:id/persons/erase       delete one person's data
//   GET  /api/projects/:id/export/:table       one page of a table's rows
//   POST /api/projects/:id/purge               start a deleted project's purge
//   POST /api/projects/:id/import/:table       a page of a backup's lines back in
export function mountPrivacy(app: Hono<AppEnv>): void {
  const access = requireAdmin();
  const sameOrigin = requireSameOrigin();
  app.all("/api/projects/:id/persons/erase", access, sameOrigin, handleErase);
  app.all("/api/projects/:id/export/:table", access, handleExport);
  app.all("/api/projects/:id/purge", access, sameOrigin, handlePurge);
  app.post("/api/projects/:id/import/:table", access, sameOrigin, handleImport);
}

/**
 * A page of a backup's lines back into the project's store, for the restore
 * command (privacy-30, privacy-31):
 * 1. A table not in EXPORT_TABLES is 404 not_found.
 * 2. readJsonBody with IMPORT_BODY_BYTES; the body must be {"lines": [...]}
 *    with at most IMPORT_LINES_MAX lines, else 400 validation_failed.
 * 3. dashboardProject: a failure is 503; an unknown or deleted project is 404.
 * 4. One RPC call, importPage: a line that is not a row of the table is 400
 *    naming it ("line 2: ..."); a row naming a person or recording not yet
 *    imported is 409 naming IMPORT_ORDER; either way nothing of the request
 *    is stored. A thrown error or a SchemaError is 503. Else 200 {"added": n}.
 */
async function handleImport(c: AppContext): Promise<Response> {
  const named = c.req.param("table") ?? "";
  const table = EXPORT_TABLES.find((candidate) => candidate === named);
  if (table === undefined) return apiError(404, "not_found", "That table is not imported.");

  const body = await readJsonBody(c.req.raw, IMPORT_BODY_BYTES);
  if (!body.ok) return body.error;
  const lines = isJsonObject(body.value) ? body.value.lines : undefined;
  if (!Array.isArray(lines) || lines.length > IMPORT_LINES_MAX) {
    const message = `The body must hold "lines", a list of at most ${String(IMPORT_LINES_MAX)} lines.`;
    return apiError(400, "validation_failed", message);
  }

  const project = await dashboardProject(c);
  if (!project.ok) return project.error;

  const deps = c.get("deps");
  let imported: Awaited<ReturnType<ReturnType<typeof projectStore>["importPage"]>>;
  try {
    imported = await projectStore(c.env, project.value.id).importPage(
      project.value.id,
      table,
      lines,
    );
  } catch (cause) {
    deps.log.error("project_store_failed", { message: messageOf(cause) });
    return apiError(503, "unavailable", STORE_UNAVAILABLE);
  }
  if (!imported.ok) {
    if (imported.error.kind === "bad line") {
      const { line, reason } = imported.error;
      return apiError(400, "validation_failed", `line ${String(line)}: ${reason}.`);
    }
    if (imported.error.kind === "missing parent") {
      const order = IMPORT_ORDER.join(", ");
      return apiError(
        409,
        "out_of_order",
        `A row names a person or recording not imported yet; import in this order: ${order}.`,
      );
    }
    deps.log.error("project_store_refused", { error: imported.error });
    return apiError(503, "unavailable", STORE_UNAVAILABLE);
  }
  return dashboardAnswer({ added: imported.value });
}

/** An erase body holds one distinct id and nothing else, so a kilobyte is room to spare. */
const ERASE_BODY_BYTES = 1024;

/**
 * Deletes one person's data (privacy-02, privacy-05, privacy-16 to
 * privacy-19):
 * 1. A method other than POST is 405 method_not_allowed.
 * 2. readJsonBody with 1 KiB: too large is 413; a body that is not JSON, or that
 *    eraseRequest (shared) refuses, is 400 validation_failed. The distinct
 *    id comes from the body only, never the URL, and is never logged
 *    (privacy-18).
 * 3. getProject: a failure is 503; an unknown or deleted project is 404.
 * 4. One RPC call, erasePerson, on projectStore(env, id). Its answer becomes
 *    an EraseOutcome (a thrown error or a SchemaError is "unavailable"), and
 *    eraseAnswer gives the status and body, with Cache-Control "no-store".
 */
export async function handleErase(c: AppContext): Promise<Response> {
  if (c.req.method !== "POST") {
    return apiError(405, "method_not_allowed", "Only POST is accepted on this path.");
  }

  const body = await readJsonBody(c.req.raw, ERASE_BODY_BYTES);
  if (!body.ok) return body.error;

  const request = eraseRequest.safeParse(body.value);
  if (!request.success) {
    const message = `The body must hold a distinctId of 1 to ${DISTINCT_ID_MAX} characters.`;
    return apiError(400, "validation_failed", message);
  }

  const project = await dashboardProject(c);
  if (!project.ok) return project.error;

  const deps = c.get("deps");
  let outcome: EraseOutcome;
  try {
    const erased = await projectStore(c.env, project.value.id).erasePerson(request.data.distinctId);
    outcome = erased.ok
      ? { kind: "erased", counts: erased.value }
      : erased.error.kind === "r2 failed"
        ? { kind: "r2 failed" }
        : { kind: "unavailable" };
  } catch (cause) {
    deps.log.error("project_store_failed", { message: messageOf(cause) });
    outcome = { kind: "unavailable" };
  }

  const answer = eraseAnswer(outcome);
  return dashboardAnswer(answer.body, answer.status);
}

/**
 * One export page, for the export command (privacy-22, privacy-25):
 * 1. A method other than GET is 405 method_not_allowed.
 * 2. A table not in EXPORT_TABLES (shared), salts and cookieless sessions
 *    included, is 404 not_found (privacy-22). `after`, from the query
 *    string, is a whole number of at least 0, 0 when absent; anything else
 *    is 400 validation_failed.
 * 3. getProject: a failure is 503; an unknown or deleted project is 404.
 * 4. One RPC call, exportPage(table, after): a thrown error or an error value
 *    is 503. 200 with the ExportPage as JSON and Cache-Control
 *    "private, no-store".
 */
export async function handleExport(c: AppContext): Promise<Response> {
  if (c.req.method !== "GET") {
    return apiError(405, "method_not_allowed", "Only GET is accepted on this path.");
  }

  const named = c.req.param("table") ?? "";
  const table = EXPORT_TABLES.find((candidate) => candidate === named);
  if (table === undefined) return apiError(404, "not_found", "That table is not exported.");

  const after = afterOf(c.req.query("after"));
  if (after === null) {
    return apiError(400, "validation_failed", "after must be a whole number of at least 0.");
  }

  const project = await dashboardProject(c);
  if (!project.ok) return project.error;

  const deps = c.get("deps");
  const store = projectStore(c.env, project.value.id);
  let page: Awaited<ReturnType<typeof store.exportPage>>;
  try {
    page = await store.exportPage(table, after);
  } catch (cause) {
    deps.log.error("project_store_failed", { message: messageOf(cause) });
    return apiError(503, "unavailable", STORE_UNAVAILABLE);
  }
  if (!page.ok) {
    deps.log.error("project_store_refused", { error: page.error });
    return apiError(503, "unavailable", STORE_UNAVAILABLE);
  }

  return dashboardAnswer(page.value);
}

/**
 * The `after` cursor as a rowid: 0 when the query string does not name one,
 * and null for anything that is not a whole number of at least 0.
 */
function afterOf(value: string | undefined): number | null {
  if (value === undefined) return 0;
  if (!/^[0-9]+$/.test(value)) return null;
  const after = Number(value);
  return Number.isSafeInteger(after) ? after : null;
}

/**
 * Starts the purge of a project marked deleted (privacy-03, privacy-20):
 * 1. A method other than POST is 405 method_not_allowed.
 * 2. getProject: a failure is 503; an unknown project, one whose rows the
 *    purge already removed, is 404; a project not marked deleted is 409
 *    not_deleted.
 * 3. One RPC call, schedulePurge(deletedAt + PURGE_DELAY_MS): a thrown error
 *    or an error value is 503.
 * 4. 202 with the PurgeAnswer, its purgeAt as ISO UTC. Asking again is
 *    harmless: the store keeps the earliest alarm (privacy-21).
 * The purge itself runs in the store's alarm (sweep.ts, runAlarm).
 */
export async function handlePurge(c: AppContext): Promise<Response> {
  if (c.req.method !== "POST") {
    return apiError(405, "method_not_allowed", "Only POST is accepted on this path.");
  }

  const deps = c.get("deps");
  const id = c.req.param("id") ?? "";
  const project = await getProject(c.env.REGISTRY, id);
  if (!project.ok) {
    deps.log.error("registry_unavailable", { message: project.error.message });
    return apiError(503, "unavailable", REGISTRY_UNAVAILABLE);
  }
  if (project.value === null) return apiError(404, "not_found", "No such project.");
  const deletedAt = project.value.deletedAt;
  if (deletedAt === null) {
    return apiError(409, "not_deleted", "The project is not marked deleted.");
  }

  const purgeAt = deletedAt + PURGE_DELAY_MS;
  try {
    const scheduled = await projectStore(c.env, id).schedulePurge(purgeAt);
    if (!scheduled.ok) {
      deps.log.error("project_store_refused", { error: scheduled.error });
      return apiError(503, "unavailable", STORE_UNAVAILABLE);
    }
  } catch (cause) {
    deps.log.error("project_store_failed", { message: messageOf(cause) });
    return apiError(503, "unavailable", STORE_UNAVAILABLE);
  }

  const answer: PurgeAnswer = { purgeAt: new Date(purgeAt).toISOString() };
  return dashboardAnswer(answer, 202);
}
