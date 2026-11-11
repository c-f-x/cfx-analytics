import { describe, expect, it } from "vitest";
import { HOUR_MS, T0 } from "../../../test/helpers/capture.ts";
import { applyPersonOps, linkPlan, mergeStates, type PersonState } from "./core.ts";

// The identity slice's pure rules (D-20; identity-01, identity-05, identity-07,
// identity-08, identity-10, identity-12, identity-14). Every event time,
// property and id arrives as a value, so no arrival order decides a result.

const EMPTY: PersonState = { properties: {}, times: {} };

const state = (
  properties: PersonState["properties"],
  times: PersonState["times"],
): PersonState => ({
  properties,
  times,
});

describe("linking two ids", () => {
  it("identity-01 · linkPlan gives two ids with no person one new person", () => {
    expect(
      linkPlan(
        { distinctId: "user-1", personId: null, identified: false },
        { distinctId: "anon-1", personId: null, identified: false },
      ),
    ).toEqual({ kind: "new person" });
  });

  it("identity-01 · linkPlan attaches the other id to the person the target has", () => {
    expect(
      linkPlan(
        { distinctId: "user-1", personId: 1, identified: true },
        { distinctId: "anon-1", personId: null, identified: false },
      ),
    ).toEqual({ kind: "attach", distinctId: "anon-1", personId: 1 });
  });

  it("identity-12 · linkPlan of equal ids, or ids on one person, changes nothing", () => {
    expect(
      linkPlan(
        { distinctId: "same", personId: null, identified: false },
        { distinctId: "same", personId: null, identified: false },
      ),
    ).toEqual({ kind: "none" });
    expect(
      linkPlan(
        { distinctId: "a", personId: 7, identified: true },
        { distinctId: "b", personId: 7, identified: true },
      ),
    ).toEqual({ kind: "none" });
  });

  it("identity-14 · linkPlan keeps two identified people apart", () => {
    expect(
      linkPlan(
        { distinctId: "user-1", personId: 1, identified: true },
        { distinctId: "user-2", personId: 2, identified: true },
      ),
    ).toEqual({ kind: "keep apart" });
  });

  it("identity-14 · linkPlan merges the person that is not identified", () => {
    expect(
      linkPlan(
        { distinctId: "user-1", personId: 1, identified: true },
        { distinctId: "anon-1", personId: 2, identified: false },
      ),
    ).toEqual({ kind: "merge", from: 2, into: 1 });
    expect(
      linkPlan(
        { distinctId: "anon-1", personId: 2, identified: false },
        { distinctId: "user-1", personId: 1, identified: true },
      ),
    ).toEqual({ kind: "merge", from: 2, into: 1 });
  });

  it("identity-14 · linkPlan keeps a new id apart from another's identified person", () => {
    expect(
      linkPlan(
        { distinctId: "user-1", personId: null, identified: false },
        { distinctId: "user-2", personId: 2, identified: true },
      ),
    ).toEqual({ kind: "keep apart" });
  });
});

describe("merging two people's properties", () => {
  it("identity-01 · mergeStates joins both sets, the later $set winning a shared key", () => {
    const into = state({ plan: "free" }, { plan: { ts: T0, once: false } });
    const from = state(
      { plan: "team", country: "NO" },
      { plan: { ts: T0 + HOUR_MS, once: false }, country: { ts: T0, once: true } },
    );
    expect(mergeStates(into, from)).toEqual({
      properties: { plan: "team", country: "NO" },
      times: { plan: { ts: T0 + HOUR_MS, once: false }, country: { ts: T0, once: true } },
    });
  });

  it("identity-01 · mergeStates keeps a $set value over a $set_once value, either way round", () => {
    const setAfter = mergeStates(
      state({ plan: "team" }, { plan: { ts: T0 + HOUR_MS, once: false } }),
      state({ plan: "free" }, { plan: { ts: T0, once: true } }),
    );
    expect(setAfter.properties).toEqual({ plan: "team" });
    expect(setAfter.times).toEqual({ plan: { ts: T0 + HOUR_MS, once: false } });

    const onceAfter = mergeStates(
      state({ plan: "free" }, { plan: { ts: T0, once: true } }),
      state({ plan: "team" }, { plan: { ts: T0 + HOUR_MS, once: false } }),
    );
    expect(onceAfter.properties).toEqual({ plan: "team" });
    expect(onceAfter.times).toEqual({ plan: { ts: T0 + HOUR_MS, once: false } });
  });

  it("identity-01 · mergeStates gives a $set tie to the person merged into", () => {
    const merged = mergeStates(
      state({ plan: "free" }, { plan: { ts: T0, once: false } }),
      state({ plan: "team" }, { plan: { ts: T0, once: false } }),
    );
    expect(merged.properties).toEqual({ plan: "free" });
  });
});

