import { BODY_LIMITS } from "@cfanalytics/shared";
import type { Hono } from "hono";
import { mirroredOrigin, sdkCorsHeaders } from "../../platform/cors.ts";
import {
  type AppContext,
  type AppEnv,
  bodyRefusal,
  readBody,
  sdkError,
} from "../../platform/http.ts";
import { decodeBody, sentLimit } from "../intake/index.ts";
import { sdkProject } from "../projects/index.ts";
import {
  cacheControlFor,
  configScript,
  FLAGS_ANSWER,
  flagsToken,
  remoteConfig,
  scriptOf,
} from "./core.ts";

// The SDK's load-time paths (posthog-protocol.md §0, §6, §11 items 7, 9, 10,
// 16, 17). None of them contacts a ProjectStore or stores anything.
//
//   GET  /array/:token/config      remoteConfig as JSON (config-06)
//   GET  /array/:token/config.js   configScript, as JavaScript (config-20, config-21)
//   POST /flags and /flags/        FLAGS_ANSWER (config-03, config-23, config-24, config-32)
//   GET  /static/*                 a pinned script from the ASSETS binding (config-25 to config-29)
//
// Every answer on these paths, refusals and the preflight included, carries
// sdkCorsHeaders(mirroredOrigin(Origin), Access-Control-Request-Headers,
// preflight), as capture's do (intake-12, config-22). OPTIONS is the
// preflight: 200 with an empty body. A refusal is sdkError (platform/http.ts),
// apiError's JSON with those headers added: 400 validation_failed, 401 unauthorized, 404 not_found, 405
// method_not_allowed, 413 body_too_large, 503 unavailable. A 503's message is
// fixed and its cause goes to the log only (platform-42). A token is resolved
// with resolveToken (projects) against REGISTRY, caches.default and
// deps.now(): a failure is 503, an unknown or blank token 401, and a 401 never
// echoes the token (config-07, config-21). A project at its daily cap gets
// its config and flags as usual, since the cap lives in the ProjectStore and
// neither path reads it (intake-27).

/** The 503 answer's fixed sentence; the cause goes to the log only (platform-42). */
const ASSET_UNAVAILABLE = "The script is unavailable.";

export function mountConfig(app: Hono<AppEnv>): void {
  app.all("/array/:token/config", handleConfig);
  app.all("/array/:token/config.js", handleConfigScript);
  app.all("/flags", handleFlags);
  app.all("/flags/", handleFlags);
  app.all("/static/*", handleStatic);
}

/** The CORS headers of this answer, as every SDK path carries them (intake-12, config-22). */
function corsOf(c: AppContext, preflight: boolean): Record<string, string> {
  return sdkCorsHeaders(
    mirroredOrigin(c.req.header("origin") ?? null),
    c.req.header("access-control-request-headers") ?? null,
    preflight,
  );
}

/**
 * /array/:token/config. OPTIONS: the preflight. GET: the token's project
 * resolved, then 200 with remoteConfig(settings) as JSON and Cache-Control
 * cacheControlFor("config") (config-06, config-12, config-31, intake-08).
 * Any other method is 405, before the token is read (config-30).
 */
export async function handleConfig(c: AppContext): Promise<Response> {
  const preflight = c.req.method === "OPTIONS";
  const cors = corsOf(c, preflight);
  if (preflight) return new Response(null, { status: 200, headers: cors });
  if (c.req.method !== "GET") {
    return sdkError(
      cors,
      405,
      "method_not_allowed",
      "Only GET and OPTIONS are allowed on this path.",
    );
  }

  const project = await sdkProject(c, c.req.param("token") ?? "", c.get("deps").now(), cors);
  if (!project.ok) return project.error;

  return Response.json(remoteConfig(project.value.settings), {
    status: 200,
    headers: { ...cors, "cache-control": cacheControlFor("config") },
  });
}

/**
 * /array/:token/config.js. As handleConfig, but the 200 body is
 * configScript(token, remoteConfig(settings)) with Content-Type
 * "application/javascript; charset=utf-8" (config-20 to config-22, config-31).
 */
export async function handleConfigScript(c: AppContext): Promise<Response> {
  const preflight = c.req.method === "OPTIONS";
  const cors = corsOf(c, preflight);
  if (preflight) return new Response(null, { status: 200, headers: cors });
  if (c.req.method !== "GET") {
    return sdkError(
      cors,
      405,
      "method_not_allowed",
      "Only GET and OPTIONS are allowed on this path.",
    );
  }

  const token = c.req.param("token") ?? "";
  const project = await sdkProject(c, token, c.get("deps").now(), cors);
  if (!project.ok) return project.error;

  return new Response(configScript(token, remoteConfig(project.value.settings)), {
    status: 200,
    headers: {
      ...cors,
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": cacheControlFor("config"),
    },
  });
}

