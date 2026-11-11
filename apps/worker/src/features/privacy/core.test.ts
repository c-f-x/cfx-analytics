import { DEFAULT_SETTINGS, type ErasedCounts, projectSettings } from "@cfanalytics/shared";
import { expect, it } from "vitest";
import { asRecord } from "../../../test/helpers/json.ts";
import {
  deletePlan,
  eraseAnswer,
  RECORDINGS_LIFECYCLE,
  SWEEP_ORDER,
  sweepSummary,
} from "./core.ts";

// The privacy slice's pure answers (privacy-15, privacy-17, privacy-19,
// platform-29, platform-33): the bucket's backstop rule, the deletion by
// person's answer, the sweep's summary and the delete plan. No storage.

/** The counts of a deletion that found nothing, zeros included (privacy-17). */
function zeros(): ErasedCounts {
  return {
    events: 0,
    persons: 0,
    person_distinct_ids: 0,
    recordings: 0,
    recording_chunks: 0,
    heatmap_points: 0,
    objects: 0,
  };
}

/** A sweep's counts with nothing deleted, one key per step in SWEEP_ORDER (platform-29). */
function noDeletes(): Record<(typeof SWEEP_ORDER)[number], number> {
  return {
    recordings: 0,
    "orphan objects": 0,
    "heatmap points": 0,
    events: 0,
    persons: 0,
    salts: 0,
    counters: 0,
  };
}

it("privacy-15 · the bucket's backstop deletes at 400 days, past the longest retention a project may keep", () => {
  expect(RECORDINGS_LIFECYCLE).toEqual([{ id: "backstop", prefix: "", deleteAfterDays: 400 }]);
  const longest = { ...DEFAULT_SETTINGS, recordings_retention_days: 365 };
  expect(projectSettings.safeParse(longest).success).toBe(true);
  expect(projectSettings.safeParse({ ...longest, recordings_retention_days: 366 }).success).toBe(
    false,
  );
  expect(RECORDINGS_LIFECYCLE[0].deleteAfterDays).toBeGreaterThan(365);
});

it("privacy-17 · an erased deletion answers 200 with a count per table, zeros included", () => {
  const counts = zeros();
  expect(eraseAnswer({ kind: "erased", counts })).toEqual({ status: 200, body: { counts } });
  const counted = { ...zeros(), events: 4, persons: 1 };
  expect(eraseAnswer({ kind: "erased", counts: counted })).toEqual({
    status: 200,
    body: { counts: counted },
  });
});

it("privacy-19 · a failed object delete answers 502 delete_failed, and a repeat finishes the work", () => {
  const answer = eraseAnswer({ kind: "r2 failed" });
  expect(answer.status).toBe(502);
  const body = asRecord(answer.body);
  expect(body.code).toBe("delete_failed");
  expect(body.message).toMatch(/nothing was deleted/i);
  expect(body.message).toMatch(/repeat|again/i);
});

it("platform-29 · the sweep summary holds every step's count in order and the failed steps' messages", () => {
  const summary = sweepSummary({ events: 3 }, [
    { step: "persons", message: "no such table: persons" },
  ]);
  expect(Object.keys(summary.deleted)).toEqual([...SWEEP_ORDER]);
  expect(summary.deleted).toEqual({ ...noDeletes(), events: 3 });
  expect(summary.failed).toEqual([{ step: "persons", message: "no such table: persons" }]);
});

it("platform-33 · the delete plan names each step, its project and how to undo it, in the order they run", () => {
  const project = { id: "p_plan33", name: "Backlog" };
  const plan = deletePlan(project);
  expect(plan).toHaveLength(5);
  for (const step of plan) {
    expect(step.does).toContain(project.id);
    expect(step.does).toContain(project.name);
    expect(step.undo.length).toBeGreaterThan(0);
  }
  const does = plan.map((step) => step.does);
  expect(does[0]).toMatch(/mark|delet/i);
  expect(does[1]).toMatch(/purge/i);
  expect(does[2]).toMatch(/R2|prefix/i);
  expect(does[3]).toMatch(/store/i);
  expect(does[4]).toMatch(/D1|registry|rows/i);
});
