// Failure is a value (docs/engineering.md). Pure files return a Result and
// never throw; http.ts turns a failed Result into a status and one sentence.

export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** The text of a caught value, for an error value or a log line. */
export const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
