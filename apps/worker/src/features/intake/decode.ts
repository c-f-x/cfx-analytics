import { err, ok, type Result } from "../../platform/result.ts";

// Body decoding for every SDK path: capture now, /s/ and /flags in wave 3
// (intake-10, intake-11, intake-23 to intake-26; posthog-protocol.md §2.2,
// §11). Spike S2 proved this shape against the real SDKs. Never throws.

export type Encoding = "gzip-magic" | "gzip-header" | "base64-form" | "json";

export type DecodeError =
  | { kind: "too large" }
  | { kind: "unreadable"; step: "empty" | "gzip" | "form" | "base64" | "utf8" | "json" };

type Decoded = { encoding: Encoding; body: unknown };

/**
 * The most bytes a body may have as sent and still decode within
 * `decodedLimit`, so readBody can refuse a larger one before reading it
 * (intake-25). The media type is read without case and without parameters.
 * - application/json with no Content-Encoding: `decodedLimit` itself.
 * - application/x-www-form-urlencoded: base64's 4/3 of decodedLimit with a
 *   quarter's room for percent-encoding, + 1024. posthog-js percent-encodes
 *   only +, / and = of its base64, about 3% of it, so a body an SDK sends
 *   always fits, and a body far larger is refused before it is copied
 *   (intake-25).
 * - Anything else may be gzip, which can grow incompressible data slightly:
 *   decodedLimit + ceil(decodedLimit / 1000) + 1024.
 * Pure.
 */
export function sentLimit(
  contentType: string | null,
  contentEncoding: string | null,
  decodedLimit: number,
): number {
  const type = headerValue(contentType);
  if (type === "application/json" && headerValue(contentEncoding) === "") return decodedLimit;
  if (type === "application/x-www-form-urlencoded") {
    return Math.ceil((decodedLimit * 4 * 5) / (3 * 4)) + 1024;
  }
  return decodedLimit + Math.ceil(decodedLimit / 1000) + 1024;
}

/**
 * Decodes one body to JSON, refusing as "too large" a decoded size over
 * `decodedLimit` as soon as it passes it; exactly `decodedLimit` bytes pass
 * (intake-25, intake-26). Content-Type and Content-Encoding are read without
 * case and without parameters.
 * - No bytes at all: unreadable at "empty".
 * - Bytes starting 1f 8b are gzip whatever the headers say: "gzip-magic", or
 *   "gzip-header" when Content-Encoding says gzip (intake-10). Content-Encoding
 *   gzip on other bytes is unreadable at "gzip".
 * - application/x-www-form-urlencoded: the `data` field, percent-decoded,
 *   then standard or URL-safe base64 with or without padding, then gunzipped
 *   when it starts 1f 8b: "base64-form" (intake-11). No `data` field is
 *   unreadable at "form", bad base64 at "base64".
 * - Anything else is UTF-8 JSON: "json" (intake-23).
 * The decoded bytes must be UTF-8 ("utf8") holding one JSON value ("json").
 * Gunzips with DecompressionStream, chunk by chunk, to stop at the limit.
 */
export async function decodeBody(
  bytes: Uint8Array,
  contentType: string | null,
  contentEncoding: string | null,
  decodedLimit: number,
): Promise<Result<Decoded, DecodeError>> {
  if (bytes.byteLength === 0) return err({ kind: "unreadable", step: "empty" });
  const type = headerValue(contentType);
  const gzipHeader = headerValue(contentEncoding) === "gzip";

  let payload: Uint8Array;
  let encoding: Encoding;
  if (isGzip(bytes)) {
    const unzipped = await gunzip(bytes, decodedLimit);
    if (!unzipped.ok) return unzipped;
    payload = unzipped.value;
    encoding = gzipHeader ? "gzip-header" : "gzip-magic";
  } else if (gzipHeader) {
    return err({ kind: "unreadable", step: "gzip" });
  } else if (type === "application/x-www-form-urlencoded") {
    const form = await decodeForm(bytes, decodedLimit);
    if (!form.ok) return form;
    payload = form.value;
    encoding = "base64-form";
  } else {
    if (bytes.byteLength > decodedLimit) return err({ kind: "too large" });
    payload = bytes;
    encoding = "json";
  }

  return parseJson(payload, encoding);
}

/** A header read without case and without its parameters. */
function headerValue(value: string | null): string {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** The gzip magic bytes, which a browser sends with no Content-Encoding (intake-10). */
function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** UTF-8 bytes holding one JSON value, or the step that failed. */
function parseJson(payload: Uint8Array, encoding: Encoding): Result<Decoded, DecodeError> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(payload);
  } catch {
    return err({ kind: "unreadable", step: "utf8" });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return err({ kind: "unreadable", step: "json" });
  }
  return ok({ encoding, body });
}

/** A base64 form body's `data`, decoded and gunzipped when it holds gzip (intake-11). */
async function decodeForm(
  bytes: Uint8Array,
  decodedLimit: number,
): Promise<Result<Uint8Array, DecodeError>> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return err({ kind: "unreadable", step: "form" });
  }
  const data = new URLSearchParams(text).get("data");
  if (data === null) return err({ kind: "unreadable", step: "form" });
  const decoded = fromBase64(data);
  if (!decoded.ok) return decoded;
  if (isGzip(decoded.value)) return gunzip(decoded.value, decodedLimit);
  if (decoded.value.byteLength > decodedLimit) return err({ kind: "too large" });
  return decoded;
}

/** Standard or URL-safe base64, with or without padding, as bytes. */
function fromBase64(text: string): Result<Uint8Array, DecodeError> {
  const standard = text.replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(standard) || standard.length % 4 === 1) {
    return err({ kind: "unreadable", step: "base64" });
  }
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return ok(bytes);
  } catch {
    return err({ kind: "unreadable", step: "base64" });
  }
}

/** Gzip bytes as their payload, stopping as soon as it passes `decodedLimit` (intake-25). */
async function gunzip(
  bytes: Uint8Array,
  decodedLimit: number,
): Promise<Result<Uint8Array, DecodeError>> {
  const body = new Response(bytes).body;
  if (body === null) return err({ kind: "unreadable", step: "gzip" });
  const reader = body.pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > decodedLimit) {
        await reader.cancel();
        return err({ kind: "too large" });
      }
      chunks.push(value);
    }
  } catch {
    return err({ kind: "unreadable", step: "gzip" });
  }
  const unzipped = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    unzipped.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return ok(unzipped);
}
