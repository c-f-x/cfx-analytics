import type { ErasedCounts, ProjectSettings } from "@cfanalytics/shared";
import { retentionStart } from "../intake/index.ts";

// Data lifetimes, deletions and the purge's plan (D-9, D-20; privacy-01 to
// privacy-27; data-model.md, "Lifetimes"). Pure: the clock
// is an argument.

/** The times before which each store's rows have expired. */
export interface Cutoffs {
  /** Events with ts before this go (privacy-01, privacy-06). */
  events: number;
  /** Recordings whose end_ts, their newest chunk's end, is before this go (privacy-12). */
  recordings: number;
  /** Heatmap points with ts before this go (privacy-14). */
  heatmapPoints: number;
}

/**
 * The cutoffs at `now`: intake's retentionStart of now and each retention,
 * so the sweep deletes what intake drops and a query clips (D-20). They read
 * the settings of this sweep, so a lowered retention applies at the next one
 * (privacy-07).
 */
export function cutoffsOf(
  settings: Pick<
    ProjectSettings,
    "events_retention_days" | "recordings_retention_days" | "heatmaps_retention_days"
  >,
  now: number,
): Cutoffs {
  return {
    events: retentionStart(now, settings.events_retention_days),
    recordings: retentionStart(now, settings.recordings_retention_days),
    heatmapPoints: retentionStart(now, settings.heatmaps_retention_days),
  };
}

/**
 * The fixed order the daily sweep runs its steps in (platform-29).
 * Recordings go before people, so a person whose last recording expires is
 * pruned in the same sweep; their R2 objects go before their rows.
 */
export const SWEEP_ORDER = [
  "recordings",
  "orphan objects",
  "heatmap points",
  "events",
  "persons",
  "salts",
  "counters",
] as const;
export type SweepStep = (typeof SWEEP_ORDER)[number];

/**
 * The fields of a sweep's one log line (platform-29, platform-30): `deleted`,
 * the count per step in SWEEP_ORDER, 0 for a step that deleted nothing or
 * failed; and `failed`, each failed step's name and message, in the order
 * they ran. It holds no row content, no distinct id and no object key.
 */
export function sweepSummary(
  deleted: Partial<Record<SweepStep, number>>,
  failed: readonly { step: SweepStep; message: string }[],
): { deleted: Record<SweepStep, number>; failed: { step: SweepStep; message: string }[] } {
  return {
    deleted: {
      recordings: deleted.recordings ?? 0,
      "orphan objects": deleted["orphan objects"] ?? 0,
      "heatmap points": deleted["heatmap points"] ?? 0,
      events: deleted.events ?? 0,
      persons: deleted.persons ?? 0,
      salts: deleted.salts ?? 0,
      counters: deleted.counters ?? 0,
    },
    failed: failed.map(({ step, message }) => ({ step, message })),
  };
}

/** One step of deleting a project, and how to undo it. */
export interface PlanStep {
  does: string;
  /** How to undo it; once data is gone, that only Cloudflare's 30-day point-in-time recovery restores the store, and nothing restores R2 objects. */
  undo: string;
}

/**
 * The steps of deleting a project, in the order they run, for the dry run
 * that prints them and changes nothing (platform-33): mark the project
 * deleted (its token and keys are refused within REGISTRY_CACHE_MS); ask
 * for the purge, which waits PURGE_DELAY_MS after the mark; delete its R2
 * prefix "<id>/"; wipe its ProjectStore; remove its D1 rows (privacy-03,
 * privacy-20). Each names the project by id and name.
 */
export function deletePlan(project: { id: string; name: string }): PlanStep[] {
  const named = `project "${project.name}" (${project.id})`;
  return [
    {
      does: `Mark ${named} deleted, so its token and secret keys are refused within a minute.`,
      undo: `Mark ${named} live again; nothing else has changed yet.`,
    },
    {
      does: `Ask for the purge of ${named}, which starts one minute after the mark.`,
      undo: `Cancel the purge before its alarm runs; the mark alone deletes nothing.`,
    },
    {
      does: `Delete every R2 object under the prefix "${project.id}/" of ${named}.`,
      undo: `Nothing restores an R2 object once it is deleted.`,
    },
    {
      does: `Wipe the ProjectStore of ${named}, every table but its own record.`,
      undo: `Only Cloudflare's 30-day point-in-time recovery restores a wiped store.`,
    },
    {
      does: `Remove the D1 registry rows of ${named}, its secret keys and its project row.`,
      undo: `Only a backup of the registry restores a removed project row.`,
    },
  ];
}

/** What a deletion by person came to, as the route sees it. */
export type EraseOutcome =
  | { kind: "erased"; counts: ErasedCounts }
  | { kind: "r2 failed" }
  | { kind: "unavailable" };

/**
 * The status and JSON body of a deletion by person (privacy-02, privacy-17,
 * privacy-19): erased is 200 with {counts}, zeros included; "r2 failed" is
 * 502 with ApiError code "delete_failed" and a sentence saying nothing was
 * deleted and a repeat finishes the work; "unavailable" is 503 with code
 * "unavailable". No body holds the distinct id or an object key (privacy-18).
 */
export function eraseAnswer(outcome: EraseOutcome): { status: 200 | 502 | 503; body: unknown } {
  if (outcome.kind === "erased") return { status: 200, body: { counts: outcome.counts } };
  if (outcome.kind === "r2 failed") {
    return {
      status: 502,
      body: {
        code: "delete_failed",
        message:
          "Nothing was deleted: the recordings bucket refused a delete. Repeat the request to finish the work.",
      },
    };
  }
  return {
    status: 503,
    body: {
      code: "unavailable",
      message: "The deletion could not run now. Repeat the request.",
    },
  };
}

/**
 * The recordings bucket's lifecycle rules (operations.md, Cloudflare
 * resources), as the deploy applies them: every object is deleted 400 days
 * after upload. recordings_retention_days is at most 365, so the rule is only
 * a backstop for objects the sweep missed (privacy-15).
 */
export const RECORDINGS_LIFECYCLE = [{ id: "backstop", prefix: "", deleteAfterDays: 400 }] as const;
