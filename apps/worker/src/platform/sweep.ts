import {
  ORPHAN_GRACE_MS,
  ORPHAN_SWEEP_KEYS,
  type ProjectSettings,
  PURGE_DELAY_MS,
} from "@cfanalytics/shared";
import { pruneSalts } from "../features/cookieless/index.ts";
import { capDay, counterKeepFrom, pruneCounters, pruneEvents } from "../features/events/index.ts";
import { prunePoints } from "../features/heatmaps/index.ts";
import { prunePersons } from "../features/identity/index.ts";
import { cutoffsOf, type SweepStep, sweepSummary } from "../features/privacy/index.ts";
import { getProject, removeProjectRows } from "../features/projects/index.ts";
import {
  deleteChunkRows,
  deleteObjects,
  deletePrefix,
  expiredRecordings,
  knownKeys,
  orphanKeys,
} from "../features/recordings/index.ts";
import { alarmAfterSweep, NEXT_PASS_MS } from "./alarm.ts";
import type { Env } from "./env.ts";
import type { Logger } from "./log.ts";
import { err, messageOf, ok, type Result } from "./result.ts";
import { holdsRows, readProjectId, wipeRows } from "./schema.ts";

// What a ProjectStore's alarm runs (D-9, D-20; platform-27 to platform-31,
// privacy-01 to privacy-21, privacy-27): the daily sweep of every store, or
// a deleted project's purge. Like ingest.ts, it calls several slices' table
// and R2 functions in one place; each slice still owns its own SQL. Time is
// an argument, so a test can run the alarm at any moment.

export interface SweepOutcome {
  /** Rows, or objects, each step deleted; a step that failed or deleted nothing has 0. */
  deleted: Record<SweepStep, number>;
  /** The steps that failed, in the order they ran, with their messages. */
  failed: { step: SweepStep; message: string }[];
  /** A step reached its limit and left expired rows or orphans for another pass (privacy-27). */
  leftRows: boolean;
  /** No table but store_meta holds a row, and no object is under the project's prefix (platform-28). */
  empty: boolean;
}

/**
 * One pass of the daily sweep, its steps in SWEEP_ORDER, with the project's
 * cutoffsOf(settings, now) (privacy). Each step that writes runs in its own
 * transactionSync; a step that throws or fails is recorded with its message,
 * its writes rolled back, and the next step still runs (platform-30). A step
 * deletes at most `batchRows` rows, or chunks, and when it reaches that it
 * sets leftRows; a later pass deletes the rest and never a row twice
 * (privacy-27). The store's database size is never read, so a full store is
 * swept too (events-12).
 * - recordings: expiredRecordings at the recordings cutoff; their objects
 *   with deleteObjects first, then deleteChunkRows of the keys deleted, so a
 *   failed delete keeps its chunk's row and its recording's row, and the step
 *   fails naming how many keys failed (privacy-12, privacy-13). Counts the
 *   recording and chunk rows deleted.
 * - orphan objects: orphanKeys under the project's prefix, unknown to
 *   knownKeys, uploaded before now - ORPHAN_GRACE_MS, at most
 *   ORPHAN_SWEEP_KEYS a pass, deleted with deleteObjects; `more` sets
 *   leftRows (recordings-06, recordings-17). Counts the objects deleted.
 * - heatmap points: prunePoints at the heatmap cutoff (privacy-14).
 * - events: pruneEvents at the events cutoff, by event time (privacy-01,
 *   privacy-06, privacy-07).
 * - persons: prunePersons, after the events and recordings above, so a
 *   person whose last event expired goes in the same pass (privacy-04,
 *   privacy-08). Counts people.
 * - salts: pruneSalts at now, its sessions with it (cookieless-04,
 *   privacy-11). Counts salts and sessions together.
 * - counters: pruneCounters from counterKeepFrom(capDay(now,
 *   settings.timezone)) (events-09).
 * Then `empty`, read after the steps.
 */
