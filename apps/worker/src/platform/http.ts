import type { ApiError, ApiIssue, ErrorCode } from "@cfanalytics/shared";
import type { Context } from "hono";
import type { Deps } from "./deps.ts";
import type { Env } from "./env.ts";
import { err, ok, type Result } from "./result.ts";

// What every slice's http.ts shares: the Hono environment, the JSON answers
// and error answers of the dashboard and SDK paths, and reading a bounded body.

/** Who called a dashboard path, once Access has been verified (platform-01). */
export interface DashboardCaller {
  email: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    deps: Deps;
    caller: DashboardCaller;
  };
};

export type AppContext = Context<AppEnv>;

/** The JSON error answer: a stable code, one sentence, and issues when the body was bad (platform-34). */
export function apiError(
  status: number,
  code: ErrorCode,
  message: string,
  issues?: ApiIssue[],
): Response {
  const body: ApiError = issues === undefined ? { code, message } : { code, message, issues };
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * apiError's JSON with an SDK path's CORS headers added: every answer on
 * capture, /s/, remote config, /flags and the scripts carries them, refusals
 * included (intake-12, config-22, D-20).
 */
export function sdkError(
  cors: Readonly<Record<string, string>>,
  status: number,
  code: ErrorCode,
  message: string,
): Response {
  const answer = apiError(status, code, message);
  for (const [name, value] of Object.entries(cors)) answer.headers.set(name, value);
  return answer;
}

/** The message of a 503 when the D1 registry fails. */
export const REGISTRY_UNAVAILABLE = "The registry is unavailable.";

/** The message of a 503 when a ProjectStore call fails. */
export const STORE_UNAVAILABLE = "The project store is unavailable.";

/** A dashboard answer: JSON, private and never cached, so no shared cache holds a project's data (query-73). */
export function dashboardAnswer(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

/** An SDK path's accepted answer: 200 JSON with its CORS headers, never cached. */
export function sdkAnswer(cors: Readonly<Record<string, string>>, body: unknown): Response {
  return Response.json(body, { status: 200, headers: { ...cors, "cache-control": "no-store" } });
}

/**
 * A body an SDK path refused: 413 when it is too large, else 400
 * (intake-05, intake-24 to intake-26, config-07, config-23).
 */
export function bodyRefusal(cors: Readonly<Record<string, string>>, tooLarge: boolean): Response {
  return tooLarge
    ? sdkError(cors, 413, "body_too_large", "The body is larger than this path accepts.")
    : sdkError(cors, 400, "validation_failed", "The body could not be read.");
}

export type BodyError = { kind: "too_large" } | { kind: "unreadable" };

/**
 * The request body as bytes, read at most `limit` bytes plus one. A declared
 * Content-Length over `limit` is refused before reading (intake-25, query-61);
 * a stream that passes `limit` is refused as soon as it does.
 */
export async function readBody(
  request: Request,
  limit: number,
): Promise<Result<Uint8Array, BodyError>> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    // Only a length that is a number says anything about the body; anything else is read.
    if (Number.isFinite(length) && length > limit) return err({ kind: "too_large" });
  }
  const body = request.body;
  if (body === null) return ok(new Uint8Array(0));
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      return err({ kind: "unreadable" });
    }
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > limit) {
      // The refusal comes at the first byte over the limit, so a body far over
      // it is never copied whole.
      try {
        await reader.cancel();
      } catch {
        // The stream is already gone, which changes nothing here.
      }
      return err({ kind: "too_large" });
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return ok(bytes);
}

/**
 * A dashboard request's body as JSON, read with readBody at most `limit`
 * bytes: larger is 413 body_too_large, before the body is read in full
 * (query-59, query-61, projects-39); unreadable, or not JSON, is 400
 * validation_failed. An empty body is not JSON, unless `empty` is "null",
 * when it reads as null for a route whose body is optional.
 */
export async function readJsonBody(
  request: Request,
  limit: number,
  empty: "invalid" | "null" = "invalid",
): Promise<Result<unknown, Response>> {
  const body = await readBody(request, limit);
  if (!body.ok) {
    return err(
      body.error.kind === "too_large"
        ? apiError(413, "body_too_large", "The body is larger than this path accepts.")
        : apiError(400, "validation_failed", "The body could not be read."),
    );
  }
  const text = new TextDecoder().decode(body.value);
  if (empty === "null" && text.trim() === "") return ok(null);
  try {
    const parsed: unknown = JSON.parse(text);
    return ok(parsed);
  } catch {
    return err(apiError(400, "validation_failed", "The body is not valid JSON."));
  }
}
