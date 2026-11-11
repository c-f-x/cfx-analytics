// The time zones Settings offers. Pure.

/**
 * The browser's zones plus UTC, which browsers leave out of their list, and
 * the product's own zone, so the select always shows what is saved. Sorted,
 * each once.
 */
export function timeZoneOptions(current: string, browserZones: readonly string[]): string[] {
  return [...new Set([...browserZones, "UTC", current])].toSorted();
}