export async function sweep(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  projectId: string,
  settings: Pick<
    ProjectSettings,
    "events_retention_days" | "recordings_retention_days" | "heatmaps_retention_days" | "timezone"
  >,
  now: number,
  batchRows: number,
): Promise<SweepOutcome> {
  const sql = storage.sql;
  const cutoffs = cutoffsOf(settings, now);
  const deleted: Record<SweepStep, number> = {
    recordings: 0,
    "orphan objects": 0,
    "heatmap points": 0,
    events: 0,
    persons: 0,
    salts: 0,
    counters: 0,
  };
  const failed: { step: SweepStep; message: string }[] = [];
  let leftRows = false;

  /** Runs one writing step in its own transaction; a throw is rolled back and recorded. */
  const run = (step: SweepStep, work: () => StepAnswer): void => {
    try {
      const answer = storage.transactionSync(work);
      deleted[step] = answer.deleted;
      if (answer.left) leftRows = true;
    } catch (error) {
      failed.push({ step, message: messageOf(error) });
    }
  };

  // The recordings' objects go before their rows, so an object R2 refused
  // keeps the rows that name it, for the next pass (privacy-12, privacy-13).
  try {
    const expired = storage.transactionSync(() =>
      expiredRecordings(sql, cutoffs.recordings, batchRows),
    );
    const keys = expired.flatMap((recording) => recording.objectKeys);
    const objects = await deleteObjects(bucket, keys);
    const missing = new Set(objects.failed);
    const rows = storage.transactionSync(() => {
      const answer = deleteChunkRows(
        sql,
        keys.filter((key) => !missing.has(key)),
      );
      return { ...answer, left: expiredRecordings(sql, cutoffs.recordings, 1).length > 0 };
    });
    deleted.recordings = rows.chunks + rows.recordings;
    if (rows.left) leftRows = true;
    if (objects.failed.length > 0) {
      failed.push({ step: "recordings", message: keysRefused(objects.failed.length) });
    }
  } catch (error) {
    failed.push({ step: "recordings", message: messageOf(error) });
  }

  try {
    const found = await orphanKeys(
      bucket,
      projectId,
      now - ORPHAN_GRACE_MS,
      (keys) => knownKeys(sql, keys),
      ORPHAN_SWEEP_KEYS,
    );
    const objects = await deleteObjects(bucket, found.keys);
    deleted["orphan objects"] = objects.deleted;
    if (found.more) leftRows = true;
    if (objects.failed.length > 0) {
      failed.push({ step: "orphan objects", message: keysRefused(objects.failed.length) });
    }
  } catch (error) {
    failed.push({ step: "orphan objects", message: messageOf(error) });
  }

  run("heatmap points", () =>
    capped(prunePoints(sql, cutoffs.heatmapPoints, batchRows), batchRows),
  );
  run("events", () => capped(pruneEvents(sql, cutoffs.events, batchRows), batchRows));
  run("persons", () => capped(prunePersons(sql, batchRows).persons, batchRows));
  run("salts", () => {
    const { salts, sessions } = pruneSalts(sql, now);
    return { deleted: salts + sessions, left: false };
  });
  run("counters", () => ({
    deleted: pruneCounters(sql, counterKeepFrom(capDay(now, settings.timezone))),
    left: false,
  }));

  return { deleted, failed, leftRows, empty: await storeIsEmpty(sql, bucket, projectId) };
}

/** One step's answer: the rows it deleted and whether it left a full batch behind. */
interface StepAnswer {
  deleted: number;
  left: boolean;
}

/** A prune's count with leftRows' rule: a step at its limit may have left more (privacy-27). */
function capped(deleted: number, batchRows: number): StepAnswer {
  return { deleted, left: deleted >= batchRows };
}

/** The failure message of objects R2 refused to delete, naming how many (privacy-13). */
function keysRefused(count: number): string {
  return `the recordings bucket failed to delete ${count} ${count === 1 ? "key" : "keys"}`;
}

/**
 * Whether the store holds nothing left to sweep (platform-28): no row in any
 * table but store_meta, and no object under the project's prefix. Read after
 * the steps, so a pass that emptied the store drops the alarm.
 */
async function storeIsEmpty(
  sql: SqlStorage,
  bucket: R2Bucket,
  projectId: string,
): Promise<boolean> {
  if (holdsRows(sql)) return false;
  const listing = await bucket.list({ prefix: `${projectId}/`, limit: 1 });
  return listing.objects.length === 0;
}

/** Why a purge pass stopped. Nothing after the failed step ran. */
export type PurgeError = { kind: "r2 failed" } | { kind: "registry failed"; message: string };

/**
 * One pass of a deleted project's purge, in the order privacy-03 names, and
 * resumable: a pass that stops is run again and deletes nothing twice
 * (privacy-21).
 * 1. deletePrefix of the project's R2 objects, at most `maxKeys`. When
 *    objects are left, answer { finished: false } and touch nothing else.
 * 2. Wipe the store: in one transactionSync, every row of every table but
 *    store_meta, which keeps the project id for a pass that must resume.
 * 3. removeProjectRows (projects): the project's secret keys and its row.
 * 4. deleteAlarm, then deleteAll, so the object holds no data at all
 *    (privacy-03). Answer { finished: true }.
 */
