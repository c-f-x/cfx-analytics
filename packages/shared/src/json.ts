// JSON values, typed. Everything that crosses Durable Object RPC is one of
// these: workers-types' Rpc.Serializable refuses `unknown`, so a
// Record<string, unknown> would type as never at the stub (spike S2, finding 6).

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** Whether a value is a JSON object (not an array, not null). */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A client's number rounded to a whole number a SQLite INTEGER column can
 * hold, or null when it is not finite or rounds past 2^53. A value like 1e20
 * is finite yet no STRICT INTEGER column takes it, and one such value would
 * fail its whole batch (heatmaps-22, recordings-33, intake-34).
 */
export function wholeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return Number.isSafeInteger(rounded) ? rounded : null;
}
