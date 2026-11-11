import { calendarDay, isTimeZone } from "@cfanalytics/shared";

// Cookieless counting (D-20; cookieless-01 to cookieless-18; posthog-protocol.md §5).
// The hash is SipHash-2-4 keyed by the day's 16-byte salt, as PostHog's own
// server does, written here in plain TypeScript so it runs inside the
// ProjectStore's synchronous transaction. Pure.

const MASK_64 = (1n << 64n) - 1n;
const SESSION_GAP_MS = 30 * 60 * 1000;

/** Eight bytes at `offset` as a little-endian unsigned 64-bit integer. Bytes past the end read as zero. */
function readWord(bytes: Uint8Array, offset: number): bigint {
  let word = 0n;
  for (let index = 0; index < 8; index += 1) {
    const byte = bytes[offset + index] ?? 0;
    word |= BigInt(byte) << BigInt(8 * index);
  }
  return word;
}

function rotateLeft(value: bigint, bits: bigint): bigint {
  return ((value << bits) | (value >> (64n - bits))) & MASK_64;
}

/** The two rounds SipHash-2-4 runs on every message word, and four on the last one. */
function sipRound(state: [bigint, bigint, bigint, bigint]): [bigint, bigint, bigint, bigint] {
  let [v0, v1, v2, v3] = state;
  v0 = (v0 + v1) & MASK_64;
  v1 = rotateLeft(v1, 13n) ^ v0;
  v0 = rotateLeft(v0, 32n);
  v2 = (v2 + v3) & MASK_64;
  v3 = rotateLeft(v3, 16n) ^ v2;
  v0 = (v0 + v3) & MASK_64;
  v3 = rotateLeft(v3, 21n) ^ v0;
  v2 = (v2 + v1) & MASK_64;
  v1 = rotateLeft(v1, 17n) ^ v2;
  v2 = rotateLeft(v2, 32n);
  return [v0, v1, v2, v3];
}

/**
 * SipHash-2-4 of `message` under a 16-byte `key`: the 8 output bytes read as
 * a little-endian unsigned 64-bit integer, as the reference implementation's
 * test vectors print it (key 00..0f, message 00..0e gives 0xa129ca6149be45e5).
 */
export function siphash24(key: Uint8Array, message: Uint8Array): bigint {
  const k0 = readWord(key, 0);
  const k1 = readWord(key, 8);

  let v0 = k0 ^ 0x736f6d6570736575n;
  let v1 = k1 ^ 0x646f72616e646f6dn;
  let v2 = k0 ^ 0x6c7967656e657261n;
  let v3 = k1 ^ 0x7465646279746573n;

  const fullBlocks = Math.floor(message.length / 8);
  for (let block = 0; block < fullBlocks; block += 1) {
    const word = readWord(message, block * 8);
    v3 ^= word;
    [v0, v1, v2, v3] = sipRound([v0, v1, v2, v3]);
    [v0, v1, v2, v3] = sipRound([v0, v1, v2, v3]);
    v0 ^= word;
  }

  // The last block holds the remaining bytes, then the message length in its top byte.
  const finalWord = readWord(message, fullBlocks * 8) | (BigInt(message.length & 0xff) << 56n);
  v3 ^= finalWord;
  [v0, v1, v2, v3] = sipRound([v0, v1, v2, v3]);
  [v0, v1, v2, v3] = sipRound([v0, v1, v2, v3]);
  v0 ^= finalWord;

  v2 ^= 0xffn;
  [v0, v1, v2, v3] = sipRound([v0, v1, v2, v3]);
  [v0, v1, v2, v3] = sipRound([v0, v1, v2, v3]);
  [v0, v1, v2, v3] = sipRound([v0, v1, v2, v3]);
  [v0, v1, v2, v3] = sipRound([v0, v1, v2, v3]);

  return v0 ^ v1 ^ v2 ^ v3;
}

/**
 * The stored distinct id: "cookieless_" and siphash24 under `salt` in 16
 * lower-case hex digits, zero-padded, of the UTF-8 bytes of the project id,
 * the client IP, the exact host and the user agent joined by "\u0000"
 * (cookieless-01, cookieless-02). No public suffix list. The IP is an input
 * only and is never part of the result.
 */
export function cookielessId(input: {
  salt: Uint8Array;
  projectId: string;
  ip: string;
  host: string;
  userAgent: string;
}): string {
  const message = new TextEncoder().encode(
    [input.projectId, input.ip, input.host, input.userAgent].join("\u0000"),
  );
  const hash = siphash24(input.salt, message);
  return `cookieless_${hash.toString(16).padStart(16, "0")}`;
}

/**
 * The calendar day of `ts` as YYYY-MM-DD in `timezone` when it is a valid
 * IANA name, else in `projectTimezone` (cookieless-09).
 */
export function saltDay(ts: number, timezone: string | null, projectTimezone: string): string {
  const zone = timezone !== null && isTimeZone(timezone) ? timezone : projectTimezone;
  return calendarDay(ts, zone);
}

/** When a day's salt expires, in ms: (day + 1) 12:00 UTC, when the day has ended at UTC-12 (cookieless-04, D-20). */
export function saltExpiry(day: string): number {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  return Date.UTC(year, month - 1, date + 1, 12, 0, 0, 0);
}

/**
 * The day whose salt hashes an event: saltDay of its own time, unless that
 * day's salt has expired at `receivedAt` (saltExpiry at or before it), when
 * it is saltDay of receivedAt, today's (cookieless-09, cookieless-10).
 */
export function hashDay(
  ts: number,
  receivedAt: number,
  timezone: string | null,
  projectTimezone: string,
): string {
  const own = saltDay(ts, timezone, projectTimezone);
  return saltExpiry(own) <= receivedAt ? saltDay(receivedAt, timezone, projectTimezone) : own;
}

export interface SessionState {
  sessionId: string;
  /** The latest event time the session has seen. */
  lastTs: number;
}

/** Whether an event at `ts` starts a session of its own: there is no state, or it is more than SESSION_GAP_MS from the session's last event (cookieless-06, cookieless-18). */
export function startsSession(current: SessionState | null, ts: number): boolean {
  return current === null || Math.abs(ts - current.lastTs) > SESSION_GAP_MS;
}

/**
 * The session of a cookieless event at `ts`, and the state to keep after it
 * (cookieless-06, cookieless-18). The window is SESSION_GAP_MS: exactly 30
 * minutes apart still joins, one millisecond more does not.
 * - No current state: a new session `newSessionId`, state {newSessionId, ts}.
 * - ts within the window of lastTs, before or after it: the current session;
 *   the state's lastTs becomes the later of the two, so it never moves back.
 * - ts after the window: a new session `newSessionId`, state {newSessionId, ts}.
 * - ts before the window: a session `newSessionId` for this event only; the
 *   state stays as it was.
 */
export function nextSession(
  current: SessionState | null,
  ts: number,
  newSessionId: string,
): { sessionId: string; state: SessionState } {
  if (current === null) {
    return { sessionId: newSessionId, state: { sessionId: newSessionId, lastTs: ts } };
  }
  if (!startsSession(current, ts)) {
    return {
      sessionId: current.sessionId,
      state: { sessionId: current.sessionId, lastTs: Math.max(current.lastTs, ts) },
    };
  }
  if (ts < current.lastTs) return { sessionId: newSessionId, state: current };
  return { sessionId: newSessionId, state: { sessionId: newSessionId, lastTs: ts } };
}
