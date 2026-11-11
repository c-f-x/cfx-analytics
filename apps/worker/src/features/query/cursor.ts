import { base64urlToBytes, bytesToBase64url, isJsonObject } from "@cfanalytics/shared";
import { err, ok, type Result } from "../../platform/result.ts";

// Keyset cursors for top lists and the event list (query-48, query-49,
// query-70). A cursor is base64url text of JSON holding the last row's sort
// key and the fingerprint of the spec it belongs to. It carries no
// signature: a forged one only moves inside data the caller may read. Pure.

/** The sort key of a page's last row: a top list's (count, key), or the event list's (ts, id). */
export type CursorKey =
  | { kind: "top"; count: number; key: string | number | boolean | null }
  | { kind: "events"; ts: number; id: number };

const BASE64URL = /^[A-Za-z0-9_-]*$/;

const isScalarKey = (value: unknown): value is string | number | boolean | null =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

/** The key `value` names, or undefined when it is not a CursorKey's shape. */
function keyOf(value: unknown): CursorKey | undefined {
  if (!isJsonObject(value)) return undefined;
  const fields = value;
  if (fields.kind === "top") {
    return typeof fields.count === "number" &&
      Number.isFinite(fields.count) &&
      isScalarKey(fields.key)
      ? { kind: "top", count: fields.count, key: fields.key }
      : undefined;
  }
  if (fields.kind === "events") {
    return typeof fields.ts === "number" &&
      Number.isFinite(fields.ts) &&
      typeof fields.id === "number" &&
      Number.isFinite(fields.id)
      ? { kind: "events", ts: fields.ts, id: fields.id }
      : undefined;
  }
  return undefined;
}

/** The cursor's payload, or undefined when it is not base64url JSON holding a key and a fingerprint. */
function payloadOf(cursor: string): { print: string; key: CursorKey } | undefined {
  if (!BASE64URL.test(cursor)) return undefined;
  try {
    const bytes = base64urlToBytes(cursor);
    if (bytes === null) return undefined;
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    if (!isJsonObject(parsed)) return undefined;
    const fields = parsed;
    const key = keyOf(fields.key);
    if (typeof fields.print !== "string" || key === undefined) return undefined;
    return { print: fields.print, key };
  } catch {
    return undefined;
  }
}

/** The cursor of the page after `key`, for the spec of `specFingerprint`. */
export function encodeCursor(key: CursorKey, specFingerprint: string): string {
  const payload = JSON.stringify({ print: specFingerprint, key });
  return bytesToBase64url(new TextEncoder().encode(payload));
}

/**
 * The key of a cursor encodeCursor made for this spec. A cursor that is not
 * base64url, not JSON, not a CursorKey's shape, or made for another
 * fingerprint is "invalid cursor" (query-49).
 */
export function decodeCursor(
  cursor: string,
  specFingerprint: string,
): Result<CursorKey, "invalid cursor"> {
  const payload = payloadOf(cursor);
  if (payload === undefined || payload.print !== specFingerprint) return err("invalid cursor");
  return ok(payload.key);
}

/** JSON with every object's keys sorted, so equal values give equal text whatever their key order. */
function canonical(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (isJsonObject(value)) {
    const fields = Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .toSorted(([left], [right]) => (left < right ? -1 : 1));
    return `{${fields
      .map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`)
      .join(",")}}`;
  }
  return "null";
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT64 = 0xffffffffffffffffn;

/** FNV-1a over the text's UTF-8 bytes, as 16 hex digits. */
function hash(text: string): string {
  let value = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    value = ((value ^ BigInt(byte)) * FNV_PRIME) & UINT64;
  }
  return value.toString(16).padStart(16, "0");
}

/**
 * A stable fingerprint of a spec without its `cursor`: the same for the same
 * fields whatever their key order, different when any other field differs,
 * the limit included. A short text, such as a hex hash of canonical JSON.
 */
export function fingerprint(spec: Readonly<Record<string, unknown>>): string {
  const fields = Object.fromEntries(Object.entries(spec).filter(([key]) => key !== "cursor"));
  return hash(canonical(fields));
}
