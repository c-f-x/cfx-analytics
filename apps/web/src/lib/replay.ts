import type { eventWithTime } from "rrweb";

// A recording's events as the chunks route sends them: one rrweb event per
// NDJSON line, in play order (recordings-01). Pure.

/** rrweb's own event type. The player checks each event's data as it plays it. */
export type ReplayEvent = eventWithTime;

/** A line is taken as an rrweb event when it has rrweb's number type and timestamp. */
const isEvent = (value: unknown): value is ReplayEvent =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  "timestamp" in value &&
  typeof value.type === "number" &&
  typeof value.timestamp === "number";

/** The NDJSON text's events; a line that is not an rrweb event is skipped. */
export function eventsOf(ndjson: string): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  for (const line of ndjson.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isEvent(parsed)) events.push(parsed);
    } catch {
      // A torn line plays as nothing rather than stopping the rest.
    }
  }
  return events;
}

/** rrweb's event types the dashboard reads: a page's size and URL (Meta) and its whole DOM (FullSnapshot). */
export const META = 4;
export const FULL_SNAPSHOT = 2;

/**
 * The events that rebuild the newest full snapshot: the Meta event before it
 * and the snapshot itself. null when the recording holds no full snapshot.
 */
export function newestSnapshot<E extends { type: number }>(events: readonly E[]): E[] | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== FULL_SNAPSHOT) continue;
    for (let back = index - 1; back >= 0; back -= 1) {
      const meta = events[back];
      if (meta?.type === META) return [meta, event];
    }
    return [event];
  }
  return null;
}
