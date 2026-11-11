import { CLIP, type Json, type JsonObject } from "@cfanalytics/shared";

// Clipping (intake-04): over-long values are cut and stored, never refused.
// Limits are CLIP in packages/shared.

/** Property keys whose string values are URLs, clipped to CLIP.url instead of CLIP.stringValue. */
export const URL_PROPERTIES: readonly string[] = [
  "$current_url",
  "$referrer",
  "$initial_current_url",
  "$initial_referrer",
];

const encoder = new TextEncoder();

/**
 * `text` cut to at most `bytes` UTF-8 bytes on a character boundary, so the
 * result is valid UTF-8 and never splits a surrogate pair; text that fits is
 * returned unchanged. Pure.
 */
export function clipText(text: string, bytes: number): string {
  if (encoder.encode(text).byteLength <= bytes) return text;
  let clipped = "";
  let used = 0;
  // for...of walks code points, so a surrogate pair is cut or kept whole.
  for (const character of text) {
    used += encoder.encode(character).byteLength;
    if (used > bytes) break;
    clipped += character;
  }
  return clipped;
}

/**
 * Properties clipped inside the object, never in its JSON text, so the JSON
 * stays readable and other values stay intact (intake-04):
 * - at most CLIP.propertiesPerEvent top-level keys, the first ones kept;
 * - every key at any depth clipped to CLIP.propertyName bytes; when two keys
 *   clip to the same text, the first one is kept;
 * - every string value at any depth clipped to CLIP.stringValue bytes, and
 *   the top-level values of URL_PROPERTIES to CLIP.url bytes;
 * - an object or array nested deeper than CLIP.depth levels (the properties
 *   object itself is level 1) replaced by null.
 * Numbers, booleans and null are kept as they are (events-15). Pure.
 */
export function clipProperties(properties: Readonly<JsonObject>): JsonObject {
  return clipObject(properties, 1);
}

/** One object at `level`, with its keys clipped and its values handed on. */
function clipObject(object: Readonly<JsonObject>, level: number): JsonObject {
  const clipped: JsonObject = {};
  // A running count, so clipping stays linear in the number of keys.
  let kept = 0;
  for (const [key, value] of Object.entries(object)) {
    if (level === 1 && kept >= CLIP.propertiesPerEvent) break;
    const name = clipText(key, CLIP.propertyName);
    if (Object.hasOwn(clipped, name)) continue;
    const stringLimit = level === 1 && URL_PROPERTIES.includes(name) ? CLIP.url : CLIP.stringValue;
    clipped[name] = clipValue(value, level + 1, stringLimit);
    kept += 1;
  }
  return clipped;
}

/** One value at `level`, with `stringLimit` bytes allowed to a string. */
function clipValue(value: Json, level: number, stringLimit: number): Json {
  if (typeof value === "string") return clipText(value, stringLimit);
  if (value === null || typeof value !== "object") return value;
  if (level > CLIP.depth) return null;
  if (Array.isArray(value)) {
    return value.map((item) => clipValue(item, level + 1, CLIP.stringValue));
  }
  return clipObject(value, level);
}
