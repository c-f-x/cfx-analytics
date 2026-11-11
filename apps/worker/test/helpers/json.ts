import { isJsonObject, type JsonObject } from "@cfanalytics/shared";

/** A value that must be a JSON object, such as an answer's body or a log line; the test fails loudly otherwise. */
export function asRecord(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new Error("expected a JSON object");
  return value;
}
