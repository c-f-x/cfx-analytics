import {
  type Answer,
  type ApiIssue,
  ERROR_CODES,
  type ErrorCode,
  QUERY,
  type QuerySpec,
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
import type { Deps } from "../../platform/deps.ts";
import { projectStore } from "../../platform/project-store-id.ts";
import { err, messageOf, ok, type Result } from "../../platform/result.ts";
import { requireAdmin } from "../../platform/session.ts";
import { retentionStart } from "../intake/index.ts";
import {
  bearerOf,
  dashboardProject,
  isSecretKeyShape,
  type ResolvedProject,
  resolveSecretKey,
} from "../projects/index.ts";
import { answerQuery, prepareQuery, type QueryResult } from "./compile.ts";
import { parseSpec } from "./validate.ts";

// The query routes (architecture.md, "A query"). Neither carries CORS
// headers, whatever the origin (platform-11).
//
//   POST /api/projects/:id/query   behind requireAdmin, so a secret key is
//                                  401 (platform-07, query-01)
//   POST /api/external/query       a project's secret key as a Bearer token;
//                                  the key decides the project (D-5, query-01)
export function mountQuery(app: Hono<AppEnv>): void {
  app.all("/api/projects/:id/query", requireAdmin(), handleDashboardQuery);
  app.all("/api/external/query", handleExternalQuery);
}

/** The media type of a Content-Type value, without its parameters (query-19). */
const mediaTypeOf = (value: string): string => value.split(";")[0]?.trim().toLowerCase() ?? "";

/** Every way an external caller can fail to present a key is one 401 body (platform-09). */
const keyRefused = (): Response =>
  apiError(401, "unauthorized", "This request needs a valid project key.");

/** Whether a refused spec's code is one the API publishes (platform-34). */
const isErrorCode = (code: string): code is ErrorCode =>
  (ERROR_CODES as readonly string[]).includes(code);

/** The first issue as one sentence, every issue attached (query-18, platform-34). */
function failureOf(first: ApiIssue, issues: ApiIssue[], code: ErrorCode): Response {
  const where = first.path === "" ? "" : `${first.path}: `;
  const sentence = `${where}${first.message}`;
  return apiError(400, code, sentence.endsWith(".") ? sentence : `${sentence}.`, issues);
}

/** A body parseSpec refused: 400, unknown_kind when that is the first issue (query-18, platform-34). */
const specFailure = (issues: ApiIssue[]): Response => {
  const [first] = issues;
  if (first === undefined) return apiError(400, "validation_failed", "The body was refused.");
  const code = first.code === "unknown_kind" ? "unknown_kind" : "validation_failed";
  return failureOf(first, issues, code);
};

/** A spec prepareQuery refused: 400, with the first issue's code when it is one (query-11, query-31). */
const prepareFailure = (issues: ApiIssue[]): Response => {
  const [first] = issues;
  if (first === undefined) return apiError(400, "validation_failed", "The query was refused.");
  return failureOf(first, issues, isErrorCode(first.code) ? first.code : "validation_failed");
};

/**
 * Steps 1 to 5 of handleDashboardQuery's list: the method, the content type,
 * the bounded body, JSON, and parseSpec, in that order (query-18, query-19).
 */
async function readSpec(c: AppContext): Promise<Result<QuerySpec, Response>> {
  if (c.req.method !== "POST") {
    return err(apiError(405, "method_not_allowed", "Only POST is accepted on this path."));
  }
  if (mediaTypeOf(c.req.header("content-type") ?? "") !== "application/json") {
    return err(apiError(415, "unsupported_media_type", "The body must be JSON."));
  }

  const body = await readJsonBody(c.req.raw, QUERY.bodyBytes);
  if (!body.ok) return err(body.error);

  const spec = parseSpec(body.value);
  if (!spec.ok) return err(specFailure(spec.error));
  return ok(spec.value);
}

/** Steps 7 to 9: prepare the spec, one runQuery RPC, and the answer (query-12, query-73). */
/** Why a project's query has no answer: its spec does not fit, or its store did not answer. */
export type RunFailure = { kind: "invalid"; issues: ApiIssue[] } | { kind: "unavailable" };

/**
 * A query against one project's store, with the project's time zone,
 * retention and own-traffic rules. The dashboard's route, the external route
 * and the weekly email all run their queries through this (#23).
 */
export async function runProjectQuery(
  env: Cloudflare.Env,
  deps: Deps,
  project: ResolvedProject,
  spec: QuerySpec,
): Promise<Result<Answer<QueryResult>, RunFailure>> {
  const now = deps.now();
  const settings = project.settings;
  const prepared = prepareQuery(spec, {
    now,
    projectTimeZone: settings.timezone,
    retentionStart: retentionStart(now, settings.events_retention_days),
    internalRules: settings.internal_rules,
  });
  if (!prepared.ok) return err({ kind: "invalid", issues: prepared.error });

  const store = projectStore(env, project.id);
  let rows: Awaited<ReturnType<typeof store.runQuery>>;
  try {
    rows = await store.runQuery(prepared.value.compiled);
  } catch (cause) {
    deps.log.error("project_store_failed", { message: messageOf(cause) });
    return err({ kind: "unavailable" });
  }
  if (!rows.ok) {
    deps.log.error("project_store_refused", { error: rows.error });
    return err({ kind: "unavailable" });
  }
  return ok(answerQuery(spec, prepared.value, rows.value));
}

async function answerProjectQuery(
  c: AppContext,
  project: ResolvedProject,
  spec: QuerySpec,
): Promise<Response> {
  const answer = await runProjectQuery(c.env, c.get("deps"), project, spec);
  if (answer.ok) return dashboardAnswer(answer.value);
  return answer.error.kind === "invalid"
    ? prepareFailure(answer.error.issues)
    : apiError(503, "unavailable", STORE_UNAVAILABLE);
}

/**
 * A dashboard query for the project in the path:
 * 1. A method other than POST is 405 method_not_allowed (query-19).
 * 2. A Content-Type other than application/json, parameters allowed, is 415
 *    unsupported_media_type (query-19).
 * 3. readJsonBody with QUERY.bodyBytes: too large, with or without
 *    Content-Length, is 413 body_too_large (query-59, query-61); an
 *    unreadable body 400.
 * 4. An empty body or one that is not JSON is 400 validation_failed
 *    (query-19).
 * 5. parseSpec: its issues are 400, with code "unknown_kind" when the first
 *    issue's code is that, else "validation_failed", one sentence naming the
 *    first issue's path, and every issue (query-18, platform-34).
 * 6. getProject (projects): a failure is 503 unavailable, its message logged
 *    only (platform-42); an unknown or deleted project is 404 not_found.
 * 7. prepareQuery with the context {now: deps.now(), projectTimeZone and
 *    internalRules from the project's settings, retentionStart from intake's
 *    retentionStart of now and events_retention_days}. Its issues are 400,
 *    the code the first issue's when it is an ErrorCode, else
 *    validation_failed (query-11, query-14, query-31, query-39, query-49).
 * Steps 1 to 7 contact no ProjectStore (query-11, query-14, query-18,
 * query-59).
 * 8. One RPC call, runQuery, on projectStore(env, id) with the compiled
 *    query: a thrown error or an error value is 503 unavailable with
 *    STORE_UNAVAILABLE (D-22).
 * 9. 200 with answerQuery's Answer as JSON and Cache-Control
 *    "private, no-store", so no shared cache holds a project's data
 *    (query-73).
 */
export async function handleDashboardQuery(c: AppContext): Promise<Response> {
  const spec = await readSpec(c);
  if (!spec.ok) return spec.error;

  const project = await dashboardProject(c);
  if (!project.ok) return project.error;

  return answerProjectQuery(c, project.value, spec.value);
}

/**
 * A project's own query (D-5, query-01, query-06):
 * 1. The Authorization header's Bearer credential (bearerOf) with the shape
 *    of a secret key (isSecretKeyShape), resolved by resolveSecretKey with
 *    caches.default at deps.now(). A missing header, another scheme, an
 *    session cookie, a public token, a revoked key or a deleted project's key is
 *    401 unauthorized, every one with the same body, and nothing is read
 *    (platform-09). A registry failure is 503 unavailable.
 * 2. Then steps 1 to 5 and 7 to 9 of handleDashboardQuery for the key's
 *    project, with the settings resolveSecretKey answered: a key reads its
 *    own project and nothing else, and a spec naming a project is 400 by
 *    parseSpec's unknown key (query-01).
 */
export async function handleExternalQuery(c: AppContext): Promise<Response> {
  const key = bearerOf(c.req.header("authorization") ?? null);
  if (key === null || !isSecretKeyShape(key)) return keyRefused();

  const deps = c.get("deps");
  const project = await resolveSecretKey(c.env.REGISTRY, caches.default, key, deps.now());
  if (!project.ok) {
    deps.log.error("registry_unavailable", { message: project.error.message });
    return apiError(503, "unavailable", REGISTRY_UNAVAILABLE);
  }
  if (project.value === null) return keyRefused();

  const spec = await readSpec(c);
  if (!spec.ok) return spec.error;

  return answerProjectQuery(c, project.value, spec.value);
}