export async function purge(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  registry: D1Database,
  projectId: string,
  maxKeys: number,
): Promise<Result<{ finished: boolean }, PurgeError>> {
  const sql = storage.sql;
  const objects = await deletePrefix(bucket, projectId, maxKeys);
  if (!objects.ok) return err({ kind: "r2 failed" });
  if (objects.value.more) return ok({ finished: false });

  storage.transactionSync(() => wipeRows(sql));

  const removed = await removeProjectRows(registry, projectId);
  if (!removed.ok) return err({ kind: "registry failed", message: removed.error.message });

  await storage.deleteAlarm();
  await storage.deleteAll();
  return ok({ finished: true });
}

/** What an alarm did. */
export type AlarmOutcome =
  /** The store never recorded a project id, so it holds no data; the alarm is dropped. */
  | { kind: "nothing stored" }
  /** The project is marked deleted and its purge waits until `at`, where the alarm now is (privacy-20). */
  | { kind: "purge waits"; at: number }
  | { kind: "purged"; finished: boolean }
  /** `next` is the alarm now set, or null when it was dropped (platform-27, platform-28). */
  | { kind: "swept"; outcome: SweepOutcome; next: number | null };

/** Why an alarm failed. The ProjectStore throws it on, so Cloudflare's alarm retry runs it again (platform-30, D-22). */
export type AlarmFailure =
  | { kind: "registry unavailable"; message: string }
  | { kind: "purge failed"; error: PurgeError }
  | { kind: "sweep failed"; failed: { step: SweepStep; message: string }[] };

/**
 * The alarm's work at `now`, with `batchRows` as sweep's and purge's limit
 * (SWEEP_BATCH_ROWS in the ProjectStore):
 * 1. readProjectId (schema.ts). None: deleteAlarm, "nothing stored".
 * 2. getProject (projects) from bindings.REGISTRY, so the settings are read
 *    fresh and never copied into the store (platform-19, privacy-07). A
 *    failure sets the alarm to now + NEXT_PASS_MS and is "registry
 *    unavailable".
 * 3. A project marked deleted, or with no row left: its purge starts at
 *    deletedAt + PURGE_DELAY_MS, or at once with no row. Before then, set
 *    the alarm to that time and answer "purge waits", deleting nothing
 *    (privacy-20). Else purge: finished needs no alarm; a pass not finished,
 *    or failed, sets the alarm to now + NEXT_PASS_MS (privacy-21).
 * 4. Else sweep, then one log.info("sweep", sweepSummary(deleted, failed))
 *    line with no row content (platform-29), then alarmAfterSweep: null
 *    drops the alarm, else it is set (platform-27, platform-28). With failed
 *    steps the answer is "sweep failed", after the alarm is set. An alarm
 *    run again at once deletes nothing and does not fail (platform-31).
 */
export async function runAlarm(
  storage: DurableObjectStorage,
  bindings: Pick<Env, "REGISTRY" | "RECORDINGS">,
  now: number,
  log: Logger,
  batchRows: number,
): Promise<Result<AlarmOutcome, AlarmFailure>> {
  const projectId = readProjectId(storage.sql);
  if (projectId === null) {
    await storage.deleteAlarm();
    return ok({ kind: "nothing stored" });
  }

  const project = await getProject(bindings.REGISTRY, projectId);
  if (!project.ok) {
    await storage.setAlarm(now + NEXT_PASS_MS);
    return err({ kind: "registry unavailable", message: project.error.message });
  }
  const stored = project.value;
  // A project marked deleted, or one with no row left, purges: at once with
  // no row, else at its mark plus the purge delay (privacy-20).
  const mark = stored === null ? null : stored.deletedAt;
  if (stored === null || mark !== null) {
    const at = mark === null ? now : mark + PURGE_DELAY_MS;
    if (now < at) {
      await storage.setAlarm(at);
      return ok({ kind: "purge waits", at });
    }
    const purged = await purge(
      storage,
      bindings.RECORDINGS,
      bindings.REGISTRY,
      projectId,
      batchRows,
    );
    if (!purged.ok) {
      await storage.setAlarm(now + NEXT_PASS_MS);
      return err({ kind: "purge failed", error: purged.error });
    }
    if (!purged.value.finished) await storage.setAlarm(now + NEXT_PASS_MS);
    return ok({ kind: "purged", finished: purged.value.finished });
  }

  const outcome = await sweep(
    storage,
    bindings.RECORDINGS,
    projectId,
    stored.settings,
    now,
    batchRows,
  );
  log.info("sweep", sweepSummary(outcome.deleted, outcome.failed));
  const next = alarmAfterSweep(now, outcome);
  if (next === null) await storage.deleteAlarm();
  else await storage.setAlarm(next);
  if (outcome.failed.length > 0) return err({ kind: "sweep failed", failed: outcome.failed });
  return ok({ kind: "swept", outcome, next });
}
