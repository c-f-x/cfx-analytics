// The value of a your-own-traffic rule, read as the type the owner picks for it.
// Rules match exactly as written (D-20), so 42 and "42" are different values.
// Pure.

export const RULE_VALUE_TYPES = ["yes/no", "text", "number"] as const;
export type RuleValueType = (typeof RULE_VALUE_TYPES)[number];

/** `text` as a value of `type`, or null when it is not one. */
export function ruleValueOf(type: RuleValueType, text: string): string | number | boolean | null {
  if (type === "yes/no") return text === "true" ? true : text === "false" ? false : null;
  if (type === "number") {
    const trimmed = text.trim();
    const value = Number(trimmed);
    return trimmed !== "" && Number.isFinite(value) ? value : null;
  }
  return text === "" ? null : text;
}
