// Structured logs, one JSON line each. Nothing logged ever holds an
// Authorization header, a cookie, a secret key, an IP address or a distinct id
// sent for deletion (platform-32, privacy-18, privacy-26).

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/** Field names that hold a credential or an address, compared lower-cased (platform-32). */
const PRIVATE_FIELDS: readonly string[] = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-forwarded-for",
  "cf-connecting-ip",
  "x-real-ip",
  "ip",
  "$ip",
];

/** A secret key inside any string, in the shape projects/handleCreateKey issues (platform-32). */
const SECRET_KEY = /cfa_sk_[A-Za-z0-9_-]+/g;

const REDACTED = "[redacted]";
const UNSERIALISABLE = "[unserialisable]";

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * `value` with its private fields and secret keys replaced, at any depth.
 * Throws when the value holds a cycle, which makes the whole field unserialisable.
 */
function redact(value: unknown, seen: Set<object>): unknown {
  if (typeof value === "string") return value.replace(SECRET_KEY, `cfa_sk_${REDACTED}`);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) throw new Error("circular value");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => redact(item, seen));
    // Other objects, such as a Date, keep their own JSON form.
    if (!isPlainObject(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = PRIVATE_FIELDS.includes(key.toLowerCase()) ? REDACTED : redact(item, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** One field as it will be written, or the marker for a field that cannot be.
 * A field is judged on its own, so one bad value never costs the rest of the line. */
function safeField(value: unknown): unknown {
  try {
    const cleaned = redact(value, new Set());
    // A value whose own toJSON throws is as unusable as a circular one.
    JSON.stringify(cleaned);
    return cleaned;
  } catch {
    return UNSERIALISABLE;
  }
}

/**
 * A logger that writes one JSON line per call to `sink`: {level, event, ...fields}.
 * Before writing, it redacts, at any depth:
 * - fields named authorization, cookie, set-cookie, x-forwarded-for,
 *   cf-connecting-ip, x-real-ip, ip, $ip (case-insensitive): replaced by "[redacted]"
 * - any string value holding a secret key (`cfa_sk_` followed by base64url
 *   characters): the key part replaced by "cfa_sk_[redacted]"
 * It never throws: a field that cannot be serialised is written as "[unserialisable]".
 */
export function createLogger(sink: (line: string) => void): Logger {
  const write = (
    level: "info" | "error",
    event: string,
    fields?: Record<string, unknown>,
  ): void => {
    const line: Record<string, unknown> = { level, event };
    if (fields !== undefined) {
      for (const key of Object.keys(fields)) {
        let value: unknown;
        try {
          value = fields[key];
        } catch {
          // A getter that throws is one unreadable field, not a lost line.
          value = UNSERIALISABLE;
        }
        line[key] = PRIVATE_FIELDS.includes(key.toLowerCase()) ? REDACTED : safeField(value);
      }
    }
    sink(JSON.stringify(line));
  };
  return {
    info: (event, fields) => write("info", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