describe("applying one event's person operations", () => {
  it("identity-05 · $set keeps the value from the later event, whatever its arrival", () => {
    const first = applyPersonOps(EMPTY, { set: { plan: "free" }, setOnce: {}, unset: [] }, T0);
    const later = applyPersonOps(
      first,
      { set: { plan: "team" }, setOnce: {}, unset: [] },
      T0 + HOUR_MS,
    );
    expect(later.properties).toEqual({ plan: "team" });
    expect(later.times).toEqual({ plan: { ts: T0 + HOUR_MS, once: false } });

    const olderArrivesLast = applyPersonOps(
      later,
      { set: { plan: "free" }, setOnce: {}, unset: [] },
      T0,
    );
    expect(olderArrivesLast.properties).toEqual({ plan: "team" });
    expect(olderArrivesLast.times).toEqual({ plan: { ts: T0 + HOUR_MS, once: false } });
    expect(EMPTY.properties).toEqual({});
  });

  it("identity-05 · a $set at the same event time replaces the stored value", () => {
    const stored = applyPersonOps(EMPTY, { set: { plan: "free" }, setOnce: {}, unset: [] }, T0);
    const tie = applyPersonOps(stored, { set: { plan: "team" }, setOnce: {}, unset: [] }, T0);
    expect(tie.properties).toEqual({ plan: "team" });
    expect(tie.times).toEqual({ plan: { ts: T0, once: false } });
  });

  it("identity-07 · $set_once keeps the earliest event's value, whatever its arrival", () => {
    const early = applyPersonOps(EMPTY, { set: {}, setOnce: { plan: "free" }, unset: [] }, T0);
    const later = applyPersonOps(
      early,
      { set: {}, setOnce: { plan: "team" }, unset: [] },
      T0 + HOUR_MS,
    );
    expect(later.properties).toEqual({ plan: "free" });
    expect(later.times).toEqual({ plan: { ts: T0, once: true } });

    const laterFirst = applyPersonOps(
      applyPersonOps(EMPTY, { set: {}, setOnce: { plan: "team" }, unset: [] }, T0 + HOUR_MS),
      { set: {}, setOnce: { plan: "free" }, unset: [] },
      T0,
    );
    expect(laterFirst.properties).toEqual({ plan: "free" });
    expect(laterFirst.times).toEqual({ plan: { ts: T0, once: true } });
  });

  it("identity-07 · $set_once never replaces a value a $set wrote", () => {
    const set = applyPersonOps(
      EMPTY,
      { set: { plan: "team" }, setOnce: {}, unset: [] },
      T0 + HOUR_MS,
    );
    const never = applyPersonOps(set, { set: {}, setOnce: { plan: "free" }, unset: [] }, T0);
    expect(never.properties).toEqual({ plan: "team" });
    expect(never.times).toEqual({ plan: { ts: T0 + HOUR_MS, once: false } });
  });

  it("identity-08 · $unset removes a key from an event at or before its time", () => {
    const set = applyPersonOps(
      EMPTY,
      { set: { plan: "pro", beta: true }, setOnce: {}, unset: [] },
      T0,
    );
    const unset = applyPersonOps(set, { set: {}, setOnce: {}, unset: ["plan"] }, T0);
    expect(unset.properties).toEqual({ beta: true });
    expect(unset.times).toEqual({ beta: { ts: T0, once: false } });
  });

  it("identity-08 · $unset leaves a value from a later event", () => {
    const set = applyPersonOps(
      EMPTY,
      { set: { plan: "pro" }, setOnce: {}, unset: [] },
      T0 + HOUR_MS,
    );
    const unset = applyPersonOps(set, { set: {}, setOnce: {}, unset: ["plan"] }, T0);
    expect(unset.properties).toEqual({ plan: "pro" });
  });

  it("identity-10 · an event's $set and $set_once are each applied as its key says", () => {
    const applied = applyPersonOps(
      EMPTY,
      {
        set: { plan: "team", beta: true },
        setOnce: { plan: "free", first_seen: "2026-10-01" },
        unset: [],
      },
      T0,
    );
    expect(applied.properties).toEqual({ plan: "team", beta: true, first_seen: "2026-10-01" });
    expect(applied.times).toEqual({
      plan: { ts: T0, once: false },
      beta: { ts: T0, once: false },
      first_seen: { ts: T0, once: true },
    });
  });
});
