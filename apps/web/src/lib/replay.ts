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

// ── What an event says, in plain words (#22) ────────────────────────────────

/** One element of posthog-js's `$elements_chain`, innermost first (config-09). */
export interface ChainElement {
  tag: string;
  text: string | null;
  label: string | null;
  href: string | null;
}

const ATTR = (name: string) => new RegExp(`${name}="((?:[^"\\\\]|\\\\.)*)"`);

/** The chain's elements, innermost first. An element posthog-js wrote oddly is skipped. */
export function chainOf(chain: string): ChainElement[] {
  return chain
    .split(";")
    .map((part) => {
      const tag = /^([a-zA-Z][\w-]*)/.exec(part)?.[1]?.toLowerCase();
      if (tag === undefined) return null;
      const read = (name: string) => ATTR(name).exec(part)?.[1]?.trim() || null;
      return {
        tag,
        text: read("text"),
        label: read("attr__aria-label") ?? read("attr__title") ?? read("attr__alt"),
        href: read("attr__href"),
      };
    })
    .filter((element): element is ChainElement => element !== null);
}

const KIND_OF_TAG: Record<string, string> = {
  a: "a link",
  button: "a button",
  summary: "a menu",
  input: "a field",
  select: "a list",
  textarea: "a field",
  img: "an image",
  label: "a label",
};

/** What a click hit: the nearest named element within four steps out, else its kind. */
function target(chain: ChainElement[]): string {
  for (const element of chain.slice(0, 4)) {
    const name = element.text ?? element.label;
    if (name !== null) return `'${name.length > 40 ? `${name.slice(0, 39)}…` : name}'`;
  }
  const kind = chain.slice(0, 4).find((element) => element.tag in KIND_OF_TAG);
  if (kind?.href) return `a link to ${kind.href}`;
  return KIND_OF_TAG[kind?.tag ?? ""] ?? "the page";
}

/** Events that only help the SDK, left out of the list and the timeline. */
const HIDDEN = new Set([
  "$feature_flag_called",
  "$web_vitals",
  "$set",
  "$groupidentify",
  "$identify",
  "$opt_in",
]);

export type EventKind = "page" | "click" | "problem" | "other";

export interface EventLabel {
  label: string;
  kind: EventKind;
}

const pathOf = (properties: Record<string, unknown>) => {
  const path = properties["$pathname"];
  if (typeof path === "string" && path !== "") return path;
  const url = properties["$current_url"];
  if (typeof url === "string") {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  }
  return "a page";
};

/** An event in plain words, or null when it only helps the SDK. Pure. */
export function labelOf(row: {
  event: string;
  properties: Record<string, unknown>;
}): EventLabel | null {
  const { event, properties } = row;
  if (HIDDEN.has(event)) return null;
  const chain =
    typeof properties["$elements_chain"] === "string" ? chainOf(properties["$elements_chain"]) : [];
  switch (event) {
    case "$pageview":
      return { label: `Opened ${pathOf(properties)}`, kind: "page" };
    case "$pageleave":
      return { label: `Left ${pathOf(properties)}`, kind: "other" };
    case "$rageclick":
      return { label: `Rage-clicked ${target(chain)}`, kind: "problem" };
    case "$dead_click":
      return { label: `Clicked ${target(chain)}, nothing happened`, kind: "problem" };
    case "$autocapture": {
      const type = properties["$event_type"];
      if (type === "change") return { label: "Changed a field", kind: "other" };
      if (type === "submit") return { label: "Submitted a form", kind: "click" };
      return { label: `Clicked ${target(chain)}`, kind: "click" };
    }
    default:
      return { label: event, kind: "other" };
  }
}

/**
 * Every row of a paged answer, newest first, up to `cap` rows (recordings-38).
 * `more` is true when rows were left out. The page reader is passed in, so the
 * caller does the I/O.
 */
export async function readAllPages<R>(
  page: (cursor?: string) => Promise<{ rows: R[]; nextCursor?: string }>,
  cap: number,
): Promise<{ rows: R[]; more: boolean }> {
  const rows: R[] = [];
  let cursor: string | undefined;
  do {
    // Each page needs the cursor the one before it gave.
    // oxlint-disable-next-line no-await-in-loop
    const answer = await page(cursor);
    rows.push(...answer.rows);
    cursor = answer.nextCursor;
  } while (cursor !== undefined && rows.length < cap);
  return { rows: rows.slice(0, cap), more: rows.length > cap || cursor !== undefined };
}