/**
 * /flags and /flags/. OPTIONS: the preflight. Any method but POST and OPTIONS
 * is 405. POST, whatever its query string, which changes nothing, not even
 * `config=true` (config-32):
 * 1. readBody with sentLimit(Content-Type, Content-Encoding,
 *    BODY_LIMITS.eventBytes), then decodeBody with BODY_LIMITS.eventBytes, as
 *    capture decodes: gzip, the base64 form body or plain JSON (config-23).
 *    Too large is 413; unreadable, not JSON included, is 400 (config-07).
 * 2. flagsToken: "not an object" is 400; no token is 401.
 * 3. The token resolved: 503 or 401 as above (config-07).
 * 4. 200 with FLAGS_ANSWER as JSON and Cache-Control "no-store"; nothing is
 *    stored and no ProjectStore is contacted (config-03, config-24).
 */
export async function handleFlags(c: AppContext): Promise<Response> {
  const preflight = c.req.method === "OPTIONS";
  const cors = corsOf(c, preflight);
  if (preflight) return new Response(null, { status: 200, headers: cors });
  if (c.req.method !== "POST") {
    return sdkError(
      cors,
      405,
      "method_not_allowed",
      "Only POST and OPTIONS are allowed on this path.",
    );
  }

  const contentType = c.req.header("content-type") ?? null;
  const contentEncoding = c.req.header("content-encoding") ?? null;
  const limit = BODY_LIMITS.eventBytes;
  const bytes = await readBody(c.req.raw, sentLimit(contentType, contentEncoding, limit));
  if (!bytes.ok) return bodyRefusal(cors, bytes.error.kind === "too_large");

  const decoded = await decodeBody(bytes.value, contentType, contentEncoding, limit);
  if (!decoded.ok) return bodyRefusal(cors, decoded.error.kind === "too large");

  const token = flagsToken(decoded.value.body);
  if (!token.ok) return sdkError(cors, 400, "validation_failed", "The body must be a JSON object.");
  if (token.value === null) {
    return sdkError(cors, 401, "unauthorized", "The request carries no project token.");
  }

  const project = await sdkProject(c, token.value, c.get("deps").now(), cors);
  if (!project.ok) return project.error;

  return Response.json(FLAGS_ANSWER, {
    status: 200,
    headers: { ...cors, "cache-control": "no-store" },
  });
}

/**
 * /static/*. OPTIONS: the preflight. Any method but GET and OPTIONS is 405.
 * GET: scriptOf(the URL's pathname); null is 404 (config-05, config-26).
 * Else the bytes of `/posthog/<kind>.js` read through the ASSETS binding, the
 * same for a versioned and an unversioned path and whatever the project's
 * settings (config-25, config-27, config-28), answered 200 with Content-Type
 * "application/javascript; charset=utf-8" and Cache-Control from
 * cacheControlFor (config-22, config-31). An ASSETS answer other than 200 is
 * a broken deployment: 503, logged. Nothing is fetched from outside the Worker
 * (config-27).
 */
export async function handleStatic(c: AppContext): Promise<Response> {
  const preflight = c.req.method === "OPTIONS";
  const cors = corsOf(c, preflight);
  if (preflight) return new Response(null, { status: 200, headers: cors });
  if (c.req.method !== "GET") {
    return sdkError(
      cors,
      405,
      "method_not_allowed",
      "Only GET and OPTIONS are allowed on this path.",
    );
  }

  const script = scriptOf(c.req.path);
  if (script === null) return sdkError(cors, 404, "not_found", "No such script.");

  const asset = await c.env.ASSETS.fetch(
    new Request(new URL(`/posthog/${script.kind}.js`, c.req.url)),
  );
  if (asset.status !== 200) {
    c.get("deps").log.error("asset_unavailable", { kind: script.kind, status: asset.status });
    return sdkError(cors, 503, "unavailable", ASSET_UNAVAILABLE);
  }

  return new Response(asset.body, {
    status: 200,
    headers: {
      ...cors,
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": cacheControlFor(
        script.versioned ? "versioned script" : "unversioned script",
      ),
    },
  });
}
