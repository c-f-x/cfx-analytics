// The one shape of an error answer from the dashboard and external APIs
// (platform-34, query-18). Capture paths answer PostHog's own shapes instead.

export interface ApiIssue {
  /** A JSON pointer to the bad field, such as "/range/from". */
  path: string;
  code: string;
  message: string;
}

export interface ApiError {
  /** A stable code a client can branch on, such as "validation_failed". */
  code: string;
  /** One plain sentence naming what was wrong. */
  message: string;
  issues?: ApiIssue[];
}

export const ERROR_CODES = [
  "validation_failed",
  "unknown_kind",
  "invalid_cursor",
  "too_many_buckets",
  "too_many_parameters",
  "body_too_large",
  "unsupported_media_type",
  "method_not_allowed",
  "not_found",
  "unauthorized",
  "forbidden_origin",
  "does_not_fit",
  "unavailable",
  /** A recording chunk's row exists and its R2 object does not (recordings-16). */
  "chunk_missing",
  /** A purge asked for a project that is not marked deleted. */
  "not_deleted",
  /** An R2 delete failed, so a deletion by person deleted no row (privacy-19). */
  "delete_failed",
  /** A Cloudflare account other than the admin's tried to sign in (platform-47). */
  "forbidden",
  /** An import row names a person or recording not imported yet (privacy-30). */
  "out_of_order",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** A path as a JSON pointer (RFC 6901), "~" escaped before "/", such as "/range/from" (platform-34). */
export function jsonPointer(path: readonly PropertyKey[]): string {
  return path
    .map((segment) => `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`)
    .join("");
}
