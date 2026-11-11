import { err, messageOf, ok, type Result } from "../../platform/result.ts";
import { nextSession, startsSession } from "./core.ts";

// The `salts` and `cookieless_sessions` tables. Synchronous: called inside the
// ProjectStore's write transaction. Every statement binds its parameters.

/** The day's salt could be neither read nor made; the batch fails with 503, never a made-up id (cookieless-17). */
export type SaltError = { kind: "salt unavailable"; message: string };

const SALT_BYTES = 16;

/**
 * The salt of `day`. With none stored, makes one from `makeSalt()` with
 * `expiresAt`, and in the same transaction deletes the salts expired at
 * `now` (expires_at at or before it) with their sessions, so at most three
 * exist (cookieless-04, cookieless-11). A SQL error, or a made salt that is
 * not 16 bytes, is a SaltError; the caller then rolls its transaction back,
 * so nothing is written (cookieless-17).
 */
export function saltForDay(
  sql: SqlStorage,
  day: string,
  expiresAt: number,
  now: number,
  makeSalt: () => Uint8Array,
): Result<Uint8Array, SaltError> {
  try {
    const stored = sql
      .exec<{ salt: ArrayBuffer }>("SELECT salt FROM salts WHERE day = ?", day)
      .toArray()[0];
    if (stored !== undefined) return ok(new Uint8Array(stored.salt));

    const made = makeSalt();
    if (made.length !== SALT_BYTES) {
      return err({
        kind: "salt unavailable",
        message: `made salt for ${day} is ${made.length} bytes, not ${SALT_BYTES}`,
      });
    }

    pruneSalts(sql, now);
    sql.exec(
      "INSERT INTO salts (day, salt, expires_at) VALUES (?, ?, ?)",
      day,
      made.slice().buffer,
      expiresAt,
    );
    return ok(made);
  } catch (error) {
    return err({ kind: "salt unavailable", message: messageOf(error) });
  }
}

/**
 * The session id of a cookieless event at `ts` for `hash`, made on `day`'s
 * salt: nextSession over the stored state, whose new state is written back
 * (cookieless-06, cookieless-18). `newSessionId` is called only when the
 * event starts a session, so a batch spends one id per session made.
 */
export function sessionFor(
  sql: SqlStorage,
  hash: string,
  day: string,
  ts: number,
  newSessionId: () => string,
): string {
  const stored = sql
    .exec<{ session_id: string; last_ts: number }>(
      "SELECT session_id, last_ts FROM cookieless_sessions WHERE hash = ?",
      hash,
    )
    .toArray()[0];
  const current =
    stored === undefined ? null : { sessionId: stored.session_id, lastTs: stored.last_ts };
  const sessionId =
    current !== null && !startsSession(current, ts) ? current.sessionId : newSessionId();
  const next = nextSession(current, ts, sessionId);

  sql.exec(
    "INSERT INTO cookieless_sessions (hash, day, session_id, last_ts) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT (hash) DO UPDATE SET day = excluded.day, session_id = excluded.session_id, last_ts = excluded.last_ts",
    hash,
    day,
    next.state.sessionId,
    next.state.lastTs,
  );
  return next.sessionId;
}

/**
 * Deletes the salts expired at `now` (expires_at at or before it) and their
 * sessions; answers how many of each. The daily alarm calls it from wave 4
 * (cookieless-04).
 */
export function pruneSalts(sql: SqlStorage, now: number): { salts: number; sessions: number } {
  const sessions = sql
    .exec(
      "DELETE FROM cookieless_sessions WHERE day IN (SELECT day FROM salts WHERE expires_at <= ?) RETURNING hash",
      now,
    )
    .toArray().length;
  const salts = sql
    .exec("DELETE FROM salts WHERE expires_at <= ? RETURNING day", now)
    .toArray().length;
  return { salts, sessions };
}
