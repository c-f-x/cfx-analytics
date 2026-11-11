import type { JsonObject } from "@cfanalytics/shared";

// Person properties and merges (D-20; identity-01 to identity-19;
// posthog-protocol.md §4). Event time decides, never arrival order. Pure.

/** Per property: the event time its value came from, and whether $set_once wrote it. */
export type PropertyTimes = Record<string, { ts: number; once: boolean }>;

export interface PersonState {
  properties: JsonObject;
  times: PropertyTimes;
}

/**
 * Applies one event's person operations at its event time `ts`, in this
 * order, and answers the new state; `state` is not changed:
 * 1. $set writes a key unless its stored value came from a $set at a later
 *    event time; a tie goes to this event (identity-05, identity-10).
 * 2. $set_once writes a key that has no value, or whose value came from a
 *    $set_once at a later event time; it never replaces a $set value
 *    (identity-07, identity-10).
 * 3. $unset removes a key whose value came from an event time at or before
 *    `ts`; a value from a later event stays (identity-08).
 * Each written key's time is {ts, once} for the operation that wrote it.
 */
export function applyPersonOps(
  state: PersonState,
  ops: { set: Readonly<JsonObject>; setOnce: Readonly<JsonObject>; unset: readonly string[] },
  ts: number,
): PersonState {
  const properties: JsonObject = { ...state.properties };
  const times: PropertyTimes = { ...state.times };

  for (const [key, value] of Object.entries(ops.set)) {
    const stored = times[key];
    if (stored !== undefined && !stored.once && stored.ts > ts) continue;
    properties[key] = value;
    times[key] = { ts, once: false };
  }

  for (const [key, value] of Object.entries(ops.setOnce)) {
    const stored = times[key];
    if (stored !== undefined && (!stored.once || stored.ts <= ts)) continue;
    properties[key] = value;
    times[key] = { ts, once: true };
  }

  for (const key of ops.unset) {
    const stored = times[key];
    if (stored === undefined || stored.ts > ts) continue;
    delete properties[key];
    delete times[key];
  }

  return { properties, times };
}

/**
 * Two people's states merged as if every operation had been applied to one
 * person, by the rules of applyPersonOps: for a key both hold, a $set value
 * beats a $set_once value, the later of two $set values wins (a tie goes to
 * `into`), and the earlier of two $set_once values wins (identity-01,
 * identity-12).
 */
export function mergeStates(into: PersonState, from: PersonState): PersonState {
  const properties: JsonObject = { ...into.properties };
  const times: PropertyTimes = { ...into.times };

  for (const [key, fromTime] of Object.entries(from.times)) {
    const intoTime = times[key];
    if (intoTime !== undefined && !fromWins(intoTime, fromTime)) continue;
    properties[key] = from.properties[key] ?? null;
    times[key] = fromTime;
  }

  return { properties, times };
}

/**
 * Whether a value from the other person takes the key: a $set beats a
 * $set_once, the later $set wins, the earlier $set_once wins, and a tie stays
 * with the value already held.
 */
function fromWins(
  into: { ts: number; once: boolean },
  from: { ts: number; once: boolean },
): boolean {
  if (into.once !== from.once) return into.once;
  return into.once ? from.ts < into.ts : from.ts > into.ts;
}

/** A distinct id as linkPlan sees it: the person it belongs to, if any, and whether that person is identified. */
export interface IdSide {
  distinctId: string;
  personId: number | null;
  identified: boolean;
}

export type LinkPlan =
  /** Both ids already belong to one person, or they are the same id. */
  | { kind: "none" }
  /** Neither id has a person: one new identified person gets both. */
  | { kind: "new person" }
  /** `distinctId` has no person and joins `personId`, which becomes identified. */
  | { kind: "attach"; distinctId: string; personId: number }
  /** Person `from` joins person `into`: its ids, properties (mergeStates) and rows. `into` becomes identified. */
  | { kind: "merge"; from: number; into: number }
  /** Two identified people, or an identified person the target may not take: nothing is linked. */
  | { kind: "keep apart" };

/**
 * What an $identify or $create_alias does (identity-01, identity-11 to
 * identity-14). `target` is the id that stays: the distinct id of an
 * $identify, or the distinct id an alias is made for. `other` is the id that
 * joins it: $anon_distinct_id, or the alias.
 * - Same id, or both on one person: none (identity-12).
 * - Neither has a person: new person.
 * - Only the target has a person: attach other to it.
 * - Only other has a person: attach the target to it, unless that person is
 *   identified, then keep apart (identity-14).
 * - Both have people: merge other's into the target's when other's is not
 *   identified; else merge the target's into other's when the target's is
 *   not identified; else keep apart (identity-14, D-20).
 */
export function linkPlan(target: IdSide, other: IdSide): LinkPlan {
  if (target.distinctId === other.distinctId) return { kind: "none" };
  if (target.personId !== null && target.personId === other.personId) return { kind: "none" };

  if (target.personId !== null && other.personId === null) {
    return { kind: "attach", distinctId: other.distinctId, personId: target.personId };
  }
  if (target.personId === null && other.personId !== null) {
    if (other.identified) return { kind: "keep apart" };
    return { kind: "attach", distinctId: target.distinctId, personId: other.personId };
  }
  if (target.personId === null || other.personId === null) return { kind: "new person" };

  if (!other.identified) return { kind: "merge", from: other.personId, into: target.personId };
  if (!target.identified) return { kind: "merge", from: target.personId, into: other.personId };
  return { kind: "keep apart" };
}
